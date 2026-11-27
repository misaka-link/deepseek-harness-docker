#!/usr/bin/env node
/**
 * profile 写锁（scripts/lib/profile-lock.cjs）回归测试。
 * 用法: node tests/unit/profile-lock.test.mjs
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DSH_PROFILE_LOCK_STALE_MS = '1200';
process.env.DSH_PROFILE_LOCK_WARN_MS = '100000';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const LOCK_MOD = path.join(root, 'scripts/lib/profile-lock.cjs');
const {
  withProfileLock,
  acquireProfileLock,
  isProfileLockHeld,
  assertProfileLockHeld,
  profileLockPath
} = require(LOCK_MOD);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-lock-'));
const profileDir = path.join(tmp, 'profiles/web');
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), '{}\n');
const lockPath = profileLockPath(profileDir);

try {
  ok(lockPath === path.join(profileDir, 'package.json.lock'), 'A. 锁文件路径为 package.json.lock');

  const rel = await acquireProfileLock(profileDir);
  ok(fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid) && (fs.statSync(lockPath).mode & 0o777) === 0o600 && isProfileLockHeld(profileDir), 'B1. 获取锁写入 PID 且权限 0600');
  rel();
  ok(!fs.existsSync(lockPath) && !isProfileLockHeld(profileDir), 'B2. 释放后锁文件删除');

  let guardCode = null;
  try { assertProfileLockHeld(profileDir); } catch (e) { guardCode = e.code; }
  ok(guardCode === 'PROFILE_LOCK_NOT_HELD', 'C. 未持锁抛 PROFILE_LOCK_NOT_HELD');

  const r1 = await acquireProfileLock(profileDir);
  let nestedCode = null;
  try { await acquireProfileLock(profileDir, { waitMs: 200 }); } catch (e) { nestedCode = e.code; }
  ok(nestedCode === 'PROFILE_LOCK_REENTRANT', 'D. 同进程嵌套取锁抛 PROFILE_LOCK_REENTRANT');
  r1();

  const order = [];
  await Promise.all([
    withProfileLock(profileDir, async () => { order.push('a-in'); await sleep(120); order.push('a-out'); }),
    withProfileLock(profileDir, async () => { order.push('b-in'); await sleep(20); order.push('b-out'); })
  ]);
  ok(order.join(',') === 'a-in,a-out,b-in,b-out', 'E. 并发任务严格串行化');

  const holderScript = path.join(tmp, 'holder.cjs');
  fs.writeFileSync(holderScript, `
const { acquireProfileLock } = require(${JSON.stringify(LOCK_MOD)});
(async () => {
  const rel = await acquireProfileLock(process.argv[2], { label: 'holder' });
  process.stdout.write('HELD\\n');
  await new Promise((r) => setTimeout(r, 1500));
  rel();
})();
`);
  const holder = spawn(process.execPath, [holderScript, profileDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  const holderExited = new Promise((resolve) => holder.on('exit', resolve));
  const holderReady = new Promise((resolve) => {
    let done = false;
    holder.stdout.on('data', (d) => { if (!done && String(d).includes('HELD')) { done = true; resolve(); } });
  });
  await Promise.race([holderReady, sleep(5000)]);
  let timeoutCode = null;
  try { await withProfileLock(profileDir, async () => {}, { waitMs: 150 }); } catch (e) { timeoutCode = e.code; }
  ok(timeoutCode === 'PROFILE_LOCK_TIMEOUT', 'F. 跨进程持锁等待超时抛 PROFILE_LOCK_TIMEOUT');
  await holderExited;

  fs.writeFileSync(lockPath, '999999\n', { flag: 'wx' });
  const oldTs = Date.now() / 1000 - 3600;
  fs.utimesSync(lockPath, oldTs, oldTs);
  let reclaimed = false;
  try { const r = await acquireProfileLock(profileDir, { waitMs: 3000 }); reclaimed = true; r(); } catch {}
  ok(reclaimed, 'G1. PID 已死且超时回收陈旧锁');

  fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
  fs.utimesSync(lockPath, oldTs, oldTs);
  let liveKept = false;
  try { await withProfileLock(profileDir, async () => {}, { waitMs: 300 }); } catch (e) { liveKept = e.code === 'PROFILE_LOCK_TIMEOUT'; }
  ok(liveKept, 'G2. 存活 PID 锁绝不误回收');
  fs.rmSync(lockPath, { force: true });

  const childScript = path.join(tmp, 'child.cjs');
  fs.writeFileSync(childScript, `
const { withProfileLock } = require(${JSON.stringify(LOCK_MOD)});
const fs = require('fs');
(async () => {
  for (let i = 0; i < 10; i++) {
    await withProfileLock(process.argv[2], async () => {
      const n = Number(fs.readFileSync(process.argv[3], 'utf8'));
      await new Promise((r) => setTimeout(r, 10));
      fs.writeFileSync(process.argv[3], String(n + 1));
    });
  }
})();
`);
  const counter = path.join(tmp, 'counter.txt');
  fs.writeFileSync(counter, '0');
  await Promise.all([0, 1, 2].map(() => new Promise((resolve) => {
    spawn(process.execPath, [childScript, profileDir, counter], { stdio: 'ignore' }).on('exit', resolve);
  })));
  ok(Number(fs.readFileSync(counter, 'utf8')) === 30 && !fs.existsSync(lockPath), 'H. 3 进程并发读写 30 次零丢更新且锁释放');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
