'use strict';
/**
 * create-job.js — 异步非阻塞快照创建与后台任务追踪。
 *
 * v1.0.0 修复：
 *   1) tar 打包源改为 `-C path.dirname(DSH_DIR) path.basename(DSH_DIR)`，彻底修复 DSH_HOME != /root 时
 *      误打包空 `/root/.dsh` 的缺陷；
 *   2) 打包排除 `.dsh/.dsh-meta`、`.dsh/.restore-staging`、`.dsh/.restore-rollback`；
 *   3) 打包后校验文件非空且归档成员数 > 0，并将快照文件权限设为 0600 后原子转正。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const paths = require('../core/paths');
const {
  DATA_ENTRIES,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  hasPigz,
  getPigzThreads,
  buildTarEnv,
  runTarAsync
} = require('./archive-validate');
const { writeSidecarAtomic } = require('./snapshot-manifest');
const {
  state,
  sanitizeName,
  getCurrentDshVersion,
  getCurrentProjectVersion
} = require('./state');

/** 快速验证归档至少包含 1 个有效成员（流式读到首个成员即提前结束 tar） */
function verifyArchiveNonEmpty(archivePath, usePigz) {
  return new Promise((resolve, reject) => {
    const args = usePigz ? ['-I', 'pigz', '-tf', archivePath] : ['-tzf', archivePath];
    const child = spawn('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildTarEnv({ LC_ALL: 'C', LANG: 'C', LANGUAGE: '' })
    });
    let found = false;
    let settled = false;
    let stderr = '';
    const finish = (ok, err) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      if (err) reject(err);
      else resolve(ok);
    };
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      if (chunk.toString('utf8').trim().length > 0) {
        found = true;
        finish(true);
      }
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 1024) stderr += d.toString('utf8');
    });
    child.on('error', (err) => finish(false, err));
    child.on('close', (code) => {
      if (settled) return;
      if (found) return finish(true);
      if (code !== 0) return finish(false, new Error(`归档校验失败 (exit=${code}): ${stderr.trim()}`));
      return finish(false);
    });
  });
}

async function createBackup(nameOrOpts = '', backupType = 'full') {
  if (state.activeTask) {
    const err = new Error(`当前正在执行 ${state.activeTask.label} 操作，请稍候再试`);
    err.errorCode = 'SNAPSHOT_BUSY';
    err.code = 'BUSY';
    throw err;
  }

  let name = '';
  let type = 'full';
  if (typeof nameOrOpts === 'object' && nameOrOpts !== null) {
    name = nameOrOpts.name || '';
    type = nameOrOpts.type || nameOrOpts.backupType || 'full';
  } else {
    name = nameOrOpts || '';
    type = backupType || 'full';
  }

  const snapshotsDir = paths.getSnapshotsDir();
  const dshDir = paths.getDshDir();
  try { fs.mkdirSync(snapshotsDir, { recursive: true }); } catch {}

  if (!fs.existsSync(dshDir)) {
    throw new Error(`DSH 数据目录不存在，无法创建快照: ${dshDir}`);
  }

  const isConfigOnly = type === 'config';
  const safeName = sanitizeName(name);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = isConfigOnly
    ? `dsh-config-${ts}-${safeName}.tar.gz`
    : `dsh-snapshot-${ts}-${safeName}.tar.gz`;
  const finalPath = path.join(snapshotsDir, filename);
  const tmpPath = path.join(snapshotsDir, `.${filename}.tmp`);

  const taskDesc = isConfigOnly ? '仅配置快照(无会话)' : '完整快照';
  state.activeTask = { type: 'backup', label: `创建${taskDesc}`, startedAt: Date.now() };

  if (state.currentBackupJob && state.currentBackupJob.status === 'running') {
    state.currentBackupJob.filename = filename;
    state.currentBackupJob.tmpPath = tmpPath;
  }

  console.log(`[backup-service] 开始异步创建${taskDesc}: ${filename} (源: ${dshDir})...`);

  try {
    const isMultiThread = hasPigz();
    if (isMultiThread) {
      console.log(`[backup-service] 检测到 pigz，已启用多线程并行压缩 (${getPigzThreads()} 线程)`);
    }

    const dshParent = path.dirname(dshDir);
    const dshBase = path.basename(dshDir);

    const tarArgs = [
      '--warning=no-file-changed',
      `--exclude=${dshBase}/.pnpm-store`,
      '--exclude=**/node_modules/.cache',
      `--exclude=${dshBase}/tmp`,
      `--exclude=${dshBase}/gateway.config.json`,
      `--exclude=${dshBase}/.dsh-meta`,
      `--exclude=${dshBase}/.restore-staging`,
      `--exclude=${dshBase}/.restore-rollback`
    ];

    if (isConfigOnly) {
      for (const entry of DATA_ENTRIES) {
        tarArgs.push(`--exclude=${dshBase}/${entry}`);
      }
    }

    // 若用户通过 DSH_DIR 把目录名改成了非 .dsh，打包时归档内仍统一为 .dsh/ 前缀
    if (dshBase !== '.dsh') {
      const escaped = dshBase.replace(/[\\,&]/g, '\\$&');
      tarArgs.push(`--transform=s,^${escaped},.dsh,`);
    }

    if (isMultiThread) {
      tarArgs.push('-I', 'pigz');
    } else {
      tarArgs.push('-z');
    }

    tarArgs.push('-cf', tmpPath, '-C', dshParent, dshBase);

    const res = await runTarAsync(tarArgs);
    if (res.code !== 0) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      throw new Error(`tar 打包失败 (exit=${res.code}): ${String(res.stderr || '').slice(0, 300)}`);
    }

    if (!fs.existsSync(tmpPath)) {
      throw new Error('快照文件未成功生成: ' + (res.stderr || 'tar 执行失败'));
    }

    const stat = fs.statSync(tmpPath);
    if (stat.size === 0) {
      try { fs.unlinkSync(tmpPath); } catch {}
      const err = new Error('生成的快照文件大小为 0，已被清理');
      err.errorCode = 'SNAPSHOT_EMPTY_ARCHIVE';
      throw err;
    }

    // 断言归档非空（成员数 > 0）
    const nonEmpty = await verifyArchiveNonEmpty(tmpPath, isMultiThread);
    if (!nonEmpty) {
      try { fs.unlinkSync(tmpPath); } catch {}
      const err = new Error('生成的快照归档内容为空，已被清理');
      err.errorCode = 'SNAPSHOT_EMPTY_ARCHIVE';
      throw err;
    }

    // 快照可能含敏感凭据，统一收敛权限为 0600
    try { fs.chmodSync(tmpPath, 0o600); } catch {}

    if (state.currentBackupJob && state.currentBackupJob.status === 'running') {
      state.currentBackupJob.sizeBytes = stat.size;
    }

    fs.renameSync(tmpPath, finalPath);
    console.log(`[backup-service] ${taskDesc}创建成功: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    const dshVersion = getCurrentDshVersion();
    const projectVersion = getCurrentProjectVersion();
    try {
      writeSidecarAtomic(snapshotsDir, filename, {
        meta: {
          dshVersion,
          projectVersion,
          dockerSuiteVersion: projectVersion,
          schemaVersion: 2,
          configModel: 'patch-layer',
          backupType: isConfigOnly ? 'config' : 'full',
          createdAt: stat.mtime.toISOString(),
          name: safeName
        },
        archive: {
          sizeBytes: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs)
        }
      });
    } catch (e) {
      console.warn('[backup-service] 写入快照元数据 sidecar 失败:', e.message);
    }

    return {
      ok: true,
      snapshot: {
        filename,
        type: isConfigOnly ? 'config' : 'full',
        typeLabel: isConfigOnly ? '仅配置 (无会话)' : '完整备份',
        sizeBytes: stat.size,
        sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
        createdAt: stat.mtime.toISOString(),
        dshVersion,
        projectVersion,
        name: safeName
      }
    };
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    console.error(`[backup-service] ${taskDesc}创建失败:`, err.message);
    throw err;
  } finally {
    state.activeTask = null;
  }
}

function startBackupJob(nameOrOpts = '', backupType = 'full') {
  if (state.activeTask) {
    return {
      ok: false,
      code: 'BUSY',
      errorCode: 'SNAPSHOT_BUSY',
      error: `当前正在执行「${state.activeTask.label}」任务，请稍候`
    };
  }

  let type = 'full';
  if (typeof nameOrOpts === 'object' && nameOrOpts !== null) {
    type = nameOrOpts.type || nameOrOpts.backupType || 'full';
  } else {
    type = backupType || 'full';
  }

  const isConfigOnly = type === 'config';
  const taskDesc = isConfigOnly ? '仅配置快照(无会话)' : '完整快照';
  const label = `创建${taskDesc}`;
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const startedAt = Date.now();

  const job = {
    id: jobId,
    label,
    status: 'running',
    startedAt,
    finishedAt: null,
    durationMs: 0,
    filename: null,
    tmpPath: null,
    sizeBytes: 0,
    error: null
  };
  state.currentBackupJob = job;

  console.log(`[backup-service] [${jobId}] 开始执行备份任务「${label}」...`);

  createBackup(nameOrOpts, backupType)
    .then((res) => {
      const durationMs = Date.now() - startedAt;
      job.status = 'success';
      job.finishedAt = Date.now();
      job.durationMs = durationMs;
      job.filename = res?.snapshot?.filename || job.filename;
      job.sizeBytes = res?.snapshot?.sizeBytes || 0;
      job.tmpPath = null;
      console.log(`[backup-service] [${jobId}] 备份任务执行成功: ${job.filename} (耗时: ${(durationMs / 1000).toFixed(1)}s)`);
    })
    .catch((err) => {
      const durationMs = Date.now() - startedAt;
      job.status = 'error';
      job.finishedAt = Date.now();
      job.durationMs = durationMs;
      job.error = (err?.message || String(err)).slice(0, 500);
      job.tmpPath = null;
      console.error(`[backup-service] [${jobId}] 备份任务执行失败: ${job.error}`);
    });

  return {
    ok: true,
    job: {
      id: job.id,
      label: job.label,
      status: job.status,
      startedAt: job.startedAt
    }
  };
}

function getBackupJob() {
  const job = state.currentBackupJob;
  if (!job) return null;

  let progressBytes = 0;
  if (job.status === 'running') {
    if (job.tmpPath) {
      try {
        if (fs.existsSync(job.tmpPath)) {
          progressBytes = fs.statSync(job.tmpPath).size || 0;
        } else if (job.sizeBytes > 0) {
          progressBytes = job.sizeBytes;
        }
      } catch {
        progressBytes = job.sizeBytes || 0;
      }
    } else if (job.sizeBytes > 0) {
      progressBytes = job.sizeBytes;
    }
  } else if (job.status === 'success') {
    progressBytes = job.sizeBytes || 0;
  }

  const elapsedMs = job.status === 'running'
    ? Math.max(0, Date.now() - job.startedAt)
    : (job.durationMs || 0);

  return {
    id: job.id,
    label: job.label,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    elapsedMs,
    durationMs: job.durationMs || elapsedMs,
    filename: job.filename,
    sizeBytes: job.sizeBytes,
    progressBytes,
    error: job.error,
    timeoutMs: DEFAULT_SNAPSHOT_TIMEOUT_MS
  };
}

module.exports = {
  createBackup,
  startBackupJob,
  getBackupJob
};
