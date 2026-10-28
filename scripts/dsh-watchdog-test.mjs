/**
 * 单测：gateway/dsh-watchdog.js（DshCoreWatchdog）
 * 纯离线，注入 fetch/定时器/时钟，不触网、不真重启。
 * 用法: node scripts/dsh-watchdog-test.mjs
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { DshCoreWatchdog } = require(path.join(here, '../gateway/dsh-watchdog.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };
const flush = () => new Promise((r) => setImmediate(r));
const quietLogger = { log(){}, warn(){}, error(){} };

function makeDM(overrides = {}) {
  const dm = {
    ready: true,
    installing: false,
    stopping: false,
    manualStopped: false,
    startTime: 1000,
    proc: { exitCode: null, killed: false },
    restartCalls: 0,
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
    dshManager: dm,
    port: 3079,
    config: { enabled: true, intervalMs: 1000, probeTimeoutMs: 100, failThreshold: 3, maxRestarts: 2, restartWindowMs: 60000 },
    fetch: fetchImpl,
    setInterval: () => fakeTimer,
    clearInterval: () => {},
    logger: quietLogger
  }, extra));
  return { wd, fetchState };
}

console.log('\n=== A. 健康：探活成功，不重启 ===');
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  const r = await wd.runOnce();
  ok(r === true, 'runOnce 返回 true');
  ok(fetchState.calls === 1, 'fetch 被调用 1 次');
  ok(wd.getStatus().consecutiveFailures === 0, '连续失败=0');
  ok(dm.restartCalls === 0, '未触发重启');
  ok(wd.getStatus().lastProbeStatus === 'ok', 'lastProbeStatus=ok');
  wd.stop();
}

console.log('\n=== B. 偶发失败（2 次后恢复），不重启 ===');
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail'; await wd.runOnce(); await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 2, '连续失败=2');
  ok(dm.restartCalls === 0, '未达阈值(3) 不重启');
  fetchState.mode = 'ok'; await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 0, '恢复后连续失败清零');
  ok(dm.restartCalls === 0, '仍未重启');
  wd.stop();
}

console.log('\n=== C. 连续 3 次失败 → 触发自动重启 ===');
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail';
  await wd.runOnce(); await wd.runOnce(); await wd.runOnce(); await flush();
  ok(dm.restartCalls === 1, 'restart 被调用 1 次');
  ok(wd.getStatus().recoverCount === 1, 'recoverCount=1');
  ok(wd.getStatus().consecutiveFailures === 0, '重启成功后连续失败清零');
  ok(wd.getStatus().lastRestartResult === 'ok', 'lastRestartResult=ok');
  wd.stop();
}

console.log('\n=== D. 手动停止 → 跳过探活 ===');
{
  const dm = makeDM({ manualStopped: true }); const { wd, fetchState } = makeWD(dm); wd.start();
  const r = await wd.runOnce();
  ok(r === null, 'runOnce 返回 null');
  ok(fetchState.calls === 0, '手动停止时不做探活');
  wd.stop();
}

console.log('\n=== E. 未就绪（启动中）→ 跳过探活 ===');
{
  const dm = makeDM({ ready: false }); const { wd, fetchState } = makeWD(dm); wd.start();
  await wd.runOnce();
  ok(fetchState.calls === 0, '未就绪时不探活');
  wd.stop();
}

console.log('\n=== F. 进程已退出 → 跳过（交给崩溃自愈） ===');
{
  const dm = makeDM({ proc: { exitCode: 1, killed: false } }); const { wd, fetchState } = makeWD(dm); wd.start();
  await wd.runOnce();
  ok(fetchState.calls === 0, '进程退出时不探活');
  ok(dm.restartCalls === 0, '不重复重启');
  wd.stop();
}

console.log('\n=== G. 重启风暴熔断：窗口内最多 maxRestarts(2) 次 ===');
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail';
  for (let cycle = 0; cycle < 4; cycle++) { await wd.runOnce(); await wd.runOnce(); await wd.runOnce(); await flush(); }
  ok(dm.restartCalls === 2, '窗口内实际只重启 2 次（实际 ' + dm.restartCalls + '）');
  ok(wd.getStatus().suspended === true, '触发熔断挂起 suspended=true');
  ok(!!wd.getStatus().suspendedReason, '有挂起原因');
  wd.stop();
}

console.log('\n=== H. pause/resume ===');
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  wd.pause('version-switch');
  await wd.runOnce();
  ok(fetchState.calls === 0, '暂停期间不探活');
  ok(wd.getStatus().paused === true && wd.getStatus().pausedReason === 'version-switch', 'pause 状态正确');
  wd.resume(); await wd.runOnce();
  ok(fetchState.calls === 1, '恢复后正常探活');
  wd.stop();
}

console.log('\n=== I. disabled ===');
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm, { config: { enabled: false } });
  wd.start();
  await wd.runOnce();
  ok(fetchState.calls === 0, '禁用时不探活');
  ok(wd.getStatus().running === false, 'running=false');
}

console.log('\n=== J. numEnv 空字符串回退默认值（高危 Bug 回归） ===');
{
  const out = execFileSync(process.execPath, ['-e',
    "process.env.DSH_WATCHDOG_FAIL_THRESHOLD='';process.env.DSH_WATCHDOG_TIMEOUT_MS='';process.env.DSH_WATCHDOG_INTERVAL_MS='';const {DEFAULT_CONFIG}=require('/workspace/deepseek-harness-docker/gateway/dsh-watchdog.js');console.log(JSON.stringify(DEFAULT_CONFIG));"
  ], { encoding: 'utf8' });
  const cfg = JSON.parse(out.trim().split('\n').pop());
  ok(cfg.failThreshold === 3, '空 FAIL_THRESHOLD 回退 3（实际 ' + cfg.failThreshold + '）');
  ok(cfg.probeTimeoutMs === 4000, '空 TIMEOUT_MS 回退 4000（实际 ' + cfg.probeTimeoutMs + '）');
  ok(cfg.intervalMs === 15000, '空 INTERVAL_MS 回退 15000（实际 ' + cfg.intervalMs + '）');
}

console.log('\n=== K. restart 返回失败：记录且不卡死 ===');
{
  const dm = makeDM(); dm.restart = async function () { this.restartCalls++; return { ok: false, error: 'boom' }; };
  const { wd, fetchState } = makeWD(dm); wd.start(); fetchState.mode = 'fail';
  await wd.runOnce(); await wd.runOnce(); await wd.runOnce(); await flush();
  ok(dm.restartCalls === 1, 'restart 调用 1 次');
  ok(wd.getStatus().lastRestartResult === 'boom', '记录失败原因 boom');
  ok(wd.getStatus().recovering === false, '_recovering 已复位（不卡死）');
  wd.stop();
}

console.log('\n=== L. restart 抛异常：捕获且不卡死 ===');
{
  const dm = makeDM(); dm.restart = async function () { this.restartCalls++; throw new Error('crash'); };
  const { wd, fetchState } = makeWD(dm); wd.start(); fetchState.mode = 'fail';
  await wd.runOnce(); await wd.runOnce(); await wd.runOnce(); await flush();
  ok(dm.restartCalls === 1, 'restart 调用 1 次');
  ok(/crash/.test(String(wd.getStatus().lastRestartResult)), '记录异常信息');
  ok(wd.getStatus().recovering === false, '_recovering 已复位');
  wd.stop();
}

console.log('\n=== M. getStatus 抛异常：容错跳过 ===');
{
  const dm = makeDM(); dm.getStatus = function () { throw new Error('status_boom'); };
  const { wd, fetchState } = makeWD(dm); wd.start();
  const r = await wd.runOnce();
  ok(r === null, 'runOnce 容错返回 null');
  ok(fetchState.calls === 0, 'getStatus 异常时不探活');
  wd.stop();
}

console.log('\n=== N. 401/500/302 视为存活（不误杀） ===');
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  for (const st of [401, 403, 500, 302]) {
    fetchState.status = st; fetchState.mode = 'ok';
    const r = await wd.runOnce();
    ok(r === true && wd.getStatus().consecutiveFailures === 0, 'HTTP ' + st + ' 判存活');
  }
  wd.stop();
}

console.log('\n=== O. 熔断后恢复探活成功 → 解除 suspended ===');
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm, { config: { enabled: true, intervalMs: 1000, probeTimeoutMs: 100, failThreshold: 3, maxRestarts: 1, restartWindowMs: 60000 } });
  wd.start(); fetchState.mode = 'fail';
  for (let i = 0; i < 3; i++) await wd.runOnce(); await flush();          // restart #1
  for (let i = 0; i < 3; i++) await wd.runOnce(); await flush();          // 触发熔断
  ok(dm.restartCalls === 1, '窗口内只重启 1 次');
  ok(wd.getStatus().suspended === true, 'suspended=true');
  fetchState.mode = 'ok'; await wd.runOnce();
  ok(wd.getStatus().suspended === false, '恢复后解除 suspended');
  ok(wd.getStatus().restartCountInWindow === 0, '恢复后窗口计数清零');
  wd.stop();
}

console.log('\n=== P. startTime 变化（核心重启）→ 清零历史失败 ===');
{
  const dm = makeDM(); dm.startTime = 1000; const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail'; await wd.runOnce(); await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 2, '重启前累计 2 次');
  dm.startTime = 2000; await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 1, 'startTime 变化后从 0 重新计（=1）');
  wd.stop();
}

console.log('\n=== Q. 窗口计数动态过期 ===');
{
  let fakeNow = 1000000;
  const dm = makeDM();
  const { wd } = makeWD(dm, { now: () => fakeNow, config: { enabled: true, intervalMs: 1000, probeTimeoutMs: 100, failThreshold: 3, maxRestarts: 3, restartWindowMs: 1000 } });
  wd.start();
  wd._restartTimestamps = [fakeNow - 2000];
  ok(wd.getStatus().restartCountInWindow === 0, '过期时间戳不计入（0）');
  wd._restartTimestamps = [fakeNow - 500];
  ok(wd.getStatus().restartCountInWindow === 1, '窗口内时间戳计入（1）');
  wd.stop();
}

console.log('\n=== R. 未就绪跳过时清零历史失败 ===');
{
  const dm = makeDM(); const { wd, fetchState } = makeWD(dm); wd.start();
  fetchState.mode = 'fail'; await wd.runOnce(); await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 2, '跳过前累计 2 次');
  dm.ready = false; await wd.runOnce();
  ok(wd.getStatus().consecutiveFailures === 0, '未就绪跳过时清零');
  wd.stop();
}

console.log('\n[dsh-watchdog] pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
