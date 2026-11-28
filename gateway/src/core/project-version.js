'use strict';

/**
 * Single authoritative reader for the suite project version.
 *
 * Cross-validated resolution policy (Issue #19 + Issue #24):
 * 1. Image-baked files (`gateway/package.json#version`, then `version.json#latest.version`)
 *    define the immutable identity of the running container image.
 * 2. Build-time injected ENV (`DSH_SUITE_VERSION`) is cross-validated against the image-baked
 *    version before adoption: container recreation tools that clone `Config.Env` from an older
 *    container (e.g. dpanel / Portainer recreate) leave stale `DSH_SUITE_VERSION` values in the
 *    new container environment. When ENV disagrees with the image-baked version, ENV is flagged
 *    as `conflict: true`, ignored in favor of the image-baked version, and logged via `console.warn`.
 * 3. If both image-baked files are unavailable/unreadable, a valid `DSH_SUITE_VERSION` is still
 *    accepted as a last-resort fallback.
 *
 * Never fabricates a hardcoded fallback version: returns null when all sources are unavailable.
 */

const fs = require('fs');
const path = require('path');

const ENV_KEY = 'DSH_SUITE_VERSION';
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function normalize(value) {
  const s = String(value ?? '').trim();
  return s ? s.replace(/^v/, '') : '';
}

function isValidProjectVersion(value) {
  return SEMVER_RE.test(normalize(value));
}

const readFailureWarned = new Set();
function warnReadFailure(key, message) {
  if (readFailureWarned.has(key)) return;
  readFailureWarned.add(key);
  console.warn(message);
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    return normalize(pkg.version);
  } catch (e) {
    warnReadFailure('package.json', '[project-version] 读取 gateway/package.json 版本失败: ' + e.message);
    return '';
  }
}

function readVersionJsonLatest() {
  const candidates = [
    path.join(__dirname, '../../../version.json'),
    path.join(__dirname, '../../version.json'),
    '/app/version.json'
  ];
  for (const p of candidates) {
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = normalize(meta && meta.latest && meta.latest.version);
      if (v) return v;
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        warnReadFailure(p, '[project-version] 读取套件版本来源失败 (' + p + '): ' + e.message);
      }
    }
  }
  return '';
}

const SOURCES = [
  { source: 'env', label: '${DSH_SUITE_VERSION}', read: () => normalize(process.env[ENV_KEY]) },
  { source: 'package.json', label: 'gateway/package.json#version', read: readPackageVersion },
  { source: 'version.json', label: 'version.json#latest.version', read: readVersionJsonLatest }
];

let mismatchWarned = false;

function evaluateSources() {
  const rawEntries = SOURCES.map((item) => {
    let raw = '';
    try {
      raw = normalize(item.read());
    } catch {
      raw = '';
    }
    const valid = isValidProjectVersion(raw);
    return {
      source: item.source,
      label: item.label,
      raw,
      valid
    };
  });

  const envItem = rawEntries.find((e) => e.source === 'env');
  const pkgItem = rawEntries.find((e) => e.source === 'package.json' && e.valid);
  const verJsonItem = rawEntries.find((e) => e.source === 'version.json' && e.valid);
  const imageItem = pkgItem || verJsonItem || null;

  let resolved = null;
  if (imageItem) {
    // Cross-validate ENV against image-baked identity: if ENV matches imageItem, both equal imageItem.raw;
    // if ENV disagrees (stale cloned container Config.Env), downgrade to imageItem.raw.
    resolved = imageItem.raw;
  } else if (envItem && envItem.valid) {
    resolved = envItem.raw;
  }

  const sources = rawEntries.map((item) => {
    const adopted = Boolean(item.valid && resolved !== null && item.raw === resolved);
    const conflict = Boolean(item.valid && resolved !== null && item.raw !== resolved);
    return {
      source: item.source,
      label: item.label,
      raw: item.raw,
      valid: item.valid,
      adopted,
      conflict
    };
  });

  const versionMismatch = sources.some((s) => s.conflict);
  const envOut = sources.find((s) => s.source === 'env');
  const envConflict = Boolean(envOut && envOut.conflict);
  const envVersion = envOut && envOut.valid ? envOut.raw : null;
  const imageVersion = imageItem ? imageItem.raw : null;

  if (versionMismatch && !mismatchWarned) {
    mismatchWarned = true;
    const validSummary = sources
      .filter((s) => s.valid)
      .map((s) => `${s.source}=${s.raw}`)
      .join(' | ');
    if (envConflict && imageItem) {
      console.warn(
        `[project-version] 套件版本号来源不一致：容器环境变量 ${ENV_KEY}=${envOut.raw} 与镜像内 ${imageItem.source}=${imageItem.raw} 冲突` +
        `（常见于升级时克隆了旧容器配置），已忽略陈旧 ENV 并采用镜像内版本 ${resolved}；` +
        `建议执行 docker compose up -d --force-recreate 重建容器：${validSummary}`
      );
    } else {
      console.warn(
        `[project-version] 套件版本号来源不一致（已采用镜像内 ${imageItem ? imageItem.source : '权威源'} ${resolved}）：${validSummary}`
      );
    }
  }

  return {
    version: resolved,
    versionMismatch,
    envConflict,
    envVersion,
    imageVersion,
    sources
  };
}

/**
 * Resolve the suite project version.
 *
 * @returns {string|null} Valid semver string, or null if all sources are unavailable.
 */
function resolveProjectVersion() {
  const { version } = evaluateSources();
  if (!version) return null;
  return version;
}

/**
 * Diagnostic report of all version sources, conflict state, and the adopted value.
 *
 * @returns {{
 *   version: string|null,
 *   versionMismatch: boolean,
 *   envConflict: boolean,
 *   envVersion: string|null,
 *   imageVersion: string|null,
 *   sources: Array<{source: string, label: string, raw: string, valid: boolean, adopted: boolean, conflict: boolean}>
 * }}
 */
function describeProjectVersion() {
  return evaluateSources();
}

function resetWarnings() {
  mismatchWarned = false;
  readFailureWarned.clear();
}

module.exports = {
  ENV_KEY,
  isValidProjectVersion,
  resolveProjectVersion,
  describeProjectVersion,
  resetWarnings
};
