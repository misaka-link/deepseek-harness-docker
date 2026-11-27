#!/usr/bin/env node
/**
 * 单测：gateway/src/dsh/watchdog.js（DshCoreWatchdog）。
 * 用法: node tests/unit/dsh-watchdog.test.mjs
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const watchdogPath = path.join(root, 'gateway/src/dsh/watchdog.js');
const { DshCoreWatchdog } = require(watchdogPath);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };
const flush = () => new Promise((r) => setImmediate(r));
const quietLogger = { log() {}, warn() {}, error() {} };

function makeDM(overrides = {}) {
  const dm = {
    ready: true, installing: false, stopping: false, manualStopped: false, startTime: 1000,
    proc: { exitCode: null, killed: false }, restartCalls: 0,
    getStatus() {
      const running = !!(this.proc && this.proc.exitCode === null && !this.proc.killed);
      return { running, ready: this.ready, manualStopped: this.manualStopped, installing: this.installing, stopping: this.stopping, startTime: this.startTime };
    },
    async restart() { this.restartCalls++; return { ok: true }; }
  };
  return Object.assign(dm, overrides);
}

function makeWD(dm, extra = {}) {
  const fetchState = { mode: 'ok', calls: 0 };
  const fetchImpl = async () => { fetchState.calls++; if (fetchState.mode === 'ok') return { status: fetchState.status || 200 }; throw new Error('probe_timeout'); };
  const fakeTimer = { unref() {} };
  const wd = new DshCoreWatchdog(Object.assign({
    dshManager: dm, port: 3079,
    config: { enabled: true, intervalMs: 1000, probeTimeoutMs: 100, failThreshold: 3, maxRestarts: 2, restartWindowMs: 60000 },
    fetch: fetchImpl, setInterval: () => fakeTimer, clearInterval: () => {}, logger: quietLogger
  }, extra));
  return { wd, fetchState };
}

{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  ok((await wd.runOnce()) === true && fetchState.calls === 1 && wd.getStatus().consecutiveFailures === 0 && dm.restartCalls === 0 && wd.getStatus().lastProbeStatus === 'ok', 'A. 健康探活成功不重启');
  wd.stop();
}
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail'; await wd.runOnce(); await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 2 && dm.restartCalls === 0, 'B1. 偶发 2 次失败不重启');
  fetchState.mode = 'ok'; await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 0 && dm.restartCalls === 0, 'B2. 恢复后失败清零');
  wd.stop();
}
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail';
  await wd.runOnce(); await wd.runOnce(); await wd.runOnce(); await flush();
  ok(dm.restartCalls === 1 && wd.getStatus().recoverCount === 1 && wd.getStatus().consecutiveFailures === 0 && wd.getStatus().lastRestartResult === 'ok', 'C. 连续 3 次失败触发自动重启');
  wd.stop();
}
{
  const dm = makeDM({ manualStopped: true }); const { wd, fetchState } = makeWD(dm); wd.start();
  ok((await wd.runOnce()) === null && fetchState.calls === 0, 'D. 手动停止跳过探活');
  wd.stop();
}
{
  const dm = makeDM({ ready: false }); const { wd, fetchState } = makeWD(dm); wd.start();
  await wd.runOnce();
  ok(fetchState.calls === 0, 'E. 未就绪跳过探活');
  wd.stop();
}
{
  const dm = makeDM({ proc: { exitCode: 1, killed: false } }); const { wd, fetchState } = makeWD(dm); wd.start();
  await wd.runOnce();
  ok(fetchState.calls === 0 && dm.restartCalls === 0, 'F. 进程已退出跳过探活');
  wd.stop();
}
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail';
  for (let c = 0; c < 4; c++) { await wd.runOnce(); await wd.runOnce(); await wd.runOnce(); await flush(); }
  ok(dm.restartCalls === 2 && wd.getStatus().suspended === true && !!wd.getStatus().suspendedReason, 'G. 重启风暴熔断');
  wd.stop();
}
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  wd.pause('version-switch'); await wd.runOnce();
  ok(fetchState.calls === 0 && wd.getStatus().paused === true && wd.getStatus().pausedReason === 'version-switch', 'H1. pause 跳过探活');
  wd.resume(); await wd.runOnce();
  ok(fetchState.calls === 1, 'H2. resume 后恢复探活');
  wd.stop();
}
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm, { config: { enabled: false } });
  wd.start(); await wd.runOnce();
  ok(fetchState.calls === 0 && wd.getStatus().running === false, 'I. disabled 时不探活');
}
{
  const out = execFileSync(process.execPath, ['-e',
    `process.env.DSH_WATCHDOG_FAIL_THRESHOLD='';process.env.DSH_WATCHDOG_TIMEOUT_MS='';process.env.DSH_WATCHDOG_INTERVAL_MS='';const {DEFAULT_CONFIG}=require(${JSON.stringify(watchdogPath)});console.log(JSON.stringify(DEFAULT_CONFIG));`
  ], { encoding: 'utf8' });
  const cfg = JSON.parse(out.trim().split('\n').pop());
  ok(cfg.failThreshold === 3 && cfg.probeTimeoutMs === 4000 && cfg.intervalMs === 15000, 'J. numEnv 空串回退默认值');
}
{
  const dm = makeDM(); dm.restart = async function () { this.restartCalls++; return { ok: false, error: 'boom' }; };
  const { wd, fetchState } = makeWD(dm); wd.start(); fetchState.mode = 'fail';
  await wd.runOnce(); await wd.runOnce(); await wd.runOnce(); await flush();
  ok(dm.restartCalls === 1 && wd.getStatus().lastRestartResult === 'boom' && wd.getStatus().recovering === false, 'K. restart 返回失败不卡死');
  wd.stop();
}
{
  const dm = makeDM(); dm.restart = async function () { this.restartCalls++; throw new Error('crash'); };
  const { wd, fetchState } = makeWD(dm); wd.start(); fetchState.mode = 'fail';
  await wd.runOnce(); await wd.runOnce(); await wd.runOnce(); await flush();
  ok(dm.restartCalls === 1 && /crash/.test(String(wd.getStatus().lastRestartResult)) && wd.getStatus().recovering === false, 'L. restart 抛异常不卡死');
  wd.stop();
}
{
  const dm = makeDM(); dm.getStatus = function () { throw new Error('status_boom'); };
  const { wd, fetchState } = makeWD(dm); wd.start();
  ok((await wd.runOnce()) === null && fetchState.calls === 0, 'M. getStatus 异常容错跳过');
  wd.stop();
}
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  for (const st of [401, 403, 500, 302]) {
    fetchState.status = st; fetchState.mode = 'ok';
    ok((await wd.runOnce()) === true && wd.getStatus().consecutiveFailures === 0, `N. HTTP ${st} 判存活`);
  }
  wd.stop();
}
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm, { config: { enabled: true, intervalMs: 1000, probeTimeoutMs: 100, failThreshold: 3, maxRestarts: 1, restartWindowMs: 60000 } });
  wd.start(); fetchState.mode = 'fail';
  for (let i = 0; i < 3; i++) await wd.runOnce(); await flush();
  for (let i = 0; i < 3; i++) await wd.runOnce(); await flush();
  ok(dm.restartCalls === 1 && wd.getStatus().suspended === true, 'O1. 触发熔断');
  fetchState.mode = 'ok'; await wd.runOnce();
  ok(wd.getStatus().suspended === false && wd.getStatus().restartCountInWindow === 0, 'O2. 恢复探活解除熔断');
  wd.stop();
}
{
  const dm = makeDM(); dm.startTime = 1000; const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail'; await wd.runOnce(); await wd.runOnce();
  dm.startTime = 2000; await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 1, 'P. startTime 变化重置连续失败');
  wd.stop();
}
{
  let fakeNow = 1000000;
  const dm = makeDM();
  const { wd } = makeWD(dm, { now: () => fakeNow, config: { enabled: true, intervalMs: 1000, probeTimeoutMs: 100, failThreshold: 3, maxRestarts: 3, restartWindowMs: 1000 } });
  wd.start();
  wd._restartTimestamps = [fakeNow - 2000];
  ok(wd.getStatus().restartCountInWindow === 0, 'Q1. 过期时间戳不计入');
  wd._restartTimestamps = [fakeNow - 500];
  ok(wd.getStatus().restartCountInWindow === 1, 'Q2. 窗口内时间戳计入');
  wd.stop();
}
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail'; await wd.runOnce(); await wd.runOnce();
  dm.ready = false; await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 0, 'R. 未就绪跳过时清零失败计数');
  wd.stop();
}

console.log('\n[dsh-watchdog] pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
