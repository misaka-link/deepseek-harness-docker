'use strict';
/**
 * plugins-state.json 单写者原子读写库。
 *
 * 目标：
 *   1) 统一 gateway/src/plugins/plugin-manager.js、gateway/src/backup/restore.js 与
 *      scripts/install-plugin.mjs 对 plugins-state.json 的读写口径；
 *   2) 每次写入严格保留磁盘上已有的 `known` 与任意未知字段，避免多写者互相覆盖导致
 *      已卸载或已停用的插件在重启/升级/快照还原后“复活”；
 *   3) 采用同目录临时文件 + rename 原子替换，防止写盘中断留下半截 JSON。
 */

const fs = require('node:fs');
const path = require('node:path');

function defaultDshDir(env = process.env) {
  if (env.DSH_DIR && String(env.DSH_DIR).trim()) {
    return String(env.DSH_DIR).trim();
  }
  const home = (env.DSH_HOME && String(env.DSH_HOME).trim()) || '/root';
  return path.basename(home) === '.dsh' ? home : path.join(home, '.dsh');
}

function defaultStateFilePath(env = process.env) {
  return path.join(defaultDshDir(env), 'plugins-state.json');
}

function uniqueStringArray(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  const seen = new Set();
  for (const item of val) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 归一化 plugins-state 对象，保留全部未知扩展字段。
 * @param {object|null|undefined} raw
 */
function normalizePluginState(raw) {
  const base = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? { ...raw } : {};
  base.disabled = uniqueStringArray(base.disabled);
  base.uninstalled = uniqueStringArray(base.uninstalled);
  base.known = uniqueStringArray(base.known);
  return base;
}

/**
 * 读取 plugins-state.json；缺失或损坏时安全回落为空状态（不抛异常）。
 * @param {string} [stateFile]
 */
function readPluginState(stateFile = defaultStateFilePath()) {
  try {
    if (fs.existsSync(stateFile)) {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return normalizePluginState(parsed);
    }
  } catch (err) {
    console.warn(`[plugin-state] 读取 ${stateFile} 警告:`, err.message);
  }
  return normalizePluginState(null);
}

function atomicWriteText(filePath, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * 原子写入 plugins-state.json。
 * 默认先读取现网文件并合并保留 `known` 及全部未知字段：
 *   - 若调用方未显式传入 `known`，自动保留现网 `known`；
 *   - 若调用方传入了 `known`，使用调用方提供的 `known`（可传 `{ mergeKnown: true }` 取并集）。
 *
 * @param {string} [stateFile]
 * @param {object} nextState
 * @param {{ mergeKnown?: boolean, mode?: number }} [opts]
 * @returns {boolean}
 */
function writePluginState(stateFile, nextState, opts = {}) {
  // 兼容只传 (nextState) 的简写
  if (typeof stateFile === 'object' && stateFile !== null) {
    opts = nextState || {};
    nextState = stateFile;
    stateFile = defaultStateFilePath();
  }
  const target = stateFile || defaultStateFilePath();
  try {
    const existing = readPluginState(target);
    const incoming = (nextState && typeof nextState === 'object' && !Array.isArray(nextState))
      ? nextState
      : {};

    const merged = { ...existing, ...incoming };
    merged.disabled = uniqueStringArray(
      incoming.disabled !== undefined ? incoming.disabled : existing.disabled
    );
    merged.uninstalled = uniqueStringArray(
      incoming.uninstalled !== undefined ? incoming.uninstalled : existing.uninstalled
    );

    if (incoming.known === undefined) {
      merged.known = uniqueStringArray(existing.known);
    } else if (opts.mergeKnown) {
      merged.known = uniqueStringArray([...existing.known, ...uniqueStringArray(incoming.known)]);
    } else {
      merged.known = uniqueStringArray(incoming.known);
    }

    merged.updatedAt = new Date().toISOString();
    atomicWriteText(target, JSON.stringify(merged, null, 2) + '\n', opts.mode || 0o644);
    return true;
  } catch (err) {
    console.error(`[plugin-state] 写入 ${target} 失败:`, err.message);
    return false;
  }
}

/**
 * 读-改-写原子更新辅助函数。
 * @param {string} stateFile
 * @param {(state: object) => object|void} mutator
 * @returns {{ ok: boolean, state: object }}
 */
function updatePluginState(stateFile, mutator) {
  const target = stateFile || defaultStateFilePath();
  const current = readPluginState(target);
  const mutated = mutator(current) || current;
  const ok = writePluginState(target, mutated);
  return { ok, state: normalizePluginState(mutated) };
}

/**
 * 快照还原时的 plugins-state.json 合并策略：
 *   - 若快照不含 plugins-state.json（snapRaw == null）：完整保留现网 liveState；
 *   - 若快照包含 plugins-state.json：以快照状态为主体，同时保留现网与快照的 unknown 字段，
 *     且 `known = live.known ∪ snap.known`，避免现网曾卸载的插件因缺少 known 记录而复活。
 *
 * @param {object|null|undefined} liveRaw
 * @param {object|null|undefined} snapRaw
 * @param {{ unsupportedPlugins?: string[] }} [opts]
 */
function mergePluginStates(liveRaw, snapRaw, opts = {}) {
  const live = normalizePluginState(liveRaw);
  if (!snapRaw || typeof snapRaw !== 'object') {
    return { ...live, updatedAt: new Date().toISOString() };
  }
  const snap = normalizePluginState(snapRaw);
  const unsupported = new Set(uniqueStringArray(opts.unsupportedPlugins || []));

  const disabled = new Set(snap.disabled);
  const uninstalled = new Set(snap.uninstalled);
  for (const name of unsupported) {
    if (!uninstalled.has(name)) disabled.add(name);
  }

  return {
    ...live,
    ...snap,
    disabled: Array.from(disabled),
    uninstalled: Array.from(uninstalled),
    known: uniqueStringArray([...live.known, ...snap.known]),
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  defaultDshDir,
  defaultStateFilePath,
  uniqueStringArray,
  normalizePluginState,
  readPluginState,
  writePluginState,
  updatePluginState,
  mergePluginStates
};
