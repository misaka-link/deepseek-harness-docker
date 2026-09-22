'use strict';
/**
 * profile 写锁 —— 与官方 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 语义对齐。
 *
 * 背景（P6）：DSH 0.1.7 的原生插件管理器与设置编辑器在改 `profiles/web/package.json`
 * 与 `profiles/web/cordis.patch.yml` 之前，都会先取 `profiles/web/package.json.lock`
 * （`wx` 独占创建）。它们是跨进程互斥的；我们网关此前完全没参与这把锁，
 * 于是两边各自"读-改-写"整份文件，后写者会把先写者的修改整体覆盖 → 丢更新
 * （插件启停状态漂移、`llm-pi-ai` 等设置条目被吞）。
 *
 * 本模块让控制台成为该锁协议的合法参与者。与上游逐项对齐：
 *   | 项       | 上游行为                                                        |
 *   |----------|-----------------------------------------------------------------|
 *   | 锁文件   | `${filename}.lock`（此处即 `<profileDir>/package.json.lock`）    |
 *   | 创建     | writeFile(lock, `${pid}\n`, { flag: 'wx', mode: 0o600 })         |
 *   | 争用     | EEXIST；Windows 上 EPERM 且锁文件存在                            |
 *   | 退避     | 20ms 起 ×2，上限 200ms                                           |
 *   | 等待上限 | 上游默认 2s；插件管理器显式传 lockWaitMs=120s ⇒ 我们也默认 120s  |
 *   | 释放     | `finally { rm(lock, { force: true }) }`                          |
 *   | 读者     | 不持锁（rename 原子提交保证读者看到完整文件）                     |
 *
 * 相比上游多做的两件事（都不改变与 DSH 的互斥语义）：
 *   1) **进程内互斥队列**：文件锁只能跨进程互斥；同一进程里两个并发请求若同时进入
 *      "读-改-写"，一样会丢更新。因此在文件锁之外再串行化本进程内的获取者。
 *      注意：本模块**不支持嵌套获取**（同一进程重复获取同一把锁会抛
 *      PROFILE_LOCK_REENTRANT，避免静默自锁死）。需要"在锁内再做事"时，请调用
 *      各模块的 `*Locked` 内部函数，而不是再次取锁。
 *   2) **陈旧锁回收**：仅当锁内记录的 PID **已不存在** 且锁文件 mtime 超过阈值时才回收。
 *      上游不做回收，崩溃后会阻塞到超时；这里 PID 存活就绝不回收，因此不会破坏互斥。
 *      可用 DSH_PROFILE_LOCK_STALE_MS=0 关闭。
 *
 * 另提供 `assertProfileLockHeld()`：把「必须先持锁」变成运行时护栏，
 * 让"忘记加锁就直接写 profile"在测试与生产上都立即失败，而不是静默丢更新。
 */

const fs = require('fs');
const path = require('path');

const RETRY_INITIAL_MS = 20;
const RETRY_MAX_MS = 200;
/** 与 dsh-plugin-manager 的 lockWaitMs 默认值一致（它会持锁跑 pnpm 安装，可能持续很久） */
const DEFAULT_WAIT_MS = 120000;
/** 陈旧锁回收阈值（ms）；<=0 表示关闭回收 */
const STALE_MS = process.env.DSH_PROFILE_LOCK_STALE_MS === undefined
  ? 600000
  : Number(process.env.DSH_PROFILE_LOCK_STALE_MS);
/** 等待超过该阈值即告警（说明与 DSH 存在争用） */
const WARN_WAIT_MS = Number(process.env.DSH_PROFILE_LOCK_WARN_MS || 500);

/** lockPath -> { waitedMs }；表示**本进程**当前持有该文件锁 */
const held = new Map();
/** lockPath -> Promise：本进程内获取队列的尾节点 */
const chains = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** profile 写锁的路径（与 DSH 完全一致） */
function profileLockPath(profileDir) {
  return path.join(profileDir, 'package.json.lock');
}

function isProfileLockHeld(profileDir) {
  return held.has(profileLockPath(profileDir));
}

/**
 * 运行时护栏：未持锁就写 profile 文件时立即抛错。
 * 这是防"静默丢更新"的最后一道防线（比静态检查更可靠）。
 */
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

/** 与上游 isLockContention 一致 */
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
    // EPERM：进程存在但本进程无权限发信号 ⇒ 视为存活（保守）
    return Boolean(error && error.code === 'EPERM');
  }
}

/**
 * 保守回收陈旧锁：只有锁内 PID 确认不存在、且锁文件已超过 STALE_MS 未变动时才删除。
 * 任何一项无法确认（PID 存活 / 读不到 PID / 未超时）都保持不动。
 */
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

/** 带截止时间的等待（用于进程内队列，保证等待也可超时） */
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

/**
 * 进程内互斥：把本进程内对同一把锁的获取者串成队列。
 * @returns {{ prev: Promise<void>, release: () => void }}
 */
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

/** 获取跨进程文件锁（带截止时间与陈旧锁回收） */
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

/**
 * 获取 profile 写锁，返回释放函数（必须放在 finally 中调用）。
 * @param {string} profileDir profile 目录（如 `<DSH_HOME>/.dsh/profiles/web`）
 * @param {{ waitMs?: number, label?: string }} [options]
 * @returns {Promise<() => void>} 释放函数
 */
async function acquireProfileLock(profileDir, options = {}) {
  const lockPath = profileLockPath(profileDir);
  const waitMs = Number.isFinite(options.waitMs) ? Number(options.waitMs) : DEFAULT_WAIT_MS;
  const label = options.label ? ` (${options.label})` : '';

  // 不支持嵌套获取：本进程已持有该锁时立即报错，而不是静默自锁死
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

  // 1) 进程内排队（同进程并发必须串行，否则一样丢更新）
  const turn = enqueueInProcessTurn(lockPath);
  try {
    await waitUntil(turn.prev, deadline, lockPath, waitMs, label);
  } catch (error) {
    turn.release();
    throw error;
  }

  // 2) 跨进程文件锁
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
    } catch {
      /* 释放失败不应影响调用方；陈旧锁由 tryReclaimStale 兜底 */
    }
    turn.release();
  };
}

/** 兼容入口：按路径释放（仅当确实由本进程持有时生效） */
function releaseProfileLock(lockPath) {
  if (!held.has(lockPath)) return;
  held.delete(lockPath);
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {}
}

/**
 * 在 profile 写锁内执行操作（整段"读-改-写"必须都放进来）。
 * @template T
 * @param {string} profileDir
 * @param {() => T | Promise<T>} operation
 * @param {{ waitMs?: number, label?: string }} [options]
 * @returns {Promise<T>}
 */
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
