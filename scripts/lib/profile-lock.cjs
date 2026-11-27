'use strict';
/**
 * profile 写锁 —— 与官方 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 协议对齐。
 *
 * 锁文件：<profileDir>/package.json.lock（`wx` 独占创建，mode 0o600）。
 * 在跨进程文件锁之上增加进程内互斥队列与保守的陈旧锁回收，并提供
 * `assertProfileLockHeld()` 运行时护栏，防止并发写 profile 丢失更新。
 */

const fs = require('node:fs');
const path = require('node:path');

const RETRY_INITIAL_MS = 20;
const RETRY_MAX_MS = 200;
const DEFAULT_WAIT_MS = 120000;
const STALE_MS = process.env.DSH_PROFILE_LOCK_STALE_MS === undefined
  ? 600000
  : Number(process.env.DSH_PROFILE_LOCK_STALE_MS);
const WARN_WAIT_MS = Number(process.env.DSH_PROFILE_LOCK_WARN_MS || 500);

const held = new Map();
const chains = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function profileLockPath(profileDir) {
  return path.join(profileDir, 'package.json.lock');
}

function isProfileLockHeld(profileDir) {
  return held.has(profileLockPath(profileDir));
}

function assertProfileLockHeld(profileDir) {
  const lockPath = profileLockPath(profileDir);
  if (held.has(lockPath)) return;
  const err = new Error(
    `profile-lock: 未持有 profile 写锁却尝试写入 ${profileDir}；` +
    `请先用 withProfileLock() 包住整段"读-改-写"（锁文件: ${lockPath}）`
  );
  err.code = 'PROFILE_LOCK_NOT_HELD';
  throw err;
}

function timeoutError(lockPath, waitMs, label) {
  const err = new Error(
    `profile-lock: 等待 profile 写锁超时（${waitMs}ms）${label}: ${lockPath}；` +
    `持有者可能是正在执行 pnpm 安装的 DSH，请稍后重试`
  );
  err.code = 'PROFILE_LOCK_TIMEOUT';
  return err;
}

function isLockContention(error, lockPath) {
  const code = error && error.code;
  if (code === 'EEXIST') return true;
  if (code !== 'EPERM') return false;
  try {
    fs.lstatSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function readHolderPid(lockPath) {
  try {
    const n = Number.parseInt(String(fs.readFileSync(lockPath, 'utf8')).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function tryReclaimStale(lockPath) {
  if (!(STALE_MS > 0)) return false;
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return false;
  }
  if (Date.now() - stat.mtimeMs <= STALE_MS) return false;
  const pid = readHolderPid(lockPath);
  if (pid !== null && isProcessAlive(pid)) return false;
  try {
    fs.rmSync(lockPath, { force: true });
    console.warn(`[profile-lock] 已回收陈旧锁（持有者 PID=${pid === null ? '未知' : pid}，mtime 超时 ${STALE_MS}ms）: ${lockPath}`);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(promise, deadline, lockPath, waitMs, label) {
  const remain = deadline - Date.now();
  if (remain <= 0) throw timeoutError(lockPath, waitMs, label);
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(lockPath, waitMs, label)), remain); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function enqueueInProcessTurn(lockPath) {
  const prev = chains.get(lockPath) || Promise.resolve();
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const tail = prev.then(() => gate);
  chains.set(lockPath, tail);
  const release = () => {
    releaseGate();
    if (chains.get(lockPath) === tail) chains.delete(lockPath);
  };
  return { prev, release };
}

async function acquireFileLock(lockPath, profileDir, deadline, waitMs, label) {
  fs.mkdirSync(profileDir, { recursive: true });
  let delay = RETRY_INITIAL_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if (!isLockContention(error, lockPath)) throw error;
      tryReclaimStale(lockPath);
    }
    if (Date.now() >= deadline) throw timeoutError(lockPath, waitMs, label);
    await sleep(delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }
}

async function acquireProfileLock(profileDir, options = {}) {
  const lockPath = profileLockPath(profileDir);
  const waitMs = Number.isFinite(options.waitMs) ? Number(options.waitMs) : DEFAULT_WAIT_MS;
  const label = options.label ? ` (${options.label})` : '';

  if (held.has(lockPath)) {
    const err = new Error(
      `profile-lock: 本进程已持有 profile 写锁 ${lockPath} 却再次获取；` +
      `请在锁内调用各模块的 *Locked 内部函数，不要重复取锁`
    );
    err.code = 'PROFILE_LOCK_REENTRANT';
    throw err;
  }

  const started = Date.now();
  const deadline = started + waitMs;

  const turn = enqueueInProcessTurn(lockPath);
  try {
    await waitUntil(turn.prev, deadline, lockPath, waitMs, label);
  } catch (error) {
    turn.release();
    throw error;
  }

  try {
    await acquireFileLock(lockPath, profileDir, deadline, waitMs, label);
  } catch (error) {
    turn.release();
    throw error;
  }

  const waitedMs = Date.now() - started;
  held.set(lockPath, { waitedMs });
  if (waitedMs >= WARN_WAIT_MS) {
    console.warn(`[profile-lock] 等待 profile 写锁 ${waitedMs}ms${label}（存在与 DSH 的争用）: ${lockPath}`);
  }

  return () => {
    if (!held.has(lockPath)) {
      turn.release();
      return;
    }
    held.delete(lockPath);
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {}
    turn.release();
  };
}

function releaseProfileLock(lockPath) {
  if (!held.has(lockPath)) return;
  held.delete(lockPath);
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {}
}

async function withProfileLock(profileDir, operation, options = {}) {
  const release = await acquireProfileLock(profileDir, options);
  try {
    return await operation();
  } finally {
    release();
  }
}

module.exports = {
  DEFAULT_WAIT_MS,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
  profileLockPath,
  isProfileLockHeld,
  assertProfileLockHeld,
  acquireProfileLock,
  releaseProfileLock,
  withProfileLock
};
