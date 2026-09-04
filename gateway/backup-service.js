const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SNAPSHOTS_DIR = process.env.DSH_SNAPSHOTS_DIR || '/root/.dsh-snapshots';
const DSH_DIR = '/root/.dsh';
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300MB

try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch {}

let activeTask = null; // { type: 'backup'|'restore'|'import', label: string, startedAt: number }

function isBusy() {
  return activeTask !== null;
}

function getActiveTask() {
  return activeTask;
}

function sanitizeName(name) {
  return (name || 'manual').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 50);
}

function verifyGzipMagic(headerBuffer) {
  if (!headerBuffer || headerBuffer.length < 2) return false;
  return headerBuffer[0] === 0x1f && headerBuffer[1] === 0x8b;
}

function hasPigz() {
  try {
    const res = spawnSync('which', ['pigz'], { encoding: 'utf8' });
    return res.status === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 异步执行 tar 命令，完全解耦 Node.js 主事件循环
 */
function runTarAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString('utf8'));
    child.stderr.on('data', d => stderr += d.toString('utf8'));

    child.on('error', err => reject(err));
    child.on('close', code => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 校验 tar.gz 归档完整性
 */
async function testArchiveIntegrity(archivePath) {
  const res = await runTarAsync(['-tzf', archivePath]);
  if (res.code !== 0) {
    throw new Error('归档文件损坏或不是合法的 tar.gz 文件: ' + (res.stderr || '未知错误'));
  }
  return true;
}

/**
 * 异步非阻塞创建配置快照
 */
async function createBackup(name = '') {
  if (activeTask) {
    throw new Error(`当前正在执行 ${activeTask.label} 操作，请稍候再试`);
  }

  const safeName = sanitizeName(name);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `dsh-snapshot-${ts}-${safeName}.tar.gz`;
  const finalPath = path.join(SNAPSHOTS_DIR, filename);
  const tmpPath = path.join(SNAPSHOTS_DIR, `.${filename}.tmp`);

  activeTask = { type: 'backup', label: '创建快照', startedAt: Date.now() };

  console.log(`[backup-service] 开始异步创建快照: ${filename}...`);

  try {
    // 排除庞大且不影响配置的临时与缓存目录，极大提升打包速度
    const isMultiThread = hasPigz();
    if (isMultiThread) {
      console.log('[backup-service] 检测到 pigz，已启用全核心多线程并行压缩加速');
    }

    const tarArgs = [
      '--warning=no-file-changed',
      '--exclude=.dsh/.pnpm-store',
      '--exclude=**/node_modules/.cache',
      '--exclude=.dsh/tmp'
    ];

    if (isMultiThread) {
      tarArgs.push('-I', 'pigz');
    } else {
      tarArgs.push('-z');
    }

    tarArgs.push('-cf', tmpPath, '-C', '/root', '.dsh');

    const res = await runTarAsync(tarArgs);

    if (!fs.existsSync(tmpPath)) {
      throw new Error('快照文件未成功生成: ' + (res.stderr || 'tar 执行失败'));
    }

    const stat = fs.statSync(tmpPath);
    if (stat.size === 0) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new Error('生成的快照文件大小为 0，已被清理');
    }

    // 原子重命名
    fs.renameSync(tmpPath, finalPath);
    console.log(`[backup-service] 快照创建成功: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      ok: true,
      snapshot: {
        filename,
        sizeBytes: stat.size,
        sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
        createdAt: stat.mtime.toISOString(),
        name: safeName
      }
    };
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    console.error('[backup-service] 快照创建失败:', err.message);
    throw err;
  } finally {
    activeTask = null;
  }
}

/**
 * 异步非阻塞恢复配置快照
 */
async function restoreBackup(filename, dshManager) {
  if (activeTask) {
    throw new Error(`当前正在执行 ${activeTask.label} 操作，请稍候再试`);
  }

  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    throw new Error('非法快照文件名');
  }

  const snapshotPath = path.join(SNAPSHOTS_DIR, safeFilename);
  if (!fs.existsSync(snapshotPath)) {
    throw new Error('快照文件不存在: ' + safeFilename);
  }

  activeTask = { type: 'restore', label: '恢复快照', startedAt: Date.now() };
  console.log(`[backup-service] 开始安全还原快照: ${safeFilename}...`);

  try {
    // 1. 预先校验快照文件完整性，防损坏文件破坏现有环境
    await testArchiveIntegrity(snapshotPath);

    // 2. 优雅停止 DSH
    if (dshManager && typeof dshManager.stop === 'function') {
      await dshManager.stop();
    }

    // 3. 异步多线程/标准解压覆盖到 /root/.dsh
    const isMultiThread = hasPigz();
    const extractArgs = ['--warning=no-file-changed'];
    if (isMultiThread) {
      extractArgs.push('-I', 'pigz');
    } else {
      extractArgs.push('-z');
    }
    extractArgs.push('-xf', snapshotPath, '-C', '/root');
    const extractRes = await runTarAsync(extractArgs);
    if (extractRes.code !== 0) {
      throw new Error('tar 解压还原失败: ' + (extractRes.stderr || '未知错误'));
    }

    // 4. 执行权限自愈与补丁
    try {
      if (fs.existsSync(DSH_DIR)) fs.chmodSync(DSH_DIR, 0o700);
      const credPath = path.join(DSH_DIR, '.credentials.yaml');
      if (fs.existsSync(credPath)) fs.chmodSync(credPath, 0o600);
    } catch {}

    if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
      await new Promise(r => {
        const c = spawn('node', ['/app/scripts/install-plugin.mjs'], { stdio: 'ignore' });
        c.on('close', r);
      });
    }
    if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
      await new Promise(r => {
        const c = spawn('node', ['/app/scripts/patch-dsh-client.mjs'], { stdio: 'ignore' });
        c.on('close', r);
      });
    }

    // 5. 重新拉起 DSH
    let dshReady = false;
    if (dshManager && typeof dshManager.boot === 'function') {
      const bootRes = await dshManager.boot();
      dshReady = bootRes.ok;
    }

    console.log(`[backup-service] 快照 ${safeFilename} 还原完成，DSH 服务就绪状态: ${dshReady}`);
    return { ok: true, filename: safeFilename, dshReady };
  } catch (err) {
    console.error('[backup-service] 快照还原异常:', err.message);
    throw err;
  } finally {
    activeTask = null;
  }
}

/**
 * 异步流式接收导入快照文件 (.tar.gz)
 */
function importBackupStream(req, rawFilename) {
  return new Promise(async (resolve, reject) => {
    if (activeTask) {
      return reject(new Error(`当前正在执行 ${activeTask.label} 操作，请稍候再试`));
    }

    const origName = path.basename(rawFilename || 'imported-snapshot.tar.gz');
    const safeBase = sanitizeName(origName.replace(/\.tar\.gz$/i, ''));
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `dsh-snapshot-${ts}-imported_${safeBase}.tar.gz`;
    const finalPath = path.join(SNAPSHOTS_DIR, filename);
    const tmpPath = path.join(SNAPSHOTS_DIR, `.${filename}.tmp`);

    activeTask = { type: 'import', label: '导入快照', startedAt: Date.now() };
    console.log(`[backup-service] 接收流式上传导入快照: ${filename}...`);

    const outStream = fs.createWriteStream(tmpPath);
    let totalBytes = 0;
    let headerBytes = Buffer.alloc(0);
    let headerChecked = false;
    let aborted = false;

    const cleanup = () => {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      activeTask = null;
    };

    req.on('data', chunk => {
      if (aborted) return;
      totalBytes += chunk.length;

      // 检查大小上限
      if (totalBytes > MAX_UPLOAD_BYTES) {
        aborted = true;
        req.destroy();
        outStream.destroy();
        cleanup();
        return reject(new Error('上传文件超过大小限制 (最大 300MB)'));
      }

      // 快速检查 Gzip 魔数 (1f 8b)
      if (!headerChecked) {
        headerBytes = Buffer.concat([headerBytes, chunk]);
        if (headerBytes.length >= 2) {
          headerChecked = true;
          if (!verifyGzipMagic(headerBytes)) {
            aborted = true;
            req.destroy();
            outStream.destroy();
            cleanup();
            return reject(new Error('无效的文件格式，仅支持 .tar.gz 压缩归档'));
          }
        }
      }

      outStream.write(chunk);
    });

    req.on('error', err => {
      aborted = true;
      outStream.destroy();
      cleanup();
      reject(err);
    });

    req.on('end', async () => {
      if (aborted) return;
      outStream.end();
      outStream.on('finish', async () => {
        try {
          if (totalBytes < 100) {
            cleanup();
            return reject(new Error('上传文件为空或数据不完整'));
          }

          // 归档完整性二次校验
          await testArchiveIntegrity(tmpPath);

          // 原子更名转正
          fs.renameSync(tmpPath, finalPath);
          const stat = fs.statSync(finalPath);
          console.log(`[backup-service] 成功导入快照: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

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
          activeTask = null;
        }
      });
    });
  });
}

function listBackups() {
  try {
    const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.tar.gz') && !f.startsWith('.'));
    const list = files.map(filename => {
      try {
        const filePath = path.join(SNAPSHOTS_DIR, filename);
        const stat = fs.statSync(filePath);
        return {
          filename,
          sizeBytes: stat.size,
          sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
          createdAt: stat.mtime.toISOString()
        };
      } catch {
        return null;
      }
    }).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return {
      ok: true,
      snapshots: list,
      activeTask: getActiveTask()
    };
  } catch (err) {
    return { ok: false, error: err.message, snapshots: [], activeTask: getActiveTask() };
  }
}

function deleteBackup(filename) {
  try {
    const safeFilename = path.basename(filename || '');
    if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
      return { ok: false, error: '非法文件名' };
    }
    const filePath = path.join(SNAPSHOTS_DIR, safeFilename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { ok: true };
    }
    return { ok: false, error: '快照文件不存在' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getBackupPath(filename) {
  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    return null;
  }
  const filePath = path.join(SNAPSHOTS_DIR, safeFilename);
  return fs.existsSync(filePath) ? filePath : null;
}

module.exports = {
  createBackup,
  restoreBackup,
  importBackupStream,
  listBackups,
  deleteBackup,
  getBackupPath,
  getActiveTask,
  isBusy,
  SNAPSHOTS_DIR
};
