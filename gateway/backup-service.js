const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SNAPSHOTS_DIR = process.env.DSH_SNAPSHOTS_DIR || '/root/.dsh-snapshots';
// M11：支持通过 DSH_HOME 迁移运行根目录（非 root 部署时指向 /home/<user>）
const DSH_DIR = path.join(process.env.DSH_HOME || '/root', '.dsh');
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
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
  // 轻微项：加超时与输出上限 —— 坏归档可能让 tar 长时间挂住或吐出海量清单把内存打满
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10 * 60 * 1000;
  const maxOutputBytes = Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : 8 * 1024 * 1024;
  const spawnOptions = { ...options };
  delete spawnOptions.timeoutMs;
  delete spawnOptions.maxOutputBytes;

  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions
    });

    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`tar 执行超时（${Math.round(timeoutMs / 1000)}s）: tar ${args.join(' ')}`));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    const onData = (chunk, isErr) => {
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error('tar 输出超过上限（可能是恶意/损坏归档）'));
        return;
      }
      if (isErr) stderr += chunk.toString('utf8');
      else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', d => onData(d, false));
    child.stderr.on('data', d => onData(d, true));

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// 本服务创建的快照一律以 `tar -cf <file> -C /root .dsh` 打包，因此成员必须全部位于 `.dsh/` 之下。
const ALLOWED_ARCHIVE_PREFIX = '.dsh';
// 快照里 node_modules 下的软链会指向这些依赖安装位置（install-plugin.mjs / pnpm 产生），属合法目标
const ALLOWED_LINK_PREFIXES = [
  '/usr/local/lib/node_modules/',
  '/usr/lib/node_modules/',
  '/app/plugins/',
  '/app/node_modules/',
  '/opt/'
];

/**
 * 归档成员白名单校验（在解压/转正之前调用）。
 *
 * 阻断：绝对路径、`..` 段、超出 `.dsh/` 前缀的成员（如 `.ssh/authorized_keys`、`.bashrc`），
 * 以及符号链接 / 硬链接 / 设备 / FIFO 等非普通文件成员（防止解压时跟随链接写到目录外）。
 * 失败即抛错，调用方不会执行任何解压动作（fail-closed）。
 */
async function validateArchiveMembers(archivePath) {
  const res = await runTarAsync(['-tvzf', archivePath]);
  if (res.code !== 0) {
    throw new Error('归档文件损坏或不是合法的 tar.gz 文件: ' + (res.stderr || '未知错误'));
  }
  const lines = res.stdout.split('\n').map(l => l.replace(/\s+$/, '')).filter(Boolean);
  if (lines.length === 0) throw new Error('归档内容为空');

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) throw new Error(`无法解析归档成员: ${line.slice(0, 80)}`);
    const typeChar = parts[0][0];
    const rawName = parts.slice(5).join(' ');

    // 链接成员的 verbose 输出形如 `name -> target`
    let name = rawName;
    let linkTarget = null;
    const arrow = rawName.indexOf(' -> ');
    if (arrow >= 0) { name = rawName.slice(0, arrow); linkTarget = rawName.slice(arrow + 4); }

    // 1) 所有成员（含链接）都必须位于 .dsh/ 之下，且不含非法路径段
    const clean = name.replace(/\/+$/, '');
    if (clean !== ALLOWED_ARCHIVE_PREFIX && !clean.startsWith(ALLOWED_ARCHIVE_PREFIX + '/')) {
      throw new Error(`归档成员超出允许范围（仅允许 ${ALLOWED_ARCHIVE_PREFIX}/ 之下）: ${name.slice(0, 80)}`);
    }
    const segs = clean.split('/');
    if (segs.some(s => s === '..' || s === '.' || s === '')) {
      throw new Error(`归档成员包含非法路径段: ${name.slice(0, 80)}`);
    }

    // 2) 类型白名单：普通文件 / 目录 / 受控链接
    if (typeChar === 'l' || typeChar === 'h') {
      if (!linkTarget) throw new Error(`归档链接成员缺少目标: ${name.slice(0, 80)}`);
      const okTarget = linkTarget.startsWith('/')
        // 绝对目标：只允许指向本项目合法的依赖安装位置（快照里 node_modules 下的软链即如此）
        ? ALLOWED_LINK_PREFIXES.some(p => linkTarget.startsWith(p))
        // 相对目标：归一化后必须仍在 .dsh/ 之内
        : path.posix.normalize(path.posix.join(path.posix.dirname(name), linkTarget))
            .startsWith(ALLOWED_ARCHIVE_PREFIX + '/');
      if (!okTarget) {
        throw new Error(`归档包含指向不允许位置的链接成员: ${name.slice(0, 60)} -> ${String(linkTarget).slice(0, 60)}`);
      }
      continue;
    }
    if (typeChar !== '-' && typeChar !== 'd') {
      throw new Error(`归档包含不允许的成员类型 (${typeChar})，仅允许普通文件、目录与受控链接: ${name.slice(0, 80)}`);
    }
  }
  return { members: lines.length };
}

/**
 * 异步非阻塞创建配置快照
 * @param {string|object} nameOrOpts - 快照备注名或参数对象 { name, type }
 * @param {string} [backupType='full'] - 备份类型: 'full' (完整备份) 或 'config' (仅配置无会话)
 */
async function createBackup(nameOrOpts = '', backupType = 'full') {
  if (activeTask) {
    throw new Error(`当前正在执行 ${activeTask.label} 操作，请稍候再试`);
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

  const isConfigOnly = type === 'config';
  const safeName = sanitizeName(name);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = isConfigOnly
    ? `dsh-config-${ts}-${safeName}.tar.gz`
    : `dsh-snapshot-${ts}-${safeName}.tar.gz`;
  const finalPath = path.join(SNAPSHOTS_DIR, filename);
  const tmpPath = path.join(SNAPSHOTS_DIR, `.${filename}.tmp`);

  const taskDesc = isConfigOnly ? '仅配置快照(无会话)' : '完整快照';
  activeTask = { type: 'backup', label: `创建${taskDesc}`, startedAt: Date.now() };

  console.log(`[backup-service] 开始异步创建${taskDesc}: ${filename}...`);

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
      '--exclude=.dsh/tmp',
      '--exclude=.dsh/gateway.config.json'
    ];

    // 仅配置模式：完全排除所有对话会话历史、多媒体附件及会话投影缓存，仅保留配置、模型凭据与插件
    if (isConfigOnly) {
      tarArgs.push(
        '--exclude=.dsh/sessions',
        '--exclude=.dsh/attachments',
        '--exclude=.dsh/storages/session_projcache',
        '--exclude=.dsh/storages/session_projcache_archive_manager_v2'
      );
    }

    if (isMultiThread) {
      tarArgs.push('-I', 'pigz');
    } else {
      tarArgs.push('-z');
    }

    tarArgs.push('-cf', tmpPath, '-C', '/root', '.dsh');

    const res = await runTarAsync(tarArgs);

    // tar 非零退出码说明归档不完整（读错误 / 权限跳过等），绝不能当作有效快照转正
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
      throw new Error('生成的快照文件大小为 0，已被清理');
    }

    // 原子重命名
    fs.renameSync(tmpPath, finalPath);
    console.log(`[backup-service] ${taskDesc}创建成功: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      ok: true,
      snapshot: {
        filename,
        type: isConfigOnly ? 'config' : 'full',
        typeLabel: isConfigOnly ? '仅配置 (无会话)' : '完整备份',
        sizeBytes: stat.size,
        sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
        createdAt: stat.mtime.toISOString(),
        name: safeName
      }
    };
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    console.error(`[backup-service] ${taskDesc}创建失败:`, err.message);
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

  let rollbackRoot = null; // 还原前的配置回滚点（供失败时回滚）
  try {
    // 1. 预先校验快照完整性 + 成员白名单，防损坏/恶意归档破坏现有环境
    await validateArchiveMembers(snapshotPath);

    // 2. 优雅停止 DSH 并彻底清理可能占用端口的外部孤儿进程
    if (dshManager && typeof dshManager.stop === 'function') {
      await dshManager.stop();
    }
    try { spawnSync('fuser', ['-k', '-9', `${DSH_PORT}/tcp`], { stdio: 'ignore' }); } catch {}
    try {
      const psOut = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
      if (psOut.status === 0 && psOut.stdout) {
        for (const line of psOut.stdout.split('\n')) {
          if (/dsh\s+web|dsh-market-restart/i.test(line)) {
            const m = line.trim().match(/^(\d+)/);
            if (m && Number(m[1]) !== process.pid) {
              try { process.kill(Number(m[1]), 'SIGKILL'); } catch {}
            }
          }
        }
      }
    } catch {}

    // 3. 解压到独立 staging 目录（完全不触碰现网），校验通过后再原子切换
    // 注意：/root/.dsh 是挂载卷，跨设备 rename 会 EXDEV，
    // 因此 staging 与回滚点都必须放在该卷内部（同设备），并在切换时跳过这两个名字。
    const stagingRoot = path.join(DSH_DIR, '.restore-staging');
    rollbackRoot = path.join(DSH_DIR, '.restore-rollback');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(stagingRoot, { recursive: true });

    const isMultiThread = hasPigz();
    const extractArgs = ['--warning=no-file-changed', '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'];
    if (isMultiThread) {
      extractArgs.push('-I', 'pigz');
    } else {
      extractArgs.push('-z');
    }
    extractArgs.push('-xf', snapshotPath, '-C', stagingRoot);
    const extractRes = await runTarAsync(extractArgs);
    if (extractRes.code !== 0) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error('tar 解压到 staging 失败（现网未受影响）: ' + (extractRes.stderr || '未知错误'));
    }

    const stagedDsh = path.join(stagingRoot, '.dsh');
    if (!fs.existsSync(stagedDsh)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error('快照内容异常：未找到 .dsh 目录，已中止（现网未受影响）');
    }
    // 快照刻意排除了网关自有的 gateway.config.json（含 authToken）与 .session_secret，这里从现网带过去
    for (const keep of ['gateway.config.json', '.session_secret']) {
      const cur = path.join(DSH_DIR, keep);
      if (fs.existsSync(cur)) { try { fs.copyFileSync(cur, path.join(stagedDsh, keep)); } catch {} }
    }

    // 4. 原子切换：注意 /root/.dsh 是 Docker 卷挂载点，整体 rename 会 EBUSY，
    //    因此改为"逐子项搬移"——现网内容先搬到回滚点，再把 staging 内容搬入。
    const SKIP = new Set(['.restore-staging', '.restore-rollback']);
    const moveChildren = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from)) {
        if (SKIP.has(entry)) continue;
        fs.renameSync(path.join(from, entry), path.join(to, entry));
      }
    };
    const clearDir = (dir) => {
      for (const entry of fs.readdirSync(dir)) {
        if (SKIP.has(entry)) continue;
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    };
    try {
      moveChildren(DSH_DIR, rollbackRoot); // 现网 → 回滚点
      moveChildren(stagedDsh, DSH_DIR);    // staging → 现网
      console.log(`[backup-service] 配置已原子切换（旧配置备份于 ${rollbackRoot}，成功后自动清理）`);
    } catch (switchErr) {
      try {
        clearDir(DSH_DIR);
        moveChildren(rollbackRoot, DSH_DIR);
      } catch (rb) {
        console.error('[backup-service] 切换失败后的即时回滚异常:', rb.message);
      }
      throw new Error('配置切换失败，已回滚到原配置: ' + switchErr.message);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }

    const webProfileDir = path.join(DSH_DIR, 'profiles', 'web');

    // 5. 若解压后 node_modules 为空（轻量清单备份），自动依据 package.json 补全
    const targetNodeModules = path.join(webProfileDir, 'node_modules');
    const targetPkgJson = path.join(webProfileDir, 'package.json');
    if (fs.existsSync(targetPkgJson) && (!fs.existsSync(targetNodeModules) || fs.readdirSync(targetNodeModules).length === 0)) {
      console.log('[backup-service] 检测到快照未包含完整的 node_modules，正在通过 pnpm 自动补全依赖...');
      await new Promise(resolve => {
        const pnpmInstall = spawn('pnpm', ['install', '--no-frozen-lockfile'], {
          cwd: webProfileDir,
          stdio: 'ignore'
        });
        pnpmInstall.on('close', resolve);
        pnpmInstall.on('error', resolve);
      });
    }

    // 6. 执行权限自愈与补丁
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

    // 7. 重新拉起 DSH 并真实验证就绪状态
    let dshReady = false;
    if (dshManager && typeof dshManager.boot === 'function') {
      const bootRes = await dshManager.boot();
      dshReady = bootRes.ok === true;
      if (!dshReady) {
        throw new Error('快照解压完成，但 DSH 启动超时或未能成功就绪，请在终端查看日志');
      }
    }

    // 成功：清理回滚点
    try { fs.rmSync(rollbackRoot, { recursive: true, force: true }); } catch {}
    console.log(`[backup-service] 快照 ${safeFilename} 还原完成，DSH 服务就绪状态: ${dshReady}`);
    return { ok: true, filename: safeFilename, dshReady };
  } catch (err) {
    // 失败：若已切换过且回滚点仍在，尽力恢复还原前的配置并重新拉起
    try {
      if (rollbackRoot && fs.existsSync(rollbackRoot)) {
        console.warn('[backup-service] 还原失败，正在回滚到还原前的配置...');
        const skip = new Set(['.restore-staging', '.restore-rollback']);
        for (const entry of fs.readdirSync(DSH_DIR)) {
          if (skip.has(entry)) continue;
          fs.rmSync(path.join(DSH_DIR, entry), { recursive: true, force: true });
        }
        for (const entry of fs.readdirSync(rollbackRoot)) {
          fs.renameSync(path.join(rollbackRoot, entry), path.join(DSH_DIR, entry));
        }
        if (dshManager && typeof dshManager.boot === 'function') {
          await dshManager.boot().catch(() => {});
        }
        console.log('[backup-service] 已回滚到还原前的配置');
      }
    } catch (rbErr) {
      console.error('[backup-service] 回滚失败:', rbErr.message);
    }
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
  // 反模式修复：原 `new Promise(async executor)` 中任何抛出都会变成未处理的 rejection，
  // 导致该 Promise 永不 settle。改为「同步 executor + 异步实现函数」，异常统一走 reject。
  return new Promise((resolve, reject) => {
    // 同理：只用 catch 兜住实现函数抛出的异常，不采用其返回值（实现函数会自行 resolve/reject）
    Promise.resolve()
      .then(() => importBackupStreamImpl(req, rawFilename, resolve, reject))
      .catch(reject);
  });
}

async function importBackupStreamImpl(req, rawFilename, resolve, reject) {
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
    // 磁盘写满 / 权限变化时 WriteStream 会 emit 'error'，无监听即为未捕获异常 → 整个网关退出
    outStream.on('error', (e) => {
      aborted = true;
      try { req.destroy(); } catch {}
      cleanup();
      reject(new Error('写入快照文件失败: ' + e.message));
    });
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

          // 归档完整性 + 成员白名单二次校验（不合法则丢弃，不转正）
          await validateArchiveMembers(tmpPath);

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
}

function listBackups() {
  try {
    const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.tar.gz') && !f.startsWith('.'));
    const list = files.map(filename => {
      try {
        const filePath = path.join(SNAPSHOTS_DIR, filename);
        const stat = fs.statSync(filePath);
        const isConfig = filename.startsWith('dsh-config-') || filename.includes('-config-') || filename.includes('_config_');
        return {
          filename,
          type: isConfig ? 'config' : 'full',
          typeLabel: isConfig ? '仅配置 (无会话)' : '完整备份',
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
  validateArchiveMembers,
  runTarAsync,
  SNAPSHOTS_DIR
};
