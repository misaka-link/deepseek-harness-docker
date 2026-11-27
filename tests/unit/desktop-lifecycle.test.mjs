#!/usr/bin/env node
/**
 * 容器虚拟桌面生命周期回归测试（需要容器内 Xvfb + chromium-docker；无桌面栈时自动跳过）。
 * 用法: node tests/unit/desktop-lifecycle.test.mjs [T1 T2 ...]
 */
import { createRequire } from 'node:module';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const hasXvfb = spawnSync('which', ['Xvfb'], { encoding: 'utf8' }).status === 0;
const hasChromium = spawnSync('which', ['chromium-docker'], { encoding: 'utf8' }).status === 0
  || spawnSync('which', ['chromium'], { encoding: 'utf8' }).status === 0;

if (!hasXvfb || !hasChromium || process.env.DSH_RUN_DESKTOP_LIFECYCLE !== '1') {
  console.log('[desktop-lifecycle] 未检测到容器桌面栈或未设置 DSH_RUN_DESKTOP_LIFECYCLE=1，跳过实机 X11 生命周期测试');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const dm = require(path.join(root, 'gateway/src/desktop/desktop-manager.js'));

const DISPLAY = process.env.DISPLAY || ':99';
let pass = 0, fail = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (cond, msg) => { if (cond) console.log(`   ✔ ${msg}`); else throw new Error(`断言失败: ${msg}`); };
const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`超时 ${ms}ms: ${label}`)), ms); })
  ]);
};

async function cleanSlate() {
  await withTimeout(dm.stop(), 25000, 'cleanSlate stop').catch(() => {});
  await sleep(1500);
}

const tests = {
  T1: async () => {
    await cleanSlate();
    const r1 = await withTimeout(dm.start({ width: 1920, height: 1080 }), 40000, 'T1 start');
    ok(r1.ok, '首次启动成功');
    const r2 = await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T1 switch');
    ok(r2.ok && r2.status?.width === 1280 && r2.status?.height === 720, '切换分辨率为 1280x720');
    const r3 = await withTimeout(dm.start({}), 20000, 'T1 repeat');
    ok(r3.ok && r3.alreadyRunning === true, '同分辨率重复 start 返回 alreadyRunning');
    await withTimeout(dm.stop(), 25000, 'T1 stop');
  },
  T2: async () => {
    await cleanSlate();
    ok((await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T2 start1')).ok, '第一次启动成功');
    ok((await withTimeout(dm.stop(), 25000, 'T2 stop')).ok, '停止成功');
    await sleep(1500);
    const b = await withTimeout(dm.start({ width: 1280, height: 720 }), 40000, 'T2 start2');
    ok(b.ok && b.status?.running === true, '停止后重新启动成功');
    await withTimeout(dm.stop(), 25000, 'T2 final stop');
  },
  T5: async () => {
    await cleanSlate();
    const blocker = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x720x24', '-ac', '-nolisten', 'tcp'], { detached: true, stdio: 'ignore' });
    blocker.unref();
    await sleep(2500);
    await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T5 failing start');
    if (blocker.pid) { try { process.kill(blocker.pid, 'SIGKILL'); } catch {} }
    await sleep(2000);
    ok((await withTimeout(dm.start({ width: 1280, height: 720 }), 45000, 'T5 retry')).ok, '释放占用后重试启动成功');
    await withTimeout(dm.stop(), 25000, 'T5 stop');
  }
};

const only = process.argv.slice(2).filter((a) => /^T\d+$/.test(a));
const names = only.length ? only : Object.keys(tests);
for (const name of names) {
  if (!tests[name]) continue;
  try {
    await withTimeout(tests[name](), 180000, name);
    pass++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    fail++;
    await cleanSlate().catch(() => {});
  }
}
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
