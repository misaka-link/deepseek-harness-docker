'use strict';
/**
 * rollback-slot.js — 容器层受保护单槽位就地回滚点治理。
 *
 * v1.0.0 增强：
 *   - 若回滚点内的 DSH 版本低于 ENGINE_FLOOR (0.2.3-alpha.2) 或处于 danger 级，
 *     标记 canRestore = false 并给出 unsupportedReason，防止回退到不兼容旧引擎。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  getLiveCoreParent,
  getRollbackPreservedDir,
  moveDirOrCopy,
  restoreCoreFromBackup,
  readReadyMarker,
  writeReadyMarker,
  dirSizeBytes,
  formatBytes
} = require('./version-store');
const versionService = require('./version-service');

function promoteToPreservedRollback(tmpDir, version = '') {
  const preservedDir = getRollbackPreservedDir();
  const coreParent = getLiveCoreParent();
  if (!tmpDir || !fs.existsSync(tmpDir)) return;
  if (path.resolve(tmpDir) === path.resolve(preservedDir)) return;

  let ver = version;
  if (!ver) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8'));
      ver = pkg.version || '';
    } catch {}
  }

  try {
    writeReadyMarker(tmpDir, ver || 'unknown');
  } catch (e) {
    console.warn(`[rollback-slot] 回滚点元数据写入跳过: ${e.message}`);
  }

  const oldPreserved = path.join(coreParent, `.dsh-rollback-old-${process.pid}-${Date.now()}`);
  let movedOld = false;

  if (fs.existsSync(preservedDir)) {
    try {
      moveDirOrCopy(preservedDir, oldPreserved);
      movedOld = true;
    } catch (e) {
      console.warn(`[rollback-slot] 暂存旧回滚点备件失败: ${e.message}`);
    }
  }

  try {
    moveDirOrCopy(tmpDir, preservedDir);
    if (movedOld && fs.existsSync(oldPreserved)) {
      try { fs.rmSync(oldPreserved, { recursive: true, force: true }); } catch {}
    }
  } catch (err) {
    if (movedOld && fs.existsSync(oldPreserved) && !fs.existsSync(preservedDir)) {
      try { moveDirOrCopy(oldPreserved, preservedDir); } catch {}
    }
    throw new Error(`回滚点提升至受保护槽位失败: ${err.message}`);
  }
}

function disposeRollbackDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[rollback-slot] 清理临时回滚点失败: ${e.message}`);
  }
}

function restoreFromRollbackDir(dir) {
  if (!dir || !fs.existsSync(dir)) throw new Error('回滚点不存在，无法还原');
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error('回滚点目录不完整（缺失 package.json），无法还原');
  }
  const marker = readReadyMarker(dir);
  if (marker) {
    if (marker.nodeAbi && String(marker.nodeAbi) !== String(process.versions.modules)) {
      const err = new Error(`回滚点 Node ABI (${marker.nodeAbi}) 与当前运行环境 (${process.versions.modules}) 不匹配，已拒绝还原`);
      err.errorCode = 'ROLLBACK_ABI_MISMATCH';
      err.params = { expected: String(process.versions.modules), actual: String(marker.nodeAbi) };
      throw err;
    }
    if (marker.arch && marker.arch !== process.arch) {
      const err = new Error(`回滚点系统架构 (${marker.arch}) 与当前运行环境 (${process.arch}) 不匹配，已拒绝还原`);
      err.errorCode = 'ROLLBACK_ABI_MISMATCH';
      err.params = { expected: process.arch, actual: marker.arch };
      throw err;
    }
  }
  restoreCoreFromBackup(dir);
}

function getRollbackPoint(installing = false) {
  const p = getRollbackPreservedDir();
  if (!fs.existsSync(p)) {
    return {
      exists: false,
      version: null,
      sizeBytes: 0,
      sizeFormatted: '0 B',
      createdAt: null,
      nodeAbi: null,
      abiMatches: false,
      supported: false,
      compat: null,
      path: p,
      canRestore: false
    };
  }

  let version = null;
  const pkgPath = path.join(p, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      version = pkg.version || null;
    } catch {}
  }

  const marker = readReadyMarker(p);
  if (marker && marker.version) {
    version = marker.version;
  }

  const currentAbi = String(process.versions.modules);
  const currentArch = process.arch;
  const nodeAbi = marker && marker.nodeAbi ? String(marker.nodeAbi) : currentAbi;
  const arch = marker && marker.arch ? marker.arch : currentArch;
  const abiMatches = (nodeAbi === currentAbi) && (arch === currentArch);

  let sizeBytes = 0;
  if (marker && typeof marker.sizeBytes === 'number' && marker.sizeBytes > 0) {
    sizeBytes = marker.sizeBytes;
  } else {
    try { sizeBytes = dirSizeBytes(p); } catch {}
  }

  let createdAt = null;
  if (marker && marker.createdAt) {
    createdAt = marker.createdAt;
  } else {
    try {
      const st = fs.statSync(p);
      createdAt = new Date(st.mtimeMs).toISOString();
    } catch {}
  }

  const compat = version ? versionService.evaluateTargetVersion(version) : null;
  const supported = Boolean(compat && compat.level !== 'danger');
  const hasPkg = fs.existsSync(pkgPath);
  const canRestore = !installing && abiMatches && hasPkg && supported;

  return {
    exists: true,
    version,
    sizeBytes,
    sizeFormatted: formatBytes(sizeBytes),
    createdAt,
    nodeAbi,
    abiMatches,
    supported,
    compat,
    path: p,
    canRestore
  };
}

function deleteRollbackPoint(installing = false) {
  if (installing) {
    return { ok: false, errorCode: 'ROLLBACK_BUSY', error: '版本切换或还原进行中，已拒绝并发删除' };
  }
  const p = getRollbackPreservedDir();
  if (!fs.existsSync(p)) {
    return { ok: false, errorCode: 'ROLLBACK_NOT_FOUND', error: '回滚点不存在或已被清理' };
  }
  const point = getRollbackPoint(installing);
  const freedBytes = point.sizeBytes || dirSizeBytes(p);
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return { ok: true, freedBytes, path: p };
  } catch (err) {
    return { ok: false, error: `清理回滚点失败: ${err.message}` };
  }
}

module.exports = {
  promoteToPreservedRollback,
  disposeRollbackDir,
  restoreFromRollbackDir,
  getRollbackPoint,
  deleteRollbackPoint
};
