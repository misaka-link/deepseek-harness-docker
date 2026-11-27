'use strict';
/**
 * version-store.js — 持久化引擎版本库管理与核心目录原子置换原语。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const paths = require('../core/paths');
const { isValidVersion, resolveWithinDir } = require('./dsh-version');
const { ENGINE_FLOOR } = require('./compat-policy');

const READY_FILE = '.ready';
const GC_KEEP_DEFAULT = Number(process.env.DSH_VERSIONS_KEEP) || 3;
const MIN_FREE_BYTES = Math.max(64, Number(process.env.DSH_VERSIONS_MIN_FREE_MB) || 1536) * 1024 * 1024;

function getLiveCoreParent() {
  return process.env.DSH_TEST_CORE_PARENT || '/usr/local/lib/node_modules/@deepseek-ai';
}

function getLiveCoreDir() {
  return path.join(getLiveCoreParent(), 'dsh');
}

function getDshBinLink() {
  return process.env.DSH_TEST_BIN_LINK || '/usr/local/bin/dsh';
}

function getRollbackPreservedDir() {
  return path.join(getLiveCoreParent(), '.dsh-rollback-preserved');
}

function getStoreStagingDir() {
  return path.join(paths.getVersionsDir(), '.staging');
}

function readLocalSupplyMeta() {
  const candidates = [
    process.env.DSH_VERSION_JSON,
    path.join(__dirname, '../../../version.json'),
    '/app/version.json'
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  return null;
}

const LOCAL_META = readLocalSupplyMeta();
const FALLBACK_DSH_VERSION = (LOCAL_META && LOCAL_META.supply && LOCAL_META.supply.dshVersion) || ENGINE_FLOOR;
const IMAGE_REVISION = (() => {
  const p = (LOCAL_META && LOCAL_META.latest && LOCAL_META.latest.version) || 'unknown';
  const d = (LOCAL_META && LOCAL_META.supply && LOCAL_META.supply.dshVersion) || ENGINE_FLOOR;
  return `proj${p}-dsh${d}`;
})();

function runSyncSafe(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (res.error) throw new Error(`执行 ${cmd} 失败: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim().slice(0, 300);
    throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} … 退出码 ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res;
}

function isNonEmptyDir(p) {
  try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0; } catch { return false; }
}

function moveDirOrCopy(src, dst) {
  try {
    fs.renameSync(src, dst);
    return 'rename';
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.mkdirSync(dst, { recursive: true });
    runSyncSafe('cp', ['-a', src + '/.', dst + '/']);
    runSyncSafe('rm', ['-rf', src]);
    return 'copy';
  }
}

function restoreCoreFromBackup(backupDir) {
  if (!fs.existsSync(backupDir)) throw new Error('回滚点不存在，无法还原');
  const liveDir = getLiveCoreDir();
  try { fs.rmSync(liveDir, { recursive: true, force: true }); } catch {}
  moveDirOrCopy(backupDir, liveDir);
}

function measureDir(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { files++; try { bytes += fs.statSync(p).size; } catch {} }
    }
  }
  return { files, bytes };
}

function readReadyMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, READY_FILE), 'utf8'));
    return (m && typeof m === 'object') ? m : null;
  } catch { return null; }
}

function isReadyVersionDir(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'package.json'))) return false;
  const marker = readReadyMarker(dir);
  if (!marker) return false;
  if (marker.nodeAbi && String(marker.nodeAbi) !== String(process.versions.modules)) return false;
  if (marker.arch && marker.arch !== process.arch) return false;
  return isNonEmptyDir(path.join(dir, 'node_modules'));
}

function writeReadyMarker(dir, version) {
  const { files, bytes } = measureDir(dir);
  const marker = {
    version,
    nodeAbi: process.versions.modules,
    nodeVersion: process.versions.node,
    arch: process.arch,
    imageRevision: IMAGE_REVISION,
    fileCount: files,
    sizeBytes: bytes,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, READY_FILE), JSON.stringify(marker, null, 2));
  return marker;
}

function dirSizeBytes(dir) {
  return measureDir(dir).bytes;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '未知';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024).toFixed(0) + ' KB';
}

function isMountedPath(p) {
  try {
    const info = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    return info.split('\n').some((line) => {
      const mp = (line.split(' ')[4] || '');
      return mp && mp !== '/' && (p === mp || p.startsWith(mp.endsWith('/') ? mp : mp + '/'));
    });
  } catch { return false; }
}

function listStoreEntries(versionsDir = paths.getVersionsDir()) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(versionsDir); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(versionsDir, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    out.push({
      version: name,
      dir,
      ready: isReadyVersionDir(dir),
      marker: readReadyMarker(dir),
      mtimeMs: st.mtimeMs,
      sizeBytes: dirSizeBytes(dir)
    });
  }
  return out;
}

function touchVersionUsage(versionsDir, version) {
  try {
    const dir = resolveWithinDir(versionsDir, version);
    const now = new Date();
    fs.utimesSync(dir, now, now);
  } catch {}
}

function atomicSwapCore(stagingDirPath) {
  const coreParent = getLiveCoreParent();
  const liveDir = getLiveCoreDir();
  const binLink = getDshBinLink();
  const backupDir = path.join(coreParent, `.dsh-rollback-tmp-${process.pid}-${Date.now()}`);
  let moved = false;

  if (fs.existsSync(liveDir)) {
    try {
      moveDirOrCopy(liveDir, backupDir);
    } catch (e) {
      const err = new Error(`核心目录置换失败（无法暂存原核心）: ${e.message}`);
      if (fs.existsSync(backupDir)) err.rollbackDir = backupDir;
      throw err;
    }
    moved = true;
  }

  try {
    fs.renameSync(stagingDirPath, liveDir);
  } catch (e) {
    if (moved) {
      try { restoreCoreFromBackup(backupDir); }
      catch (err) { console.error('[dsh-store] 还原原核心失败:', err.message); }
    }
    throw new Error(`核心目录置换失败（已尝试还原原核心）: ${e.message}`);
  }

  try {
    runSyncSafe('ln', ['-sfn', path.join(liveDir, 'lib/bin.js'), binLink]);
  } catch (e) {
    console.warn(`[dsh-store] dsh 软链刷新跳过: ${e.message}`);
  }

  return moved ? backupDir : null;
}

function assertDiskSpace(targetPaths, needBytes, log = () => {}, getRollbackPointFn = null) {
  for (const p of targetPaths) {
    try {
      const st = fs.statfsSync(p);
      const free = st.bavail * st.bsize;
      if (free < needBytes) {
        let hint = '（可先到快照面板清理回滚点释放空间）';
        try {
          const rb = typeof getRollbackPointFn === 'function' ? getRollbackPointFn() : null;
          if (rb && rb.exists && rb.sizeFormatted) {
            hint = `（可先清理回滚点释放 ${rb.sizeFormatted} 空间）`;
          }
        } catch {}
        const err = new Error(`磁盘空间不足：${p} 可用 ${formatBytes(free)}，切换至少需要 ${formatBytes(needBytes)}${hint}`);
        err.errorCode = 'DSH_DISK_LOW';
        err.params = { needMB: Math.ceil(needBytes / (1024 * 1024)), freeMB: Math.floor(free / (1024 * 1024)) };
        throw err;
      }
      log(`✔ 磁盘水位检查通过 ${p}: 可用 ${formatBytes(free)}`);
    } catch (e) {
      if (e && (e.errorCode === 'DSH_DISK_LOW' || /磁盘空间不足/.test(e.message))) throw e;
      log(`ℹ️ 跳过磁盘水位检查 ${p}: ${e.message}`);
    }
  }
}

function cleanupStagingOrphans(versionsDir = paths.getVersionsDir(), maxAgeMs = 3600 * 1000) {
  const now = Date.now();
  const storeStaging = path.join(versionsDir, '.staging');
  const coreParent = getLiveCoreParent();
  for (const dir of [storeStaging, coreParent]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name === '.dsh-rollback-preserved') continue;
      const isStoreStaging = dir === storeStaging;
      if (!isStoreStaging && !/^\.dsh-(staging|rollback)-/.test(name)) continue;
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs < maxAgeMs) continue;
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`[dsh-store] 已清理过期残留: ${p}`);
      } catch {}
    }
  }
}

function deleteCachedVersion({ versionsDir, version, activeVersion, installing }) {
  if (installing) {
    return { ok: false, errorCode: 'DSH_BUSY_INSTALLING', error: '版本切换进行中，已拒绝并发删除' };
  }
  if (!isValidVersion(version)) {
    return { ok: false, errorCode: 'DSH_VERSION_INVALID', params: { version }, error: '版本号格式不合法' };
  }
  if (version === activeVersion) {
    return { ok: false, errorCode: 'DSH_VERSION_PINNED', params: { version }, error: `版本 ${version} 正在运行，禁止删除` };
  }
  if (version === FALLBACK_DSH_VERSION) {
    return { ok: false, errorCode: 'DSH_VERSION_PINNED', params: { version }, error: `版本 ${version} 为镜像出厂基准版本，禁止删除` };
  }
  let dir;
  try {
    dir = resolveWithinDir(versionsDir, version);
  } catch (e) {
    return { ok: false, errorCode: 'DSH_VERSION_INVALID', params: { version }, error: e.message };
  }
  if (!fs.existsSync(dir)) {
    return { ok: false, errorCode: 'NOT_FOUND', error: `版本库中不存在版本 ${version}` };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, version, dir };
}

module.exports = {
  READY_FILE,
  GC_KEEP_DEFAULT,
  MIN_FREE_BYTES,
  FALLBACK_DSH_VERSION,
  IMAGE_REVISION,
  getLiveCoreParent,
  getLiveCoreDir,
  getDshBinLink,
  getRollbackPreservedDir,
  getStoreStagingDir,
  runSyncSafe,
  isNonEmptyDir,
  moveDirOrCopy,
  restoreCoreFromBackup,
  measureDir,
  readReadyMarker,
  isReadyVersionDir,
  writeReadyMarker,
  dirSizeBytes,
  formatBytes,
  isMountedPath,
  listStoreEntries,
  touchVersionUsage,
  atomicSwapCore,
  assertDiskSpace,
  cleanupStagingOrphans,
  deleteCachedVersion
};
