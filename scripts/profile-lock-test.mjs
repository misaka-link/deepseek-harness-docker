/**
 * P6 回归测试：profile 写锁（scripts/profile-lock.cjs）。
 *
 * 覆盖：
 *   A. 锁文件路径与 DSH 一致（<profileDir>/package.json.lock）
 *   B. 获取/释放、锁文件内容写入持有者 PID
 *   C. 未持锁写 profile 被运行时护栏拦下（PROFILE_LOCK_NOT_HELD）
 *   D. 进程内可重入（嵌套不会自锁死）
 *   E. 并发任务被串行化（不交错）
 *   F. 锁被他人持有时按 waitMs 超时（PROFILE_LOCK_TIMEOUT）
 *   G. 陈旧锁回收：PID 已死 + mtime 超阈值 → 回收；PID 存活 → 绝不回收
 *   H. 跨进程互斥：多进程并发"读-改-写"同一个计数文件，零丢更新
 *
 * 用法: node scripts/profile-lock-test.mjs
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须在 require 之前设置：让陈旧锁回收阈值变小，便于测试
process.env.DSH_PROFILE_LOCK_STALE_MS = '1200';
process.env.DSH_PROFILE_LOCK_WARN_MS = '100000';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MOD = path.join(here, 'profile-lock.cjs');
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

console.log('\n=== A. 锁文件路径与 DSH 一致 ===');
ok(lockPath === path.join(profileDir, 'package.json.lock'), '锁文件为 <profileDir>/package.json.lock');

console.log('\n=== B. 获取/释放与锁内容 ===');
const rel = await acquireProfileLock(profileDir);
ok(fs.existsSync(lockPath), '持锁期间锁文件存在');
ok(fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid), '锁文件写入持有者 PID');
ok((fs.statSync(lockPath).mode & 0o777) === 0o600, '锁文件权限为 0600');
ok(isProfileLockHeld(profileDir), 'isProfileLockHeld 为真');
rel();
ok(!fs.existsSync(lockPath), '释放后锁文件被删除');
ok(!isProfileLockHeld(profileDir), 'isProfileLockHeld 为假');

console.log('\n=== C. 未持锁写 profile 被护栏拦下 ===');
let guardCode = null;
try { assertProfileLockHeld(profileDir); } catch (e) { guardCode = e.code; }
ok(guardCode === 'PROFILE_LOCK_NOT_HELD', '未持锁时抛 PROFILE_LOCK_NOT_HELD');

console.log('\n=== D. 嵌套获取被明确拒绝（不静默自锁死） ===');
const r1 = await acquireProfileLock(profileDir);
let nestedCode = null;
try { await acquireProfileLock(profileDir, { waitMs: 200 }); } catch (e) { nestedCode = e.code; }
ok(nestedCode === 'PROFILE_LOCK_REENTRANT', '同进程重复取锁抛 PROFILE_LOCK_REENTRANT');
r1();
ok(!isProfileLockHeld(profileDir), '释放后完全释放');

console.log('\n=== E. 并发任务被串行化 ===');
const order = [];
await Promise.all([
  withProfileLock(profileDir, async () => { order.push('a-in'); await sleep(120); order.push('a-out'); }),
  withProfileLock(profileDir, async () => { order.push('b-in'); await sleep(20); order.push('b-out'); })
]);
ok(order.join(',') === 'a-in,a-out,b-in,b-out', `无交错（实际 ${order.join(',')}）`);

console.log('\n=== F. 跨进程等待超时 ===');
const holderScript = path.join(tmp, 'holder.cjs');
fs.writeFileSync(holderScript, `
const { acquireProfileLock } = require(${JSON.stringify(LOCK_MOD)});
(async () => {
  const rel = await acquireProfileLock(process.argv[2], { label: 'holder' });
  process.stdout.write('HELD\\n');
  await new Promise((r) => setTimeout(r, 2000));
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
ok(timeoutCode === 'PROFILE_LOCK_TIMEOUT', '他人持锁时按 waitMs 超时并抛 PROFILE_LOCK_TIMEOUT');
await holderExited;
ok(!fs.existsSync(lockPath), '持有者释放后锁文件消失');

console.log('\n=== G. 陈旧锁回收（保守策略）===');
// G1：PID 已不存在 + mtime 超阈值 → 应被回收
fs.writeFileSync(lockPath, '999999\n', { flag: 'wx' });
const oldTs = Date.now() / 1000 - 3600;
fs.utimesSync(lockPath, oldTs, oldTs);
let reclaimed = false;
try {
  const r = await acquireProfileLock(profileDir, { waitMs: 3000 });
  reclaimed = true;
  r();
} catch { reclaimed = false; }
ok(reclaimed, '锁内 PID 已死且超时 → 回收并成功获取');

// G2：PID 存活（写本进程 PID）+ mtime 超阈值 → 绝不回收
fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
fs.utimesSync(lockPath, oldTs, oldTs);
let liveKept = false;
try { await withProfileLock(profileDir, async () => {}, { waitMs: 300 }); } catch (e) { liveKept = e.code === 'PROFILE_LOCK_TIMEOUT'; }
ok(liveKept, '锁内 PID 存活 → 即使 mtime 超阈值也不回收（保守）');
fs.rmSync(lockPath, { force: true });

console.log('\n=== H. 跨进程互斥（零丢更新）===');
const childScript = path.join(tmp, 'child.cjs');
fs.writeFileSync(childScript, `
const { withProfileLock } = require(${JSON.stringify(LOCK_MOD)});
const fs = require('fs');
const profileDir = process.argv[2];
const counter = process.argv[3];
(async () => {
  for (let i = 0; i < 10; i++) {
    await withProfileLock(profileDir, async () => {
      const n = Number(fs.readFileSync(counter, 'utf8'));
      await new Promise((r) => setTimeout(r, 15));
      fs.writeFileSync(counter, String(n + 1));
    });
  }
})();
`);
const counter = path.join(tmp, 'counter.txt');
fs.writeFileSync(counter, '0');
const CHILDREN = 3;
const runs = Array.from({ length: CHILDREN }, () => new Promise((resolve) => {
  const p = spawn(process.execPath, [childScript, profileDir, counter], { stdio: 'ignore' });
  p.on('exit', resolve);
}));
await Promise.all(runs);
const finalCount = Number(fs.readFileSync(counter, 'utf8'));
ok(finalCount === CHILDREN * 10, `${CHILDREN} 进程 × 10 次读改写 = ${CHILDREN * 10}（实际 ${finalCount}，无丢更新）`);
ok(!fs.existsSync(lockPath), '全部子进程结束后锁文件已释放');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
