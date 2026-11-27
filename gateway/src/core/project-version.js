'use strict';

/**
 * Single authoritative reader for the suite project version.
 *
 * Resolution order:
 * 1. Build-time injected ENV (DSH_SUITE_VERSION)
 * 2. gateway/package.json#version (ONLY file in gateway/ allowed to read gateway/package.json)
 * 3. version.json#latest.version
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

/**
 * Resolve the suite project version.
 *
 * @returns {string|null} Valid semver string, or null if all sources are unavailable.
 */
function resolveProjectVersion() {
  const hits = [];
  for (const item of SOURCES) {
    let value = '';
    try {
      value = item.read();
    } catch {
      value = '';
    }
    if (isValidProjectVersion(value)) {
      hits.push({ source: item.source, version: normalize(value) });
    }
  }

  if (hits.length === 0) return null;

  if (!mismatchWarned) {
    const distinct = new Set(hits.map((h) => h.version));
    if (distinct.size > 1) {
      mismatchWarned = true;
      console.warn(
        '[project-version] 套件版本号来源不一致（已采用最高优先级 ' + hits[0].source + '）：' +
        hits.map((h) => `${h.source}=${h.version}`).join(' | ')
      );
    }
  }

  return hits[0].version;
}

/**
 * Diagnostic report of all version sources and the adopted value.
 *
 * @returns {{version: string|null, sources: Array<{source: string, label: string, raw: string, valid: boolean, adopted: boolean}>}}
 */
function describeProjectVersion() {
  const resolved = resolveProjectVersion();
  const sources = SOURCES.map((item) => {
    let raw = '';
    try {
      raw = item.read();
    } catch {
      raw = '';
    }
    const valid = isValidProjectVersion(raw);
    return {
      source: item.source,
      label: item.label,
      raw: normalize(raw),
      valid,
      adopted: valid && resolved !== null && normalize(raw) === resolved
    };
  });
  return { version: resolved, sources };
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
