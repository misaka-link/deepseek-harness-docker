const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const DSH_WORKSPACE = process.env.DSH_WORKSPACE || '/workspace';
const DSH_WEB_LOG = process.env.DSH_WEB_LOG || '/tmp/dsh-web.log';
const SNAPSHOTS_DIR = process.env.DSH_SNAPSHOTS_DIR || '/root/.dsh-snapshots';
const DSH_DIR = '/root/.dsh';
const backupService = require('./backup-service');

try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DSH_WORKSPACE, { recursive: true }); } catch {}

function killPortProcess(port) {
  try {
    spawnSync('fuser', ['-k', '-9', `${port}/tcp`], { stdio: 'ignore' });
  } catch {}
  try {
    const res = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        if (/dsh\s+web|dsh-market-restart/i.test(line)) {
          const m = line.trim().match(/^(\d+)/);
          if (m) {
            const pid = Number(m[1]);
            if (pid !== process.pid) {
              try { process.kill(pid, 'SIGKILL'); } catch {}
            }
          }
        }
      }
    }
  } catch {}
}

class DshManager {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.installing = false;
    this.stopping = false;
    this.installLog = [];
    this.registry = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
    this.launchToken = '';
    this.upstreamCookie = '';
    this.versionsCacheDir = '/app/.dsh-versions-cache';
    this.restartTimer = null;
    this.recentCrashCount = 0;
    this.lastCrashTime = 0;
    try { fs.mkdirSync(this.versionsCacheDir, { recursive: true }); } catch {}
  }

  getCurrentVersion() {
    try {
      const res = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
      if (res.status === 0) return res.stdout.trim();
    } catch {}

    const paths = [
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
      '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json'
    ];
    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          return JSON.parse(fs.readFileSync(p, 'utf8')).version || 'unknown';
        }
      } catch {}
    }
    return 'unknown';
  }

  async fetchAvailableVersions(force = false) {
    const env = { ...process.env, NPM_CONFIG_REGISTRY: this.registry };

    const runNpm = (args) => {
      try {
        const res = spawnSync('npm', args, { env, encoding: 'utf8', timeout: 30000 });
        if (res.status === 0) return JSON.parse(res.stdout.trim());
      } catch {}
      return null;
    };

    const distTags = runNpm(['view', '@deepseek-ai/dsh', 'dist-tags', '--json']) || {};
    const versions = runNpm(['view', '@deepseek-ai/dsh', 'versions', '--json']) || [];

    return {
      current: this.getCurrentVersion(),
      distTags,
      versions: Array.isArray(versions) ? versions.reverse() : [],
      registry: this.registry
    };
  }

  setRegistry(reg) {
    if (reg && reg.startsWith('http')) {
      this.registry = reg.trim();
    }
    return this.registry;
  }

  boot() {
    return new Promise(async resolve => {
      if (this.proc) return resolve({ ok: true, alreadyRunning: true });
      this.stopping = false;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }

      // 启动前检查并修复 .credentials.yaml 与 .dsh 权限 (DSH 凭据服务强制校验 mode 600)
      try {
        const credPath = path.join(DSH_DIR, '.credentials.yaml');
        if (fs.existsSync(credPath)) {
          fs.chmodSync(credPath, 0o600);
        }
        if (fs.existsSync(DSH_DIR)) {
          fs.chmodSync(DSH_DIR, 0o700);
        }
      } catch (err) {
        console.warn('[dsh-manager] 校验/修复凭据文件权限失败:', err.message);
      }

      // 关键防冲突：清理可能遗留并霸占 DSH_PORT 的孤儿或外部重启进程
      killPortProcess(DSH_PORT);
      await new Promise(r => setTimeout(r, 250));

      console.log(`[dsh-manager] 启动 DSH 进程 (工作区: ${DSH_WORKSPACE}, 端口: ${DSH_PORT})...`);
      this.ready = false;

      const logStream = fs.createWriteStream(DSH_WEB_LOG, { flags: 'a' });
      const env = {
        ...process.env,
        DSH_PORT: String(DSH_PORT)
      };

      const p = spawn('dsh', ['web', '--port', String(DSH_PORT), '--no-open'], {
        cwd: DSH_WORKSPACE,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.proc = p;

      p.stdout.on('data', d => {
        logStream.write(d);
        process.stdout.write(d);

        // 实时从 stdout 管道动态捕获启动令牌，零延迟换取官方签名 Cookie
        const str = d.toString('utf8');
        const m = str.match(/token=([A-Za-z0-9._~-]{16,})/i);
        if (m) {
          const token = m[1].trim();
          if (token !== this.launchToken) {
            this.launchToken = token;
            this.exchangeSessionCookie(token).catch(() => {});
          }
        }
      });
      p.stderr.on('data', d => {
        logStream.write(d);
        process.stderr.write(d);
      });

      p.on('error', err => {
        console.error('[dsh-manager] DSH 启动错误:', err.message);
        this.proc = null;
        this.ready = false;
        resolve({ ok: false, error: err.message });
      });

      p.on('exit', (code, sig) => {
        console.log(`[dsh-manager] DSH 已退出 (code=${code}, sig=${sig})`);
        if (this.proc === p) {
          this.proc = null;
          this.ready = false;
        }
        // 若非主动调用 stop()，自动执行守护拉起 (带频次熔断保护)
        if (!this.stopping && !this.installing) {
          const now = Date.now();
          if (now - this.lastCrashTime < 6000) {
            this.recentCrashCount = (this.recentCrashCount || 0) + 1;
          } else {
            this.recentCrashCount = 1;
          }
          this.lastCrashTime = now;

          if (this.recentCrashCount > 5) {
            console.error('[dsh-manager] 警告: DSH 频繁崩溃 (>5次)，已暂停自动拉起以保护系统。请在管理后台检查配置或恢复快照。');
            return;
          }

          const delay = Math.min(1000 * Math.pow(1.5, this.recentCrashCount - 1), 10000);
          console.log(`[dsh-manager] DSH 进程退出，守护管理器将在 ${(delay / 1000).toFixed(1)} 秒后自动重新拉起 DSH...`);
          clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            if (!this.stopping && !this.installing && !this.proc) {
              this.boot().catch(err => console.error('[dsh-manager] 自动拉起 DSH 失败:', err.message));
            }
          }, delay);
        }
      });

      // 等待真正就绪（杜绝外部假冒就绪）
      this.waitReady(60000).then(async ok => {
        this.ready = ok;
        console.log(ok ? '[dsh-manager] DSH 已就绪' : '[dsh-manager] DSH 启动超时或崩溃');
        if (ok) {
          this.recentCrashCount = 0;
          if (this.launchToken) {
            await this.exchangeSessionCookie(this.launchToken);
          }
        }
        resolve({ ok });
      });
    });
  }

  stop() {
    return new Promise(resolve => {
      this.stopping = true;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.recentCrashCount = 0;

      const p = this.proc;
      this.proc = null;
      this.ready = false;

      // 无论 this.proc 是否存在，强制清空 3079 端口及所有孤儿 node dsh 进程
      killPortProcess(DSH_PORT);

      if (!p) {
        this.stopping = false;
        return resolve({ ok: true });
      }

      console.log('[dsh-manager] 停止 DSH 进程...');
      const timer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch {}
        killPortProcess(DSH_PORT);
      }, 4000);

      p.once('exit', () => {
        clearTimeout(timer);
        this.stopping = false;
        killPortProcess(DSH_PORT);
        resolve({ ok: true });
      });

      try {
        p.kill('SIGTERM');
      } catch {
        this.stopping = false;
        resolve({ ok: true });
      }
    });
  }

  async restart() {
    await this.stop();
    return this.boot();
  }

  async exchangeSessionCookie(token = this.launchToken) {
    if (!token) return '';
    const targetUrl = `http://127.0.0.1:${DSH_PORT}/?token=${encodeURIComponent(token)}`;
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: { 'Host': `127.0.0.1:${DSH_PORT}` },
        redirect: 'manual'
      });

      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      const cookieHeader = res.headers.get('set-cookie') || '';
      const allCookies = setCookies.length > 0 ? setCookies : (cookieHeader ? [cookieHeader] : []);

      for (const sc of allCookies) {
        if (sc && sc.includes('dsh-auth-')) {
          const cookiePair = sc.split(';')[0].trim();
          this.upstreamCookie = cookiePair;
          return cookiePair;
        }
      }
    } catch (err) {
      console.warn('[dsh-manager] 换取会话 Cookie 失败:', err.message);
    }
    return this.upstreamCookie;
  }

  async ensureValidUpstreamCookie() {
    if (this.upstreamCookie) return this.upstreamCookie;
    return this.exchangeSessionCookie();
  }

  async waitReady(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // 若子进程已退出或崩溃，坚决判定为未就绪，杜绝外部假冒就绪
      if (!this.proc || this.proc.exitCode !== null || this.proc.killed) {
        return false;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${DSH_PORT}/`);
        if (res.status < 500 && this.proc && this.proc.exitCode === null) {
          return true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 800));
    }
    return false;
  }

  async installVersion(version, onLog) {
    if (this.installing) return { ok: false, error: '已有安装任务正在进行中' };
    this.installing = true;
    this.installLog = [];

    const log = (msg) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
      this.installLog.push(line);
      if (typeof onLog === 'function') onLog(line);
      console.log(`[dsh-installer] ${msg}`);
    };

    const previousVersion = this.getCurrentVersion() || '0.1.2-rc.1';

    try {
      log(`当前运行版本: ${previousVersion}，准备切换至目标版本: ${version}`);

      // 1. 自动对当前正常运行的稳定版本进行本地高速快照存档
      const prevBackup = path.join(this.versionsCacheDir, previousVersion);
      if (!fs.existsSync(prevBackup) && fs.existsSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')) {
        log(`正在对当前稳定版本 ${previousVersion} 生成本地秒级快照存档...`);
        spawnSync('mkdir', ['-p', prevBackup]);
        spawnSync('cp', ['-a', '/usr/local/lib/node_modules/@deepseek-ai/dsh/.', prevBackup + '/']);
      }

      // 2. 检查目标版本是否已有本地快照缓存
      const targetCached = path.join(this.versionsCacheDir, version);
      if (fs.existsSync(path.join(targetCached, 'package.json'))) {
        log(`⚡ 命中本地版本高速缓存，正在秒级就绪切换至 ${version}...`);
        spawnSync('rm', ['-rf', '/usr/local/lib/node_modules/@deepseek-ai/dsh']);
        spawnSync('mkdir', ['-p', '/usr/local/lib/node_modules/@deepseek-ai/dsh']);
        spawnSync('cp', ['-a', targetCached + '/.', '/usr/local/lib/node_modules/@deepseek-ai/dsh/']);
        spawnSync('ln', ['-sfn', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '/usr/local/bin/dsh']);
      } else {
        log(`正在从 npm 镜像源下载并安装 @deepseek-ai/dsh@${version} (源: ${this.registry})...`);
        const installArgs = [
          'install', '-g', '--omit=dev', '--no-audit', '--no-fund',
          `--registry=${this.registry}`,
          `@deepseek-ai/dsh@${version}`
        ];
        log(`> npm ${installArgs.join(' ')}`);
        const child = spawn('npm', installArgs, { env: process.env });

        child.stdout.on('data', d => {
          d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(l));
        });
        child.stderr.on('data', d => {
          d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(l));
        });

        const exitCode = await new Promise(r => child.on('close', r));
        if (exitCode !== 0) throw new Error(`npm install 安装异常，退出码: ${exitCode}`);
      }

      log('核心文件就绪，正在执行插件环境装配与自愈适配...');
      if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
        const res = spawnSync('node', ['/app/scripts/install-plugin.mjs'], { encoding: 'utf8' });
        if (res.stdout) log(res.stdout.trim());
      }
      if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
        const res = spawnSync('node', ['/app/scripts/patch-dsh-client.mjs'], { encoding: 'utf8' });
        if (res.stdout) log(res.stdout.trim());
      }

      log(`正在拉起新版本 DSH (${version}) 并执行健康就绪探测...`);
      const bootRes = await this.restart();
      if (!bootRes.ok) {
        throw new Error(`新版本 ${version} 启动失败或超时 (无法进入正常就绪服务状态)`);
      }

      const currentVer = this.getCurrentVersion();
      // 安装并就绪成功后，存入本地高速缓存
      if (!fs.existsSync(targetCached) && fs.existsSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')) {
        spawnSync('mkdir', ['-p', targetCached]);
        spawnSync('cp', ['-a', '/usr/local/lib/node_modules/@deepseek-ai/dsh/.', targetCached + '/']);
      }

      log(`🎉 切换成功！新版本服务已完全就绪，当前运行核心: ${currentVer}`);
      this.installing = false;
      return { ok: true, version: currentVer };

    } catch (err) {
      log(`❌ 新版本安装或启动失败: ${err.message}`);
      log(`⚠️ 触发安全熔断保护机制：正在秒级自动回滚至稳定版本 @deepseek-ai/dsh@${previousVersion}...`);

      try {
        const prevCached = path.join(this.versionsCacheDir, previousVersion);
        if (fs.existsSync(path.join(prevCached, 'package.json'))) {
          log(`[回滚] ⚡ 从本地快照中秒级还原稳定核心 ${previousVersion}...`);
          spawnSync('rm', ['-rf', '/usr/local/lib/node_modules/@deepseek-ai/dsh']);
          spawnSync('mkdir', ['-p', '/usr/local/lib/node_modules/@deepseek-ai/dsh']);
          spawnSync('cp', ['-a', prevCached + '/.', '/usr/local/lib/node_modules/@deepseek-ai/dsh/']);
          spawnSync('ln', ['-sfn', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '/usr/local/bin/dsh']);
        } else {
          log(`[回滚] 重新从 npm 源拉取稳定版本 ${previousVersion}...`);
          const rbArgs = [
            'install', '-g', '--omit=dev', '--no-audit', '--no-fund',
            `--registry=${this.registry}`,
            `@deepseek-ai/dsh@${previousVersion}`
          ];
          const rbChild = spawn('npm', rbArgs, { env: process.env });
          rbChild.stdout.on('data', d => d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(`[回滚] ${l}`)));
          rbChild.stderr.on('data', d => d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(`[回滚] ${l}`)));
          await new Promise(r => rbChild.on('close', r));
        }

        log('[回滚] 正在重新执行插件配置与依赖自愈...');
        if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
          spawnSync('node', ['/app/scripts/install-plugin.mjs'], { encoding: 'utf8' });
        }
        if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
          spawnSync('node', ['/app/scripts/patch-dsh-client.mjs'], { encoding: 'utf8' });
        }

        log(`[回滚] 正在重新拉起稳定版本 ${previousVersion}...`);
        const rbBoot = await this.restart();
        if (!rbBoot.ok) throw new Error(`稳定版本重启失败`);

        log(`✅ 自动回滚完成！系统已瞬间恢复至稳定可用版本: ${previousVersion}`);
        this.installing = false;
        return {
          ok: false,
          error: `目标版本 ${version} 启动失败，已自动安全回滚至稳定版本 ${previousVersion}`,
          rolledBack: true,
          version: previousVersion
        };
      } catch (rbErr) {
        log(`💥 严重警报：自动回滚失败: ${rbErr.message}`);
        this.installing = false;
        return { ok: false, error: `切换失败且回滚异常: ${rbErr.message}` };
      }
    }
  }

  // === 配置文件快照与备份管理 (委托给异步非阻塞 backupService) ===
  ensureDefaultSnapshot() {
    const defaultMarker = path.join(SNAPSHOTS_DIR, '.default_snapshot_created');
    if (fs.existsSync(defaultMarker)) {
      return { ok: true, alreadyExists: true };
    }

    const existing = backupService.listBackups().snapshots || [];
    const hasDefault = existing.some(s => s.filename.includes('default') || s.filename.includes('initial'));
    if (hasDefault) {
      try { fs.writeFileSync(defaultMarker, new Date().toISOString()); } catch {}
      return { ok: true, alreadyExists: true };
    }

    console.log('[dsh-manager] 首次启动：异步非阻塞创建初始默认配置快照...');
    backupService.createBackup('default-initial')
      .then(res => {
        try { fs.writeFileSync(defaultMarker, new Date().toISOString()); } catch {}
        console.log(`[dsh-manager] 默认初始配置快照创建成功: ${res.snapshot.filename}`);
      })
      .catch(err => {
        console.warn('[dsh-manager] 创建初始快照非致命跳过:', err.message);
      });

    return { ok: true, pending: true };
  }

  createSnapshot(name = '') {
    return backupService.createBackup(name);
  }

  listSnapshots() {
    return backupService.listBackups();
  }

  restoreSnapshot(filename) {
    return backupService.restoreBackup(filename, this);
  }

  deleteSnapshot(filename) {
    return backupService.deleteBackup(filename);
  }

  getSnapshotPath(filename) {
    return backupService.getBackupPath(filename);
  }
}

const instance = new DshManager();
module.exports = instance;
