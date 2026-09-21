#!/usr/bin/env node
/**
 * 容器浏览器 / 虚拟桌面生命周期回归测试
 *
 * 直接驱动 gateway/desktop-manager.js（单例），覆盖报告与方案中列出的关键场景：
 *   T1 运行中切换分辨率（原死锁场景）
 *   T2 停止后可再次启动
 *   T3 快速 stop -> start 循环
 *   T4 子进程崩溃后 start 自愈
 *   T5 启动失败后重试幂等（无残留 :99）
 *   T6 restart 携带新分辨率
 *   T7 空闲/时长到期自动停止后立即重启
 *   T8 运行时配置（CDP 端口）热更新并生效
 *
 * 用法：
 *   node scripts/desktop-lifecycle-test.mjs            # 全部
 *   node scripts/desktop-lifecycle-test.mjs T1 T3      # 指定用例
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { execSync, spawnSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const dm = require('../gateway/desktop-manager.js');

const DISPLAY = process.env.DISPLAY || ':99';
const DISPLAY_NUM = DISPLAY.replace(/^:/, '').split('.')[0];

let pass = 0, fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { console.log(`   ✔ ${msg}`); }
  else { throw new Error(`断言失败: ${msg}`); }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`超时 ${ms}ms: ${label}`)), ms); })
  ]);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-af', pattern], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function xLockExists() {
  return existsSync(`/tmp/.X${DISPLAY_NUM}-lock`);
}

function countFds() {
  try {
    const pid = process.pid;
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch { return -1; }
}

async function cleanSlate() {
  await withTimeout(dm.stop(), 25000, 'cleanSlate stop').catch(() => {});
  await sleep(1500);
}

const tests = {};

// T1: 运行中切换分辨率 —— 原代码会在此永久死锁
tests.T1 = async () => {
  await cleanSlate();
  const r1 = await withTimeout(dm.start({ width: 1920, height: 1080 }), 40000, 'T1 start 1920x1080');
  ok(r1.ok, `首次启动成功 (${JSON.stringify(r1.status?.width)}x${r1.status?.height})`);

  const r2 = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T1 switch to 1280x720');
  ok(r2.ok, '切换分辨率返回 ok（未死锁）');
  ok(r2.status?.width === 1280 && r2.status?.height === 720, `分辨率已切换为 1280x720 (实际 ${r2.status?.width}x${r2.status?.height})`);

  // 切换后管理端仍应可用（原死锁会让后续 start/stop 全部失效）
  const r3 = await withTimeout(dm.start({}), 20000, 'T1 start after switch');
  ok(r3.ok, '切换后再次 start 仍正常');
  ok(r3.alreadyRunning === true, '同分辨率重复 start 返回 alreadyRunning（未误重启整桌）');
  await withTimeout(dm.stop(), 25000, 'T1 stop');
};

// T2: 停止后可再次启动
tests.T2 = async () => {
  await cleanSlate();
  const a = await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T2 start #1');
  ok(a.ok, '第一次启动成功');
  const s = await withTimeout(dm.stop(), 25000, 'T2 stop');
  ok(s.ok, '停止成功');
  await sleep(1500);
  const b = await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T2 start #2');
  ok(b.ok, '停止后重新启动成功');
  ok(b.status?.running === true, 'running 标志为 true');
  await withTimeout(dm.stop(), 25000, 'T2 final stop');
};

// T3: 快速 stop -> start 循环，检验端口/锁竞争
tests.T3 = async () => {
  await cleanSlate();
  await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T3 initial start');
  for (let i = 1; i <= 5; i++) {
    await withTimeout(dm.stop(), 25000, `T3 stop #${i}`);
    const r = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, `T3 immediate start #${i}`);
    ok(r.ok, `第 ${i} 轮 stop 后立即 start 成功`);
  }
  await withTimeout(dm.stop(), 25000, 'T3 final stop');
};

// T4: 子进程崩溃后 start 自愈
tests.T4 = async () => {
  await cleanSlate();
  const r1 = await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T4 start');
  ok(r1.ok, '初始启动成功');
  await sleep(2000);
  spawnSync('pkill', ['-9', '-f', 'chromium'], { encoding: 'utf8' });
  await sleep(2500);
  const st = dm.getStatus();
  console.log(`   崩溃后 status.running=${st.running} healthy=${st.healthy}`);
  const r2 = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T4 restart after crash');
  ok(r2.ok, '崩溃后 start 返回 ok');
  const alive = pgrep('chromium');
  ok(alive.length > 0, 'Chromium 进程已被重新拉起');
  await withTimeout(dm.stop(), 25000, 'T4 stop');
};

// T5: 启动失败后重试幂等（人为占用 :99 制造首次失败）
tests.T5 = async () => {
  await cleanSlate();
  // 人为占用 :99（异步派生，绝不阻塞；spawnSync 会一直等待永不退出的 Xvfb）
  const blocker = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x720x24', '-ac', '-nolisten', 'tcp'], {
    detached: true, stdio: 'ignore'
  });
  blocker.unref();
  await sleep(2500);
  const r1 = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T5 failing start');
  console.log(`   占用 :99 时 start 结果: ok=${r1.ok} error=${r1.error || '-'}`);
  // 释放占用
  spawnSync('pkill', ['-9', '-f', `Xvfb ${DISPLAY}`], { encoding: 'utf8' });
  if (blocker.pid) { try { process.kill(blocker.pid, 'SIGKILL'); } catch {} }
  await sleep(2000);
  const r2 = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T5 retry start');
  ok(r2.ok, '释放占用后重试启动成功（无残留阻塞）');
  await withTimeout(dm.stop(), 25000, 'T5 stop');
};

// T6: restart 携带新分辨率
tests.T6 = async () => {
  await cleanSlate();
  await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T6 start');
  const r = await withTimeout(dm.restart({ width: 1440, height: 900 }), 60000, 'T6 restart 1440x900');
  ok(r.ok, 'restart 返回 ok');
  ok(r.status?.width === 1440, `restart 后分辨率为 1440 (实际 ${r.status?.width})`);
  await withTimeout(dm.stop(), 25000, 'T6 stop');
};

// T7: 模拟空闲/时长到期自动停止后立即重启
tests.T7 = async () => {
  await cleanSlate();
  await withTimeout(dm.start({ width: 1280, height: 720, durationMinutes: 1 }), 40000, 'T7 start');
  // 直接把 expiresAt 拨到过去，触发 watchdog 的自动 stop
  dm.expiresAt = Date.now() - 1000;
  dm.checkIdleWatchdog();
  await sleep(2000);
  const r = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T7 restart after auto-stop');
  ok(r.ok, '自动停止后立即重启成功');
  await withTimeout(dm.stop(), 25000, 'T7 stop');
};

// T8: 运行时配置（CDP 端口）热更新并生效
tests.T8 = async () => {
  await cleanSlate();
  await withTimeout(dm.start({ width: 1280, height: 720, enableCdp: true, cdpPort: 9222 }), 45000, 'T8 start');
  const changed = dm.applyConfig({ cdpPort: 9333 });
  ok(changed.cdpPort === 9333, 'applyConfig 报告 cdpPort 变更');
  // 等待异步重启完成（队列串行）
  await withTimeout(dm._opChain, 70000, 'T8 wait restart');
  const st = dm.getStatus();
  ok(st.cdpPort === 9333, `配置已生效 cdpPort=${st.cdpPort}`);
  ok(st.running === true, '重启后桌面运行中');
  let cdpOk = false;
  for (let i = 0; i < 25; i++) {
    try { const r = await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(1500) }); if (r.ok) { cdpOk = true; break; } } catch {}
    await sleep(400);
  }
  ok(cdpOk, '新 CDP 端口 9333 已监听');
  await withTimeout(dm.stop(), 25000, 'T8 stop');
};

async function main() {
  const only = process.argv.slice(2).filter(a => /^T\d+$/.test(a));
  const names = (only.length ? only : Object.keys(tests));
  console.log(`\n===== 桌面生命周期回归测试 (DISPLAY=${DISPLAY}) =====\n`);
  for (const name of names) {
    if (!tests[name]) { console.log(`跳过未知用例 ${name}`); continue; }
    console.log(`▶ ${name}`);
    const fdsBefore = countFds();
    try {
      await withTimeout(tests[name](), 180000, `${name} 整体超时`);
      console.log(`   ✅ ${name} 通过\n`);
      pass++;
    } catch (err) {
      console.log(`   ❌ ${name} 失败: ${err.message}\n`);
      failures.push(`${name}: ${err.message}`);
      fail++;
      await cleanSlate().catch(() => {});
    }
  }
  console.log('===== 汇总 =====');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
}

main().catch(err => { console.error('测试运行异常:', err); process.exit(1); });
