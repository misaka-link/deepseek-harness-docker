'use strict';
/**
 * 自动清理 profile 中「无法解析」的幽灵 bundle 条目。
 *
 * 存量数据卷从 0.1.x / 0.2.x 升级到 v1.0.0（DSH >= 0.2.3-alpha.2）时，
 * `dsh.profile.bundles` 可能残留上游已合并或退役的包名。本模块按官方
 * `dsh-app-boot` 的解析规则检查包是否可解析，并在默认保守模式下清理已知退役包，
 * 避免升级后反复输出 `skipping profile bundle` 告警。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/** 永远不清理的核心 bundle */
const DEFAULT_PROTECTED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app'
]);

/**
 * 已知被上游下线/改名的 bundle 与包清单（确保旧数据卷升级零告警）。
 */
const KNOWN_REMOVED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-experimental-agent-team-web-profile',
  '@deepseek-ai/dsh-settings-file',
  '@deepseek-ai/dsh-experimental-schedule-bundle',
  '@deepseek-ai/dsh-hook-protocol',
  '@deepseek-ai/dsh-hooks-claude-code',
  '@deepseek-ai/dsh-hooks-codex',
  '@deepseek-ai/dsh-webhook',
  '@deepseek-ai/dsh-webhook-github',
  '@deepseek-ai/dsh-subagent-in-process-driver',
  '@deepseek-ai/dsh-deepseek-account-platform',
  '@deepseek-ai/dsh-client-ui-settings-plugins'
]);

function defaultInstallAnchors(env = process.env) {
  const candidates = [
    env.DSH_INSTALL_ANCHOR,
    env.DSH_INSTALL_DIR ? path.join(env.DSH_INSTALL_DIR, 'lib/node_modules/@deepseek-ai/dsh/package.json') : null,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json'
  ];
  const anchors = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && !anchors.includes(candidate)) anchors.push(candidate);
    } catch {}
  }
  return anchors;
}

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

function isBundleResolvable(name, profileDir, installAnchors) {
  const anchors = [...(installAnchors || defaultInstallAnchors()), path.join(profileDir, 'package.json')];
  for (const anchor of anchors) {
    if (packageDirFromAnchor(anchor, name)) return true;
  }
  return false;
}

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

function pruneMode(env = process.env) {
  const value = String(env.DSH_PRUNE_STALE_BUNDLES ?? 'known').trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return 'off';
  if (value === 'all') return 'all';
  return 'known';
}

function parseExtraList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function extraRemovedNames(env = process.env) {
  return parseExtraList(env.DSH_PRUNE_BUNDLES_EXTRA);
}

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
