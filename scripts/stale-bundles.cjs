'use strict';
/**
 * 自动清理 profile 中「无法解析」的幽灵 bundle 条目。
 *
 * 背景：官方 DSH 处于活跃迭代期，会合并/下线 bundle 包。例如 0.1.7 起
 * `@deepseek-ai/dsh-experimental-agent-team-web-profile` 被并入
 * `@deepseek-ai/dsh-experimental-agent-team-profile`，`@deepseek-ai/dsh-settings-file`
 * 被移除。镜像升级后，profile 的 `dsh.profile.bundles` 里会残留已不存在的包名，
 * DSH 每次加载都会向 stderr 打印 `skipping profile bundle "..." : cannot resolve ...`
 * 并在界面提示。
 *
 * 解析判定**完全对齐官方 `dsh-app-boot` 的 `resolveBundleDir`**：先在 DSH 安装锚点、
 * 再在 profile 目录锚点上，用 Node 的 `require.resolve.paths()` 逐个搜索路径检查
 * `<searchPath>/<name>/package.json` 是否存在（安装锚点优先，保证 `@deepseek-ai/*`
 * 始终来自同一份安装）。
 *
 * 安全设计（默认「保守模式」，绝不误删并发写者/用户意图）：
 *   - 默认只清理**已知被上游下线/改名**的 bundle（{@link KNOWN_REMOVED_BUNDLES}，
 *     可用 `DSH_PRUNE_BUNDLES_EXTRA` 追加）。这样既解决升级残留告警，又不会碰
 *     DSH 原生插件管理器刚写入的任意条目（P6「不丢更新」保证）。
 *   - 只清理**确实无法解析**的条目：若该包又能解析了（用户重新装回），一律保留。
 *   - 已在依赖字段（dependencies / devDependencies / optionalDependencies /
 *     peerDependencies）中声明的条目保留，避免误删「已声明待安装」的意图。
 *   - 受保护核心 bundle（`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app`）永不清理。
 *   - `DSH_PRUNE_STALE_BUNDLES=all` 可切换为「激进模式」：清理任意「无法解析且未声明」
 *     的条目；`=0/false/off/no` 完全关闭。
 * 本函数是纯内存变换（不写盘），由调用方在 profile 写锁内落盘，保证幂等且不丢其它条目。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/** 永远不清理的核心 bundle（即使解析失败也应保留并交由上层告警，而不是静默移除底座）。 */
const DEFAULT_PROTECTED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app'
]);

/**
 * 已知被上游下线/改名的 bundle 包（保守模式的清理清单）。
 * 依据：官方各版本 Release 说明与安装树实测。
 *   - `@deepseek-ai/dsh-experimental-agent-team-web-profile`：0.1.7 起并入
 *     `@deepseek-ai/dsh-experimental-agent-team-profile`（其 README 明确要求从
 *     `dsh.profile.bundles` 删除独立条目）。
 *   - `@deepseek-ai/dsh-settings-file`：0.1.7 起移除。
 */
const KNOWN_REMOVED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-experimental-agent-team-web-profile',
  '@deepseek-ai/dsh-settings-file'
]);

/** DSH 安装锚点候选（容器内实际为 `/usr/local/lib/node_modules/@deepseek-ai/dsh`）。 */
function defaultInstallAnchors(env = process.env) {
  const candidates = [
    env.DSH_INSTALL_ANCHOR,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json'
  ];
  const anchors = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) anchors.push(candidate);
    } catch {}
  }
  return anchors;
}

/**
 * 从某个锚点出发解析包目录，语义与官方 `packageDirFromAnchor` 一致。
 * @param {string} anchor 锚点文件（其所在目录向上搜索 node_modules）
 * @param {string} name 包名
 * @returns {string|undefined} 包目录绝对路径，未找到返回 undefined
 */
function packageDirFromAnchor(anchor, name) {
  let searchPaths = null;
  try {
    searchPaths = createRequire(anchor).resolve.paths(name);
  } catch {
    searchPaths = null;
  }
  if (!searchPaths) return undefined;
  for (const searchPath of searchPaths) {
    const candidate = path.join(searchPath, name);
    try {
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    } catch {}
  }
  return undefined;
}

/**
 * 判断 bundle 是否可解析：安装锚点优先，其次 profile 目录锚点。
 * @param {string} name 包名
 * @param {string} profileDir profile 目录
 * @param {string[]} [installAnchors] DSH 安装锚点
 * @returns {boolean}
 */
function isBundleResolvable(name, profileDir, installAnchors) {
  const anchors = [...(installAnchors || defaultInstallAnchors()), path.join(profileDir, 'package.json')];
  for (const anchor of anchors) {
    if (packageDirFromAnchor(anchor, name)) return true;
  }
  return false;
}

/** 收集 manifest 中所有被声明为依赖（任何依赖字段）的包名。 */
function declaredNames(pkg) {
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const obj = pkg && pkg[field];
    if (obj && typeof obj === 'object') {
      for (const key of Object.keys(obj)) names.add(key);
    }
  }
  return names;
}

/**
 * 解析清理模式。
 * @param {Record<string,string|undefined>} [env]
 * @returns {'off'|'known'|'all'} 默认 'known'（保守：仅清理已知下线清单）
 */
function pruneMode(env = process.env) {
  const value = String(env.DSH_PRUNE_STALE_BUNDLES ?? 'known').trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return 'off';
  if (value === 'all') return 'all';
  return 'known';
}

/** 追加到已知下线清单的包名（`DSH_PRUNE_BUNDLES_EXTRA`，逗号分隔）。 */
function extraRemovedNames(env = process.env) {
  return parseExtraList(env.DSH_PRUNE_BUNDLES_EXTRA);
}

/** 解析「额外清理清单」：接受数组或逗号分隔字符串。 */
function parseExtraList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 综合环境变量与持久化配置（`gateway.config.json`）解析清理策略。
 * 优先级：环境变量 `DSH_PRUNE_STALE_BUNDLES` > 持久化 `pruneStaleBundles` > 默认 `known`；
 * 额外清单取两者并集（环境变量 `DSH_PRUNE_BUNDLES_EXTRA` + 持久化 `pruneBundlesExtra`）。
 * @param {Record<string,string|undefined>} [env]
 * @param {{ pruneStaleBundles?: string, pruneBundlesExtra?: string|string[] }} [persisted]
 * @returns {{ mode: 'off'|'known'|'all', extraNames: string[] }}
 */
function resolvePruneConfig(env = process.env, persisted = {}) {
  const envRaw = env.DSH_PRUNE_STALE_BUNDLES;
  const persistedRaw = persisted && persisted.pruneStaleBundles;
  let mode;
  if (envRaw !== undefined && String(envRaw).trim() !== '') {
    mode = pruneMode({ DSH_PRUNE_STALE_BUNDLES: envRaw });
  } else if (persistedRaw !== undefined && String(persistedRaw).trim() !== '') {
    mode = pruneMode({ DSH_PRUNE_STALE_BUNDLES: persistedRaw });
  } else {
    mode = 'known';
  }
  const extraNames = [...new Set([
    ...parseExtraList(env.DSH_PRUNE_BUNDLES_EXTRA),
    ...parseExtraList(persisted && persisted.pruneBundlesExtra)
  ])];
  return { mode, extraNames };
}

/**
 * 剔除 profile manifest 中无法解析的幽灵 bundle 条目（原地修改 `pkg`）。
 * @param {any} pkg profile 的 package.json 对象
 * @param {{ profileDir: string, mode?: 'off'|'known'|'all', installAnchors?: string[], protectedNames?: string[], knownRemoved?: string[], extraNames?: string[] }} opts
 * @returns {{ pruned: string[], declared: string[], mode: string }}
 *          pruned=已剔除的幽灵条目；declared=命中候选但已声明为依赖、被保留的条目
 */
function pruneStaleBundles(pkg, opts = {}) {
  const profileDir = opts.profileDir;
  if (!profileDir) throw new Error('pruneStaleBundles: profileDir is required');
  const mode = opts.mode || 'known';
  if (mode === 'off') return { pruned: [], declared: [], mode };

  const protectedNames = new Set(opts.protectedNames || DEFAULT_PROTECTED_BUNDLES);
  const installAnchors = opts.installAnchors || defaultInstallAnchors();
  const knownRemoved = new Set([...(opts.knownRemoved || KNOWN_REMOVED_BUNDLES), ...(opts.extraNames || [])]);

  const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
  if (!Array.isArray(bundles) || bundles.length === 0) return { pruned: [], declared: [], mode };

  const declared = declaredNames(pkg);
  const pruned = [];
  const keptDeclared = [];
  const next = [];

  for (const name of bundles) {
    if (typeof name !== 'string' || name === '') { next.push(name); continue; }
    if (protectedNames.has(name)) { next.push(name); continue; }
    // 保守模式只处理已知下线清单；激进模式处理任意条目。
    if (mode !== 'all' && !knownRemoved.has(name)) { next.push(name); continue; }
    if (isBundleResolvable(name, profileDir, installAnchors)) { next.push(name); continue; }
    if (declared.has(name)) { keptDeclared.push(name); next.push(name); continue; }
    pruned.push(name);
  }

  if (pruned.length > 0) pkg.dsh.profile.bundles = next;
  return { pruned, declared: keptDeclared, mode };
}

module.exports = {
  pruneStaleBundles,
  isBundleResolvable,
  packageDirFromAnchor,
  defaultInstallAnchors,
  pruneMode,
  extraRemovedNames,
  parseExtraList,
  resolvePruneConfig,
  declaredNames,
  DEFAULT_PROTECTED_BUNDLES,
  KNOWN_REMOVED_BUNDLES
};
