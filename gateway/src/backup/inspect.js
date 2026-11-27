'use strict';
/**
 * inspect.js — 快照列表、只读检视（含 Schema 1 识别）、流式导入与删除。
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const paths = require('../core/paths');
const {
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  hasPigz,
  buildTarEnv,
  verifyGzipMagic,
  validateArchiveMembers
} = require('./archive-validate');
const {
  CONFIG_SCHEMA,
  CONFIG_MODEL_LABEL,
  readSidecar,
  writeSidecarAtomic,
  removeSidecar,
  inspectArchive
} = require('./snapshot-manifest');
const {
  state,
  getActiveTask,
  sanitizeName,
  resolveSnapshotLocation
} = require('./state');
const { getBackupJob } = require('./create-job');

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/**
 * 流式扫描快照归档内容：
 *   - 判定是否含会话 (.dsh/sessions) 与附件 (.dsh/attachments)
 *   - 同时探测 Schema 1 (settings.yaml) 与 Schema 2 (cordis.patch.yml / settings.yaml.imported)
 *   - 统一剥离前导 './' 兼容 `./.dsh/...` 归档
 */
function scanArchiveContents(archivePath) {
  return new Promise((resolve, reject) => {
    let hasSessions = false;
    let hasAttachments = false;
    let hasSettingsYaml = false;
    let hasSettingsImported = false;
    let hasCordisPatchYml = false;

    const isMultiThread = hasPigz();
    const args = isMultiThread ? ['-I', 'pigz', '-tf', archivePath] : ['-tzf', archivePath];
    const proc = spawn('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildTarEnv({ LC_ALL: 'C', LANG: 'C', LANGUAGE: '' })
    });
    const rl = readline.createInterface({ input: proc.stdout });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      try { proc.kill('SIGTERM'); } catch {}
      resolve({
        hasSessions,
        hasAttachments,
        hasSettingsYaml,
        hasSettingsImported,
        hasCordisPatchYml
      });
    };

    rl.on('line', (rawLine) => {
      const line = rawLine.trim().replace(/^\.\//, '').replace(/\/+$/, '');
      if (line === '.dsh/sessions' || line.startsWith('.dsh/sessions/')) hasSessions = true;
      if (line === '.dsh/attachments' || line.startsWith('.dsh/attachments/')) hasAttachments = true;
      if (line === '.dsh/settings.yaml') hasSettingsYaml = true;
      if (line === '.dsh/settings.yaml.imported') hasSettingsImported = true;
      if (line === '.dsh/cordis.patch.yml' || /^\.dsh\/profiles\/[^/]+\/cordis\.patch\.yml$/.test(line)) {
        hasCordisPatchYml = true;
      }
      if (hasSessions && hasAttachments && (hasCordisPatchYml || hasSettingsImported)) {
        finish();
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      reject(err);
    });

    proc.on('close', () => {
      if (!settled) {
        settled = true;
        try { rl.close(); } catch {}
        resolve({
          hasSessions,
          hasAttachments,
          hasSettingsYaml,
          hasSettingsImported,
          hasCordisPatchYml
        });
      }
    });
  });
}

function countCurrentSessions(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      if (ent.name.startsWith('session-')) {
        count++;
        continue;
      }
      const subDir = path.join(sessionsDir, ent.name);
      try {
        const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
        for (const subEnt of subEntries) {
          if (!subEnt.isDirectory() || subEnt.name.startsWith('.')) continue;
          count++;
        }
      } catch {}
    }
  } catch {}
  return count;
}

function inferBackupTypeFromFilename(filename) {
  // 按前缀匹配，避免误命中 imported_dsh-config-...
  return filename.startsWith('dsh-config-') ? 'config' : 'full';
}

function readBackupsFromDir(dir, { legacyLocation = false } = {}) {
  if (!dir || !fs.existsSync(dir)) return [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz') && !f.startsWith('.'));
  } catch {
    return [];
  }

  return files.map((filename) => {
    try {
      const filePath = path.join(dir, filename);
      const stat = fs.statSync(filePath);
      let backupType = null;
      let dshVersion = null;
      let projectVersion = null;
      let configModel = null;
      let schemaVersion = null;
      try {
        const sc = readSidecar(dir, filename);
        if (sc && sc.meta) {
          dshVersion = sc.meta.dshVersion || null;
          projectVersion = sc.meta.projectVersion || sc.meta.dockerSuiteVersion || null;
          configModel = sc.meta.configModel || null;
          schemaVersion = sc.meta.schemaVersion ?? null;
          if (sc.meta.backupType) {
            backupType = sc.meta.backupType;
          }
        }
      } catch {}
      if (!backupType) {
        backupType = inferBackupTypeFromFilename(filename);
      }
      const isConfig = backupType === 'config';
      return {
        filename,
        type: isConfig ? 'config' : 'full',
        typeLabel: isConfig ? '仅配置 (无会话)' : '完整备份',
        sizeBytes: stat.size,
        sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
        createdAt: stat.mtime.toISOString(),
        dshVersion,
        projectVersion,
        configModel,
        schemaVersion,
        legacySettingsWarning: schemaVersion === CONFIG_SCHEMA.SETTINGS_FILE,
        ...(legacyLocation ? { legacyLocation: true } : {})
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function listBackups() {
  try {
    const primaryDir = paths.getSnapshotsDir();
    try { fs.mkdirSync(primaryDir, { recursive: true }); } catch {}

    const primaryList = readBackupsFromDir(primaryDir, { legacyLocation: false });
    const seenNames = new Set(primaryList.map((item) => item.filename));

    // DSH_HOME != /root 时，只读合并展示 legacy /root/.dsh-snapshots 中的历史快照
    const legacyDir = paths.LEGACY_ROOT_SNAPSHOTS_DIR;
    const merged = [...primaryList];
    if (legacyDir && path.resolve(legacyDir) !== path.resolve(primaryDir)) {
      for (const item of readBackupsFromDir(legacyDir, { legacyLocation: true })) {
        if (!seenNames.has(item.filename)) {
          merged.push(item);
          seenNames.add(item.filename);
        }
      }
    }

    merged.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return {
      ok: true,
      snapshots: merged,
      activeTask: getActiveTask(),
      job: getBackupJob(),
      snapshotTimeoutMs: DEFAULT_SNAPSHOT_TIMEOUT_MS
    };
  } catch (err) {
    return { ok: false, error: err.message, snapshots: [], activeTask: getActiveTask() };
  }
}

async function inspectSnapshot(filename) {
  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    return { ok: false, errorCode: 'SNAPSHOT_INVALID_NAME', error: '非法快照文件名' };
  }
  const loc = resolveSnapshotLocation(safeFilename);
  if (!loc) {
    return {
      ok: false,
      errorCode: 'SNAPSHOT_NOT_FOUND',
      params: { file: safeFilename },
      error: '快照文件不存在: ' + safeFilename
    };
  }

  const filePath = loc.filePath;
  const targetDir = loc.dir;
  const scanned = await scanArchiveContents(filePath);
  const {
    hasSessions,
    hasAttachments,
    hasSettingsYaml,
    hasSettingsImported,
    hasCordisPatchYml
  } = scanned;
  const inferredBackupType = hasSessions ? 'full' : 'config';
  const sessionCount = countCurrentSessions(path.join(paths.getDshDir(), 'sessions'));

  let existingSidecar = null;
  try { existingSidecar = readSidecar(targetDir, safeFilename); } catch {}

  let schemaVersion = existingSidecar?.meta?.schemaVersion ?? null;
  let dshVersion = existingSidecar?.meta?.dshVersion || null;
  let projectVersion = existingSidecar?.meta?.projectVersion || existingSidecar?.meta?.dockerSuiteVersion || null;

  if (schemaVersion === null) {
    if (hasCordisPatchYml || hasSettingsImported) {
      schemaVersion = CONFIG_SCHEMA.PATCH_LAYER;
    } else if (hasSettingsYaml) {
      schemaVersion = CONFIG_SCHEMA.SETTINGS_FILE;
    }
  }

  const configModel = existingSidecar?.meta?.configModel || CONFIG_MODEL_LABEL[schemaVersion] || 'unknown';
  const legacySettingsWarning = schemaVersion === CONFIG_SCHEMA.SETTINGS_FILE;
  // 若 sidecar 已有明确 backupType，则保持它不被推断覆写
  const effectiveBackupType = existingSidecar?.meta?.backupType || inferredBackupType;

  // 若尚无 sidecar（且不在只读 legacy 位置），补写 sidecar；已有 sidecar 不覆写其 backupType
  if (!existingSidecar && !loc.legacy) {
    try {
      const stat = fs.statSync(filePath);
      writeSidecarAtomic(targetDir, safeFilename, {
        meta: {
          backupType: effectiveBackupType,
          schemaVersion,
          configModel,
          dshVersion,
          projectVersion,
          name: safeFilename.replace(/\.tar\.gz$/i, ''),
          createdAt: stat.mtime.toISOString()
        },
        archive: {
          sizeBytes: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs)
        }
      });
    } catch {}
  }

  return {
    ok: true,
    filename: safeFilename,
    hasSessions,
    hasAttachments,
    backupType: effectiveBackupType,
    schemaVersion,
    configModel,
    dshVersion,
    projectVersion,
    legacySettingsWarning,
    legacyLocation: loc.legacy,
    current: {
      sessionCount
    }
  };
}

function importBackupStream(req, rawFilename) {
  return new Promise((resolve, reject) => {
    Promise.resolve()
      .then(() => importBackupStreamImpl(req, rawFilename, resolve, reject))
      .catch(reject);
  });
}

async function importBackupStreamImpl(req, rawFilename, resolve, reject) {
  if (state.activeTask) {
    const err = new Error(`当前正在执行 ${state.activeTask.label} 操作，请稍候再试`);
    err.errorCode = 'SNAPSHOT_BUSY';
    err.code = 'BUSY';
    return reject(err);
  }

  const snapshotsDir = paths.getSnapshotsDir();
  try { fs.mkdirSync(snapshotsDir, { recursive: true }); } catch {}

  const origName = path.basename(rawFilename || 'imported-snapshot.tar.gz');
  const safeBase = sanitizeName(origName.replace(/\.tar\.gz$/i, ''));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `dsh-snapshot-${ts}-imported_${safeBase}.tar.gz`;
  const finalPath = path.join(snapshotsDir, filename);
  const tmpPath = path.join(snapshotsDir, `.${filename}.tmp`);

  state.activeTask = { type: 'import', label: '导入快照', startedAt: Date.now() };
  console.log(`[backup-service] 接收流式上传导入快照: ${filename}...`);

  let totalBytes = 0;
  let headerBytes = Buffer.alloc(0);
  let headerChecked = false;
  let aborted = false;

  const cleanup = () => {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    state.activeTask = null;
  };

  const outStream = fs.createWriteStream(tmpPath, { mode: 0o600 });
  outStream.on('error', (e) => {
    aborted = true;
    try { req.destroy(); } catch {}
    cleanup();
    reject(new Error('写入快照文件失败: ' + e.message));
  });

  req.on('data', (chunk) => {
    if (aborted) return;
    totalBytes += chunk.length;

    if (totalBytes > MAX_UPLOAD_BYTES) {
      aborted = true;
      req.destroy();
      outStream.destroy();
      cleanup();
      return reject(new Error('上传文件超过大小限制 (最大 300MB)'));
    }

    if (!headerChecked) {
      headerBytes = Buffer.concat([headerBytes, chunk]);
      if (headerBytes.length >= 2) {
        headerChecked = true;
        if (!verifyGzipMagic(headerBytes)) {
          aborted = true;
          req.destroy();
          outStream.destroy();
          cleanup();
          const err = new Error('无效的文件格式，仅支持 .tar.gz 压缩归档');
          err.errorCode = 'SNAPSHOT_NOT_GZIP';
          return reject(err);
        }
      }
    }

    outStream.write(chunk);
  });

  req.on('error', (err) => {
    aborted = true;
    outStream.destroy();
    cleanup();
    reject(err);
  });

  req.on('end', () => {
    if (aborted) return;
    outStream.end();
    outStream.on('finish', async () => {
      try {
        if (totalBytes < 100) {
          cleanup();
          const err = new Error('上传文件为空或数据不完整');
          err.errorCode = 'SNAPSHOT_EMPTY_ARCHIVE';
          return reject(err);
        }

        await validateArchiveMembers(tmpPath);
        try { fs.chmodSync(tmpPath, 0o600); } catch {}
        fs.renameSync(tmpPath, finalPath);
        const stat = fs.statSync(finalPath);
        console.log(`[backup-service] 成功导入快照: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

        inspectArchive(finalPath, { filename, snapshotsDir }).catch(() => {});

        resolve({
          ok: true,
          snapshot: {
            filename,
            sizeBytes: stat.size,
            sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
            createdAt: stat.mtime.toISOString(),
            name: safeBase
          }
        });
      } catch (verErr) {
        cleanup();
        reject(verErr);
      } finally {
        state.activeTask = null;
      }
    });
  });
}

function deleteBackup(filename) {
  try {
    const safeFilename = path.basename(filename || '');
    if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
      return { ok: false, errorCode: 'SNAPSHOT_INVALID_NAME', error: '非法文件名' };
    }
    const primaryDir = paths.getSnapshotsDir();
    const filePath = path.join(primaryDir, safeFilename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      try { removeSidecar(primaryDir, safeFilename); } catch {}
      return { ok: true };
    }
    return { ok: false, errorCode: 'SNAPSHOT_NOT_FOUND', params: { file: safeFilename }, error: '快照文件不存在' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getBackupPath(filename) {
  const loc = resolveSnapshotLocation(filename);
  return loc ? loc.filePath : null;
}

module.exports = {
  scanArchiveContents,
  countCurrentSessions,
  listBackups,
  inspectSnapshot,
  importBackupStream,
  deleteBackup,
  getBackupPath
};
