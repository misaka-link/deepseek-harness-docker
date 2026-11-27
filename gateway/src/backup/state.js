'use strict';
/**
 * state.js — 快照服务共享任务互斥状态与版本/路径解析辅助函数。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../core/paths');
const { resolveProjectVersion } = require('../core/project-version');

const state = {
  activeTask: null,       // { type: 'backup'|'restore'|'import', label: string, startedAt: number }
  currentBackupJob: null  // { id, label, status, startedAt, finishedAt, durationMs, filename, tmpPath, sizeBytes, error }
};

function isBusy() {
  return state.activeTask !== null;
}

function getActiveTask() {
  return state.activeTask;
}

function sanitizeName(name) {
  return (name || 'manual').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 50);
}

function getCurrentDshVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json', 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {}
  const candidates = [
    process.env.DSH_VERSION_JSON,
    path.join(__dirname, '../../../version.json'),
    '/app/version.json'
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const vMeta = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (vMeta?.supply?.dshVersion) return vMeta.supply.dshVersion;
    } catch {}
  }
  return null;
}

function getCurrentProjectVersion() {
  return resolveProjectVersion();
}

/**
 * 解析快照文件路径：优先主快照目录，若 DSH_HOME != /root 则只读发现 legacy /root/.dsh-snapshots。
 * @param {string} filename
 * @returns {{ filePath: string, dir: string, legacy: boolean } | null}
 */
function resolveSnapshotLocation(filename) {
  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    return null;
  }
  const primaryDir = paths.getSnapshotsDir();
  const primaryPath = path.join(primaryDir, safeFilename);
  if (fs.existsSync(primaryPath)) {
    return { filePath: primaryPath, dir: primaryDir, legacy: false };
  }
  const legacyDir = paths.LEGACY_ROOT_SNAPSHOTS_DIR;
  if (legacyDir && path.resolve(legacyDir) !== path.resolve(primaryDir)) {
    const legacyPath = path.join(legacyDir, safeFilename);
    if (fs.existsSync(legacyPath)) {
      return { filePath: legacyPath, dir: legacyDir, legacy: true };
    }
  }
  return null;
}

module.exports = {
  state,
  isBusy,
  getActiveTask,
  sanitizeName,
  getCurrentDshVersion,
  getCurrentProjectVersion,
  resolveSnapshotLocation
};
