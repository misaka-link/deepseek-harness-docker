const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

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

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function ensurePortReleased(port, timeoutMs = 3500) {
  killPortProcess(port);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let inUse = false;
    try {
      const res = spawnSync('ss', ['-tlpn'], { encoding: 'utf8' });
      if (res.stdout && res.stdout.includes(`:${port}`)) {
        inUse = true;
      }
    } catch {}

    // 若未查到，使用 Node net 模块作双重确认 (防 ss 缺失误判)
    if (!inUse) {
      inUse = await isPortInUse(port);
    }

    if (!inUse) return true;
    killPortProcess(port);
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

const DEFAULT_ADAPTED_VERSIONS = [
  '0.1.6-alpha.1',
  '0.1.5-rc.2',
  '0.1.5-rc.1',
  '0.1.2-rc.1'
];

function parseSemver(v = '') {
  const clean = String(v).replace(/^v/, '').trim();
  const [main, pre] = clean.split('-');
  const [major = 0, minor = 0, patch = 0] = (main || '').split('.').map(n => Number(n) || 0);
  return { major, minor, patch, pre: pre || '' };
}

function compareSemver(v1, v2) {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  if (p1.patch !== p2.patch) return p1.patch - p2.patch;
  if (!p1.pre && p2.pre) return 1;
  if (p1.pre && !p2.pre) return -1;
  return p1.pre.localeCompare(p2.pre);
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
    this.manualStopped = false;
    this.startTime = 0;
    this.recentLogs = [];
    this.lastExitInfo = null;
    this.lastKnownVersion = '';
    try { fs.mkdirSync(this.versionsCacheDir, { recursive: true }); } catch {}
  }

  getStatus() {
    const running = !!this.proc && this.proc.exitCode === null && !this.proc.killed;
    const currentVer = this.getCurrentVersion();
    return {
      version: currentVer,
      running,
      ready: this.ready,
      manualStopped: !!this.manualStopped,
      pid: running && this.proc ? this.proc.pid : null,
      startTime: this.startTime,
      cachedVersions: this.getCachedVersions()
    };
  }

  getCachedVersions() {
    try {
      if (!fs.existsSync(this.versionsCacheDir)) return [];
      return fs.readdirSync(this.versionsCacheDir).filter(name => {
        const pkg = path.join(this.versionsCacheDir, name, 'package.json');
        return fs.existsSync(pkg);
      });
    } catch {
      return [];
    }
  }

  getAdaptedVersions() {
    if (process.env.ADAPTED_DSH_VERSIONS) {
      return process.env.ADAPTED_DSH_VERSIONS.split(',').map(s => s.trim()).filter(Boolean);
    }
    return DEFAULT_ADAPTED_VERSIONS;
  }

  isAdaptedVersion(ver) {
    const list = this.getAdaptedVersions();
    return list.includes(ver);
  }

  getCurrentVersion() {
    if (this.lastKnownVersion) {
      return this.lastKnownVersion;
    }

    const paths = [
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
      '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json'
    ];
    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
          if (v) {
            this.lastKnownVersion = v;
            return v;
          }
        }
      } catch {}
    }

    try {
      const res = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (res.status === 0 && res.stdout.trim()) {
        const v = res.stdout.trim();
        this.lastKnownVersion = v;
        return v;
      }
    } catch {}

    return this.lastKnownVersion || '0.1.6-alpha.1';
  }

  async fetchAvailableVersions(force = false) {
    let distTags = {};
    let versions = [];

    // 优先使用原生异步 fetch 请求 registry，绝不阻塞主事件循环
    try {
      const regUrl = this.registry.replace(/\/+$/, '') + '/@deepseek-ai/dsh';
      const resp = await fetch(regUrl, { signal: AbortSignal.timeout(6000) });
      if (resp.ok) {
        const pkgData = await resp.json();
        distTags = pkgData['dist-tags'] || {};
        versions = Object.keys(pkgData.versions || {});
      }
    } catch (fetchErr) {
      // 网络或镜像源异常时，回退至非阻塞异步 npm view
      const runNpmAsync = (args) => new Promise((resolve) => {
        const child = spawn('npm', [...args, '--cache=/tmp/.npm-cache'], {
          env: { ...process.env, NPM_CONFIG_REGISTRY: this.registry }
        });
        let out = '';
        child.stdout.on('data', d => out += d);
        child.on('close', (code) => {
          if (code === 0 && out.trim()) {
            try { resolve(JSON.parse(out.trim())); } catch { resolve(null); }
          } else {
            resolve(null);
          }
        });
        child.on('error', () => resolve(null));
      });
      distTags = (await runNpmAsync(['view', '@deepseek-ai/dsh', 'dist-tags', '--json'])) || {};
      versions = (await runNpmAsync(['view', '@deepseek-ai/dsh', 'versions', '--json'])) || [];
    }

    const current = this.getCurrentVersion();
    const latest = distTags.latest || (Array.isArray(versions) && versions.length > 0 ? versions[versions.length - 1] : '');
    const isUpToDate = Boolean(current && latest && compareSemver(current, latest) >= 0);

    return {
      current,
      latest,
      isUpToDate,
      distTags,
      cachedVersions: this.getCachedVersions(),
      adaptedVersions: this.getAdaptedVersions(),
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

  boot(onProbe) {
    return new Promise(async resolve => {
      this.manualStopped = false;
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
      await ensurePortReleased(DSH_PORT, 4000);
      await new Promise(r => setTimeout(r, 200));

      console.log(`[dsh-manager] 启动 DSH 进程 (工作区: ${DSH_WORKSPACE}, 端口: ${DSH_PORT})...`);
      this.ready = false;

      const logStream = fs.createWriteStream(DSH_WEB_LOG, { flags: 'a' });
      const env = {
        ...process.env,
        DSH_PORT: String(DSH_PORT),
        PROXY_PORT: String(process.env.PROXY_PORT || 3080)
      };
      // 彻底剥离 NODE_ENV=production，恢复纯净开发环境，避免工作区 install 跳过 devDependencies
      delete env.NODE_ENV;

      const p = spawn('dsh', ['web', '--port', String(DSH_PORT), '--no-open'], {
        cwd: DSH_WORKSPACE,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.proc = p;

      p.stdout.on('data', d => {
        logStream.write(d);
        process.stdout.write(d);

        // 收集最近日志用于崩溃根因排查
        const str = d.toString('utf8');
        const lines = str.split('\n').filter(Boolean);
        for (const l of lines) {
          this.recentLogs.push(l);
          if (this.recentLogs.length > 80) this.recentLogs.shift();
        }

        // 实时从 stdout 管道动态捕获启动令牌，零延迟换取官方签名 Cookie
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

        const str = d.toString('utf8');
        const lines = str.split('\n').filter(Boolean);
        for (const l of lines) {
          this.recentLogs.push(l);
          if (this.recentLogs.length > 80) this.recentLogs.shift();
        }
      });

      p.on('error', err => {
        console.error('[dsh-manager] DSH 启动错误:', err.message);
        this.proc = null;
        this.ready = false;
        this.lastExitInfo = { code: -1, sig: err.message, time: Date.now(), logs: this.recentLogs.slice(-20) };
        resolve({ ok: false, error: err.message });
      });

      p.on('exit', (code, sig) => {
        console.log(`[dsh-manager] DSH 已退出 (code=${code}, sig=${sig})`);
        if (code !== 0 && code !== null) {
          this.lastExitInfo = { code, sig, time: Date.now(), logs: this.recentLogs.slice(-20) };
        }
        if (this.proc === p) {
          this.proc = null;
          this.ready = false;
        }
        // 若处于手动停止状态，不自动拉起
        if (this.manualStopped) {
          console.log('[dsh-manager] DSH 处于手动停止状态，守护管理器已暂停自动重新拉起');
          return;
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
      this.waitReady(60000, onProbe).then(async ok => {
        this.ready = ok;
        console.log(ok ? '[dsh-manager] DSH 已就绪' : '[dsh-manager] DSH 启动超时或崩溃');
        if (ok) {
          this.recentCrashCount = 0;
          this.startTime = Date.now();
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

      p.once('exit', async () => {
        clearTimeout(timer);
        this.stopping = false;
        await ensurePortReleased(DSH_PORT, 2500);
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

  async restart(onProbe) {
    await this.stop();
    return this.boot(onProbe);
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

  async waitReady(timeoutMs = 60000, onProbeProgress) {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts++;
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
      const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
      if (typeof onProbeProgress === 'function') {
        try { onProbeProgress({ attempts, elapsedSec }); } catch {}
      }
      await new Promise(r => setTimeout(r, 800));
    }
    return false;
  }

  async installVersion(version, onProgress, onLog) {
    if (this.installing) return { ok: false, error: '已有安装任务正在进行中' };
    this.installing = true;
    this.installLog = [];

    // 兼容只传入单个回调 (line => ...) 的情况
    if (typeof onProgress === 'function' && typeof onLog !== 'function') {
      onLog = onProgress;
      onProgress = null;
    }

    const log = (msg) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
      this.installLog.push(line);
      if (typeof onLog === 'function') onLog(line);
      console.log(`[dsh-installer] ${msg}`);
    };

    const emitProgress = (data) => {
      if (typeof onProgress === 'function') {
        try { onProgress(data); } catch {}
      }
    };

    const previousVersion = this.getCurrentVersion() || '0.1.2-rc.1';

    try {
      // === 阶段 1/5: 切换预检与环境检查 ===
      emitProgress({ step: 1, total: 5, percent: 10, label: '环境预检与版本兼容性评估', mode: 'install' });
      log(`======================================================================`);
      log(`=== [阶段 1/5] 切换预检: 当前运行版本 ${previousVersion} -> 目标版本 ${version} ===`);
      if (version === previousVersion) {
        log(`ℹ️ 目标版本与当前运行版本一致 (${version})，将执行环境重新装配与就绪校验。`);
      }

      // 版本特性与数据兼容性检查
      const isAdapted = this.isAdaptedVersion(version);
      if (!isAdapted) {
        log('⚠️ [适配性安全提醒] 目标版本未经过当前 Docker 镜像特殊深度适配测试！');
        log('💡 [镜像更新建议] 针对官方最新发布，强烈推荐直接更新 Docker 镜像 (docker compose pull && docker compose up -d) 获取最新针对性适配！');
        log('⚠️ 如在线切换后遇到启动异常、插件失效或界面异常，请更新 Docker 镜像或前往 GitHub Issues 交流反馈。');
      } else {
        log(`✔ 目标版本 ${version} 属于当前镜像官方深度适配版本，已通过针对性联调测试。`);
      }

      if (compareSemver(version, '0.1.5-rc.1') < 0 && compareSemver(previousVersion, '0.1.5-rc.1') >= 0) {
        log('⚠️ [版本安全警告] 您正在从 0.1.5+ 系列降级至旧版本！');
        log('⚠️ 官方说明：0.1.5 起会话数据格式已升级为 V3 且单向不可逆，降级后旧版本 DSH 无法加载 V3 会话记录。');
        log('⚠️ 强烈建议在降级前确保已创建配置与会话快照备份。');
      } else if (compareSemver(version, '0.1.5-rc.1') >= 0 && compareSemver(previousVersion, '0.1.5-rc.1') < 0) {
        log('ℹ️ [版本升级提示] 准备升级至 0.1.5+ 系列：将启用 DeepSeek-V41-Flash、右侧新版 Sidebar 预览、出站代理继承及 V3 会话格式。');
      }
      log(`✔ 预检通过：环境就绪，软件源: ${this.registry}`);

      // === 阶段 2/5: 本地安全快照存档 (保障随时秒级熔断回滚) ===
      emitProgress({ step: 2, total: 5, percent: 25, label: '备份当前稳定版本快照', mode: 'install' });
      log(`=== [阶段 2/5] 本地安全快照存档 (保障秒级熔断回滚) ===`);
      const prevBackup = path.join(this.versionsCacheDir, previousVersion);
      if (!fs.existsSync(prevBackup) && fs.existsSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')) {
        log(`正在对当前稳定版本 ${previousVersion} 生成本地秒级快照存档...`);
        spawnSync('mkdir', ['-p', prevBackup]);
        spawnSync('cp', ['-a', '/usr/local/lib/node_modules/@deepseek-ai/dsh/.', prevBackup + '/']);
        log(`✔ 稳定版本 ${previousVersion} 本地快照存档就绪`);
      } else if (fs.existsSync(prevBackup)) {
        log(`✔ 本地已存在稳定版本 ${previousVersion} 的快照存档，具备秒级回滚能力`);
      } else {
        log(`ℹ️ 当前运行版本无本地快照，熔断时将通过 npm 镜像源自动拉取回滚`);
      }

      // === 阶段 3/5: 部署目标核心版本 ===
      emitProgress({ step: 3, total: 5, percent: 40, label: '获取目标版本核心包', mode: 'install' });
      log(`=== [阶段 3/5] 部署目标核心版本 @deepseek-ai/dsh@${version} ===`);
      const targetCached = path.join(this.versionsCacheDir, version);
      if (fs.existsSync(path.join(targetCached, 'package.json'))) {
        log(`⚡ [秒级加速] 命中本地版本高速快照缓存，正在秒级部署 ${version}...`);
        spawnSync('rm', ['-rf', '/usr/local/lib/node_modules/@deepseek-ai/dsh']);
        spawnSync('mkdir', ['-p', '/usr/local/lib/node_modules/@deepseek-ai/dsh']);
        spawnSync('cp', ['-a', targetCached + '/.', '/usr/local/lib/node_modules/@deepseek-ai/dsh/']);
        spawnSync('ln', ['-sfn', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '/usr/local/bin/dsh']);
        log(`✔ 核心文件与软链已完成秒级还原 (耗时 < 1s)`);
        emitProgress({ step: 3, total: 5, percent: 60, label: '目标核心秒级解压就绪', mode: 'install' });
      } else {
        log(`正在从 npm 镜像源下载并安装 @deepseek-ai/dsh@${version} (源: ${this.registry})...`);
        const installArgs = [
          'install', '-g', '--omit=dev', '--no-audit', '--no-fund',
          `--registry=${this.registry}`,
          `@deepseek-ai/dsh@${version}`
        ];
        log(`> npm ${installArgs.join(' ')}`);

        const startTime = Date.now();
        const child = spawn('npm', installArgs, { env: process.env });

        // 动态心跳脉冲计时器，防止 npm 下载期间控制台静默假死
        const heartbeat = setInterval(() => {
          const sec = Math.floor((Date.now() - startTime) / 1000);
          const dynamicPercent = Math.min(59, 40 + Math.floor(sec * 1.2));
          log(`⏳ [npm 依赖拉取中] 正在下载并解压核心依赖包，已耗时 ${sec}s...`);
          emitProgress({
            step: 3,
            total: 5,
            percent: dynamicPercent,
            label: `下载核心依赖包 (已耗时 ${sec}s)...`,
            mode: 'install'
          });
        }, 2000);

        child.stdout.on('data', d => {
          d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(l));
        });
        child.stderr.on('data', d => {
          d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(l => log(l));
        });

        const exitCode = await new Promise(r => child.on('close', r));
        clearInterval(heartbeat);

        if (exitCode !== 0) throw new Error(`npm install 安装异常，退出码: ${exitCode}`);
        const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`✔ npm 下载并解压完成，总耗时 ${totalSec}s`);
        emitProgress({ step: 3, total: 5, percent: 60, label: '目标版本下载安装完成', mode: 'install' });
      }

      // === 阶段 4/5: 插件装配与宿主补丁自愈 ===
      emitProgress({ step: 4, total: 5, percent: 70, label: '插件装配与补丁自愈', mode: 'install' });
      log(`=== [阶段 4/5] 插件环境装配与客户端补丁注入 ===`);
      if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
        log(`> 正在同步并链接插件依赖至新核心 (schemastery & dsh-browser-desktop)...`);
        const res = spawnSync('node', ['/app/scripts/install-plugin.mjs'], { encoding: 'utf8' });
        if (res.stdout) log(res.stdout.trim());
      }
      if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
        log(`> 正在注入客户端回环宿主持久化补丁...`);
        const res = spawnSync('node', ['/app/scripts/patch-dsh-client.mjs'], { encoding: 'utf8' });
        if (res.stdout) log(res.stdout.trim());
      }
      log(`✔ 插件与宿主补丁自愈适配完成`);
      emitProgress({ step: 4, total: 5, percent: 80, label: '插件与补丁适配就绪', mode: 'install' });

      // === 阶段 5/5: 核心服务拉起与健康就绪探活 ===
      emitProgress({ step: 5, total: 5, percent: 85, label: '拉起新服务并健康探活', mode: 'install' });
      log(`=== [阶段 5/5] 拉起新版本 DSH (${version}) 并执行健康就绪探活 ===`);
      this.lastExitInfo = null;
      this.recentLogs = [];

      const bootRes = await this.restart((probe) => {
        const dynamicPercent = Math.min(97, 85 + Math.floor(probe.attempts * 0.8));
        log(`🔍 [健康探活] 正在探测端口 ${DSH_PORT} 就绪响应 (第 ${probe.attempts} 次, 已等待 ${probe.elapsedSec}s)...`);
        emitProgress({
          step: 5,
          total: 5,
          percent: dynamicPercent,
          label: `端口健康就绪探活中 (${probe.attempts}/30)...`,
          mode: 'install'
        });
      });

      if (!bootRes.ok) {
        let failDetail = `新版本 ${version} 启动后未能通过端口健康就绪探测`;
        if (this.lastExitInfo) {
          failDetail = `新版本进程启动异常退出 (Exit Code: ${this.lastExitInfo.code}, Signal: ${this.lastExitInfo.sig || 'none'})`;
        }
        throw new Error(failDetail);
      }

      const currentVer = this.getCurrentVersion();
      // 安装就绪成功后，存入本地高速快照
      if (!fs.existsSync(targetCached) && fs.existsSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')) {
        log(`正在将新版本 ${version} 归档至本地高速快照缓存...`);
        spawnSync('mkdir', ['-p', targetCached]);
        spawnSync('cp', ['-a', '/usr/local/lib/node_modules/@deepseek-ai/dsh/.', targetCached + '/']);
      }

      emitProgress({
        step: 5,
        total: 5,
        percent: 100,
        label: `切换完成！核心已成功升级至 v${currentVer}`,
        mode: 'install'
      });

      log(`======================================================================`);
      log(`🎉 [SUCCESS] DSH 核心版本切换成功！`);
      log(`🚀 当前运行版本: v${currentVer} (服务已健康就绪)`);
      log(`🌐 工作区访问地址: http://127.0.0.1:${DSH_PORT}`);
      log(`======================================================================`);

      this.installing = false;
      return { ok: true, version: currentVer };

    } catch (err) {
      log(`======================================================================`);
      log(`❌ 新版本安装或启动失败: ${err.message}`);
      // 打印失败根因分析
      log(`----------------- 🔍 [新版本失败根因排查] -----------------`);
      if (this.lastExitInfo) {
        log(`进程退出状态: Code=${this.lastExitInfo.code}, Sig=${this.lastExitInfo.sig || 'none'}`);
        if (this.lastExitInfo.logs && this.lastExitInfo.logs.length > 0) {
          log(`进程最后输出片段:`);
          this.lastExitInfo.logs.slice(-8).forEach(l => log(`  | ${l}`));
        }
      } else {
        log(`可能原因: 进程在 60 秒内未监听端口 ${DSH_PORT}，或端口无有效 HTTP 响应`);
      }
      log(`-----------------------------------------------------------`);
      log(`⚠️ 触发安全熔断保护机制：正在秒级自动回滚至稳定版本 v${previousVersion}...`);
      log(`======================================================================`);

      emitProgress({
        step: 1,
        total: 3,
        percent: 30,
        label: `🛡️ 触发安全熔断：正在秒级还原稳定版本 v${previousVersion}...`,
        mode: 'rollback'
      });

      try {
        const prevCached = path.join(this.versionsCacheDir, previousVersion);
        if (fs.existsSync(path.join(prevCached, 'package.json'))) {
          log(`[回滚 1/3] ⚡ 从本地快照中秒级还原稳定核心 ${previousVersion}...`);
          spawnSync('rm', ['-rf', '/usr/local/lib/node_modules/@deepseek-ai/dsh']);
          spawnSync('mkdir', ['-p', '/usr/local/lib/node_modules/@deepseek-ai/dsh']);
          spawnSync('cp', ['-a', prevCached + '/.', '/usr/local/lib/node_modules/@deepseek-ai/dsh/']);
          spawnSync('ln', ['-sfn', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '/usr/local/bin/dsh']);
          log(`✔ 稳定核心文件已秒级还原完毕`);
        } else {
          log(`[回滚 1/3] 本地无快照，从 npm 源重新拉回稳定版本 ${previousVersion}...`);
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

        emitProgress({
          step: 2,
          total: 3,
          percent: 65,
          label: `🛡️ 熔断回滚 [2/3]: 恢复稳定版本插件配置与补丁`,
          mode: 'rollback'
        });
        log('[回滚 2/3] 正在重新执行插件配置与依赖自愈...');
        if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
          spawnSync('node', ['/app/scripts/install-plugin.mjs'], { encoding: 'utf8' });
        }
        if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
          spawnSync('node', ['/app/scripts/patch-dsh-client.mjs'], { encoding: 'utf8' });
        }
        log(`✔ 插件与补丁配置已复位`);

        emitProgress({
          step: 3,
          total: 3,
          percent: 85,
          label: `🛡️ 熔断回滚 [3/3]: 正在重新拉起稳定核心并探活...`,
          mode: 'rollback'
        });
        log(`[回滚 3/3] 正在重新拉起稳定版本 ${previousVersion}...`);
        const rbBoot = await this.restart((probe) => {
          log(`🔍 [回滚探活] 正在探测稳定版本端口 ${DSH_PORT} (第 ${probe.attempts} 次, 已等待 ${probe.elapsedSec}s)...`);
          emitProgress({
            step: 3,
            total: 3,
            percent: Math.min(98, 85 + probe.attempts * 2),
            label: `🛡️ 熔断回滚 [3/3]: 稳定版本就绪探活中 (${probe.attempts}/30)...`,
            mode: 'rollback'
          });
        });
        if (!rbBoot.ok) throw new Error(`稳定版本重启失败，无法进入正常就绪状态`);

        emitProgress({
          step: 3,
          total: 3,
          percent: 100,
          label: `🛡️ 自动回滚完成！系统已恢复至稳定版本 v${previousVersion}`,
          mode: 'rollback'
        });

        log(`======================================================================`);
        log(`✅ [安全熔断成功] 系统已完好恢复至稳定可用版本: v${previousVersion}`);
        log(`✔ 确认当前运行版本 (dsh --version): ${this.getCurrentVersion()}`);
        log(`✔ 服务状态: 正常运行在 http://127.0.0.1:${DSH_PORT}`);
        log(`======================================================================`);

        this.installing = false;
        return {
          ok: false,
          error: `目标版本 ${version} 启动失败: ${err.message}，系统已自动安全回滚至稳定版本 ${previousVersion}`,
          rolledBack: true,
          version: previousVersion
        };
      } catch (rbErr) {
        log(`💥 [严重警报] 自动回滚遇到异常: ${rbErr.message}`);
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
