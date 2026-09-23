const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const DSH_WORKSPACE = process.env.DSH_WORKSPACE || '/workspace';
const DSH_WEB_LOG = process.env.DSH_WEB_LOG || '/tmp/dsh-web.log';
const SNAPSHOTS_DIR = process.env.DSH_SNAPSHOTS_DIR || '/root/.dsh-snapshots';
const DSH_DIR = path.join(process.env.DSH_HOME || '/root', '.dsh');
const backupService = require('./backup-service');
const { isValidVersion, resolveWithinDir } = require('./dsh-version');

try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DSH_WORKSPACE, { recursive: true }); } catch {}

function killPortProcess(port) {
  // 安全阀：绝不清理网关自己的端口（若 DSH_PORT 被误配成 PROXY_PORT，fuser -k 会杀掉网关自身）
  const proxyPort = Number(process.env.PROXY_PORT) || 3080;
  if (Number(port) === proxyPort) {
    console.warn(`[dsh-manager] 跳过端口清理：目标端口 ${port} 与网关端口相同，避免误杀自身`);
    return;
  }
  try {
    spawnSync('fuser', ['-k', '-9', `${port}/tcp`], { stdio: 'ignore' });
  } catch {}
  try {
    const res = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        // 收敛匹配：仅处理"本 DSH 端口上的 dsh web 服务进程"，避免误伤其它同名命令
        if (!/dsh\s+web(\s|$)/.test(line)) continue;
        if (!line.includes(String(port))) continue;
        const m = line.trim().match(/^(\d+)/);
        if (m) {
          const pid = Number(m[1]);
          if (pid !== process.pid) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
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

// ── 版本元数据单一数据源 ────────────────────────────────────────────
// 「已适配版本」曾在本文件、version-service.js 与 version.json 三处各写一份，
// 升级时漏改本文件，导致管理后台把 0.1.7-alpha.1/alpha.2 误判为「未经特殊适配」。
// 现统一优先读取仓库根 version.json 的 compatibility.adaptedVersions，杜绝再次漂移。
const VERSION_META_PATHS = [
  path.join(__dirname, '../version.json'),
  path.join(__dirname, 'version.json'),
  '/app/version.json'
];

function readVersionMeta() {
  for (const p of VERSION_META_PATHS) {
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (meta && typeof meta === 'object') return meta;
    } catch {}
  }
  return null;
}

const VERSION_META = readVersionMeta();

// 兜底清单：仅在 version.json 缺失时使用，必须与 compatibility.recommendedDsh 保持同步
const DEFAULT_ADAPTED_VERSIONS = [
  '0.1.7-alpha.2',
  '0.1.7-alpha.1',
  '0.1.6-alpha.2',
  '0.1.6-alpha.1',
  '0.1.5-rc.2',
  '0.1.5-rc.1',
  '0.1.2-rc.1'
];

// 版本探测失败时的兜底版本号（优先取 version.json 供应链固定版本）
const FALLBACK_DSH_VERSION = (VERSION_META && VERSION_META.supply && VERSION_META.supply.dshVersion) || '0.1.7-alpha.2';

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
    this.lastCrashTime = 0;
    this.manualStopped = false;
    this.startTime = 0;
    this.recentLogs = [];
    this.lastExitInfo = null;
    this.lastKnownVersion = '';
    this.autoHealEnabled = true;
    this.maxAutoHealPerBoot = 5;
    this.autoHealCountInCurrentBoot = 0;
    this.autoIsolatedEvents = [];
    // 生命周期操作串行队列：boot/stop/restart 依次执行，杜绝并发启动与守护自愈互相打架
    this._opChain = Promise.resolve();
    // 崩溃时间窗口（M4）：只按"最近一段时间内的崩溃次数"熔断，而不是被一次就绪清零
    this.crashWindow = [];
    try { fs.mkdirSync(this.versionsCacheDir, { recursive: true }); } catch {}
  }

  // 把生命周期操作串行化：前序操作无论成功失败都不阻塞后续操作
  _enqueue(task) {
    const run = this._opChain.then(task, task);
    // 看门狗（最后一道保险）：任务若 180s 内仍未 settle（内部 Promise 泄漏等），
    // 记录告警并放行后续操作，避免整个生命周期队列被永久卡死。
    let timer = null;
    const guarded = Promise.race([
      run,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn('[dsh-manager] ⚠️ 生命周期操作超过 180s 未返回，放行后续操作（看门狗触发）');
          resolve({ ok: false, error: 'operation_timeout' });
        }, 180000);
        if (timer.unref) timer.unref();
      })
    ]);
    // 关键：操作一旦 settle 就清掉计时器。原实现从不清除 → 即使操作早已成功，
    // 进程在启动 180s 后仍会打印"看门狗触发"的假告警（远程实测到的就是这种假告警）。
    const clear = () => { if (timer) clearTimeout(timer); };
    guarded.then(clear, clear);
    this._opChain = guarded.then(() => {}, () => {});
    return guarded;
  }

  setAutoHeal(enabled, maxPerBoot = 5) {
    this.autoHealEnabled = enabled !== false;
    this.maxAutoHealPerBoot = Math.max(1, Math.min(50, Number(maxPerBoot) || 5));
    console.log(`[dsh-manager] 启动崩溃自愈与插件自动隔离策略已更新: ${this.autoHealEnabled ? '已开启' : '已关闭'} (单周期上限: ${this.maxAutoHealPerBoot})`);
  }

  getAutoIsolatedEvents() {
    return this.autoIsolatedEvents || [];
  }

  clearAutoIsolatedEvents() {
    this.autoIsolatedEvents = [];
  }

  detectCrashingPlugin(recentLogs = []) {
    let combinedLogs = Array.isArray(recentLogs) ? [...recentLogs] : [];
    if (this.lastExitInfo && Array.isArray(this.lastExitInfo.logs)) {
      combinedLogs = [...this.lastExitInfo.logs, ...combinedLogs];
    }
    try {
      if (fs.existsSync(DSH_WEB_LOG)) {
        const fileContent = fs.readFileSync(DSH_WEB_LOG, 'utf8');
        const fileLines = fileContent.split('\n').filter(Boolean).slice(-150);
        combinedLogs = [...fileLines, ...combinedLogs];
      }
    } catch {}

    const logText = combinedLogs.join('\n');
    if (!logText.trim()) return null;

    let pluginsList = [];
    try {
      const pm = require('./plugin-manager');
      const res = pm.getPlugins();
      if (res && Array.isArray(res.plugins)) {
        pluginsList = res.plugins;
      }
    } catch (e) {
      console.warn('[dsh-manager] 获取插件列表进行崩溃分析失败:', e.message);
      return null;
    }

    // 严禁对系统核心组件进行隔离，仅针对非核心、启用状态的插件进行分析
    const candidatePlugins = pluginsList.filter(p => !p.isCore && p.enabled && !p.isUninstalled);
    if (candidatePlugins.length === 0) return null;

    // 1. 结构化 Cordis 加载器条目报错提取
    // 匹配形如: failed to import loader entry archived-chats (dsh-archived-chats): ...
    // 或: failed to apply loader entry include (cordis:include): ...
    // 或: loader entry <id> (<name>): ...
    const cordisEntryRegex = /(?:loader entry|failed to (?:import|apply|load|resolve)[^:\n]*loader entry)\s+([a-zA-Z0-9_\-\.\@\/]+)(?:\s*\(([@a-zA-Z0-9_\-\.\/]+)\))?/gi;
    let m;
    while ((m = cordisEntryRegex.exec(logText)) !== null) {
      const entryId = m[1];
      const pkgName = m[2];
      for (const p of candidatePlugins) {
        if (p.isCore) continue;
        const cleanName = p.name.replace(/^@.*\//, '');
        if ((pkgName && (p.name === pkgName || cleanName === pkgName || p.name.endsWith('/' + pkgName))) ||
            (entryId && (p.name === entryId || cleanName === entryId || p.name === 'dsh-' + entryId || cleanName === 'dsh-' + entryId))) {
          return {
            name: p.name,
            reason: 'cordis_loader_entry_failure',
            matched: `Cordis 加载器明确报告条目装载失败: ${entryId}${pkgName ? ` (${pkgName})` : ''}`
          };
        }
      }
    }

    // 2. 括号包裹的明确包名检测 (Cordis 在错误信息中固定用括号注明包名，如 `(dsh-archived-chats)`)
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const short = p.name.replace(/^@.*\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('\\(\\s*(?:' + escaped + '|' + short + ')\\s*\\)', 'i').test(logText)) {
        return {
          name: p.name,
          reason: 'plugin_paren_mention',
          matched: `加载器报错信息明确标注故障拓展: (${p.name})`
        };
      }
    }

    // 3. 广义装载与依赖导入失败检测 (failed to import/load/apply ... <pluginName>)
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const short = p.name.replace(/^@.*\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('failed to (?:import|apply|load|resolve)[^\\n]*?\\b(?:' + escaped + '|' + short + ')\\b', 'i').test(logText)) {
        return {
          name: p.name,
          reason: 'failed_to_import',
          matched: `日志检测到拓展装载失败: ${p.name}`
        };
      }
    }

    // 4. 深度扫描：Node.js 异常调用栈定位 (node_modules/<name>/... 或 imported from ...<name>)
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stackRegex = new RegExp(`(?:node_modules[\\\\/]${escaped}[\\\\/]|imported from.*${escaped})`, 'i');
      if (stackRegex.test(logText)) {
        return {
          name: p.name,
          reason: 'stack_trace_match',
          matched: `调用堆栈直接定位到故障插件: ${p.name}`
        };
      }
    }

    // 5. Cordis Patch 配置冲突：必须是"结构化"的解析报错，且与插件名在**同一行**出现。
    //    旧实现只要全文同时出现 "patch" 与插件名就命中，极易误伤（例如本项目的补丁脚本日志）。
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const names = esc(p.name) + '|' + esc(p.name.replace(/^@.*\//, ''));
      const reA = new RegExp('(patch|yaml|yml)[^\\n]*?(parse|syntax|invalid|conflict|error)[^\\n]*?(?:' + names + ')', 'i');
      const reB = new RegExp('(?:' + names + ')[^\\n]*?(patch|yaml|yml)[^\\n]*?(parse|syntax|invalid|conflict|error)', 'i');
      if (reA.test(logText) || reB.test(logText)) {
        return {
          name: p.name,
          reason: 'patch_conflict',
          matched: `Cordis 补丁配置解析冲突: ${p.name}`
        };
      }
    }

    // 6. 插件自身标签的致命报错：要求**同一行**同时出现标签与错误标记。
    //    旧实现是"全文任意位置同时出现"，别的插件报错也会误伤本插件。
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const short = p.name.replace(/^@.*\//, '');
      const tagEsc = ('[' + short + ']').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(tagEsc + '[^\\n]*?(Error|Exception|FATAL|crash|failed)', 'i');
      if (re.test(logText)) {
        return {
          name: p.name,
          reason: 'plugin_logger_error',
          matched: `插件内部日志打印致命异常: [${short}]`
        };
      }
    }

    return null;
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
      cachedVersions: this.getCachedVersions(),
      lastExitInfo: this.lastExitInfo,
      recentLogs: this.getRecentLogs(30),
      autoHealEnabled: this.autoHealEnabled,
      autoHealMaxPerBoot: this.maxAutoHealPerBoot,
      autoHealCountInCurrentBoot: this.autoHealCountInCurrentBoot,
      autoIsolatedEvents: this.autoIsolatedEvents
    };
  }

  getRecentLogs(count = 150) {
    if (this.recentLogs && this.recentLogs.length > 0) {
      return this.recentLogs.slice(-count);
    }
    try {
      if (fs.existsSync(DSH_WEB_LOG)) {
        const content = fs.readFileSync(DSH_WEB_LOG, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        return lines.slice(-count);
      }
    } catch {}
    return [];
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
    // 单一数据源：优先读取 version.json 的 compatibility.adaptedVersions
    const list = VERSION_META && VERSION_META.compatibility && VERSION_META.compatibility.adaptedVersions;
    if (Array.isArray(list) && list.length) return list;
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

    return this.lastKnownVersion || FALLBACK_DSH_VERSION;
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
    // 优先选取真正的官方最新发布版本 (alpha / next / latest 预发布与稳定新版，或版本列表最高 semver，对齐 build.sh)
    let latest = distTags.alpha || distTags.next || distTags.latest;
    if (Array.isArray(versions) && versions.length > 0) {
      const sorted = [...versions].sort(compareSemver);
      const newestInList = sorted[sorted.length - 1];
      if (!latest || (newestInList && compareSemver(newestInList, latest) > 0)) {
        latest = newestInList;
      }
    }
    if (!latest) latest = FALLBACK_DSH_VERSION;
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

  // 对外入口：串行化后执行真正的启动逻辑
  boot(onProbe) {
    return this._enqueue(() => this._bootInternal(onProbe));
  }

  _bootInternal(onProbe) {
    // 反模式修复：`new Promise(async executor)` 里抛出的异常会成为未处理 rejection，
    // Promise 永不 settle（进而卡死串行队列）。改为同步 executor + 异步实现函数。
    return new Promise((resolve) => {
      // 注意：不能用 .then(resolve) 采用实现函数的"返回值"——实现函数是异步的，
      // 它自己会在就绪/失败时调用 resolve，而其函数体可能在嵌套 then 链完成前就先返回，
      // 若采用返回值会把 Promise 提前以 undefined 结算。这里只用 catch 兜住实现函数抛出的异常。
      Promise.resolve()
        .then(() => this._bootInternalImpl(onProbe, resolve))
        .catch((err) => {
          console.error('[dsh-manager] 启动流程异常（已兜底 resolve）:', (err && err.message) || err);
          resolve({ ok: false, error: (err && err.message) || String(err) });
        });
    });
  }

  async _bootInternalImpl(onProbe, resolve) {
      this.manualStopped = false;
      // 只有"进程确实还活着"才算已在运行；否则清理僵尸引用，避免误判后永不真正拉起
      if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
        return resolve({ ok: true, alreadyRunning: true });
      }
      if (this.proc) {
        console.warn('[dsh-manager] 检测到已退出的进程引用（僵尸），清理后继续启动');
        this.proc = null;
        this.ready = false;
      }
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
      // 日志落盘失败（磁盘满/权限）不得让网关进程崩溃
      logStream.on('error', (e) => console.warn('[dsh-manager] DSH 日志写入失败(已忽略):', e.message));
      const env = {
        ...process.env,
        DSH_PORT: String(DSH_PORT),
        PROXY_PORT: String(process.env.PROXY_PORT || 3080),
        NPM_CONFIG_REGISTRY: this.registry,
        NPM_REGISTRY: this.registry,
        PNPM_REGISTRY: this.registry,
        // DSH 的语义是「$DSH_HOME 本身就是 harness home」（profile 位于 $DSH_HOME/profiles/<name>，
        // 见 @deepseek-ai/dsh-home-paths 的 resolveDshHome），而本项目其余代码一律把 harness home
        // 视为 $DSH_HOME/.dsh（即 DSH_DIR）。若直接把容器级 DSH_HOME（默认 /root）透传给子进程，
        // DSH 会去读 /root/profiles/web（只有 dsh-base + dsh-web-app 两个官方 bundle），
        // 于是安装到 /root/.dsh/profiles/web 的预装/自定义插件（dshmarket 市场、浏览器桌面、
        // 思考强度等）永远不会被加载。这里显式把子进程的 DSH_HOME 收敛到 DSH_DIR，与全项目对齐。
        DSH_HOME: DSH_DIR
      };
      // 彻底剥离 NODE_ENV=production，恢复纯净开发环境，避免工作区 install 跳过 devDependencies
      delete env.NODE_ENV;

      const p = spawn('dsh', ['web', '--port', String(DSH_PORT), '--no-open'], {
        cwd: DSH_WORKSPACE,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.proc = p;

      // 日志脱敏：DSH 启动时会把访问令牌明文打印到 stdout（`dsh web: ...?token=xxx`），
      // 在落盘 / 转发 / Admin 回溯视图之前统一抹掉，避免明文凭据长期堆积在日志里。
      const redactLog = (d) => String(Buffer.isBuffer(d) ? d.toString('utf8') : d)
        .replace(/([?&]token=)[A-Za-z0-9._~-]+/gi, '$1<redacted>');

      p.stdout.on('data', d => {
        const safe = redactLog(d);
        logStream.write(safe);
        process.stdout.write(safe);

        // 收集最近日志用于崩溃根因排查（同样脱敏，避免令牌进入 Admin 回溯视图）
        const str = d.toString('utf8');
        const lines = str.split('\n').filter(Boolean);
        for (const l of lines) {
          this.recentLogs.push(redactLog(l));
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
        const safe = redactLog(d);
        logStream.write(safe);
        process.stderr.write(safe);

        const str = d.toString('utf8');
        const lines = str.split('\n').filter(Boolean);
        for (const l of lines) {
          this.recentLogs.push(redactLog(l));
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
        // 先记录"退出前是否已就绪"：下面会把 ready 置 false，
        // 若直接判断 this.ready 会导致崩溃重启/熔断分支永远不可达（旧实现的隐藏 bug）。
        const wasReady = this.ready;
        if (this.proc === p) {
          this.proc = null;
          this.ready = false;
        }
        // 若处于手动停止状态，不自动拉起
        if (this.manualStopped) {
          console.log('[dsh-manager] DSH 处于手动停止状态，守护管理器已暂停自动重新拉起');
          return;
        }
        // 若在启动就绪探活期间即发生异常退出，由下方 waitReady 统一负责故障诊断、插件自动隔离与净化重启；
        // 此处仅针对曾经成功就绪、但在后续运行中意外崩溃的情况执行带指数退避的守护重启，杜绝双重拉起与竞争
        if (!wasReady) {
          return;
        }
        // 若非主动调用 stop()，自动执行守护拉起（带"滑动窗口"熔断保护）
        // 关键：不能再用"一次就绪成功就清零"——坏插件最典型的形态就是"就绪后立刻崩溃"，
        // 那样每轮计数都回到 1，退避与熔断永不触发，形成无上限重启风暴。
        if (!this.stopping && !this.installing) {
          const now = Date.now();
          const CRASH_WINDOW_MS = 120000; // 2 分钟滑动窗口
          const MAX_CRASHES = 5;

          // 曾稳定运行超过一个窗口 → 视为健康历史，清空窗口
          if (this.startTime && now - this.startTime > CRASH_WINDOW_MS) {
            this.crashWindow = [];
          }
          this.crashWindow = (this.crashWindow || []).filter(t => now - t < CRASH_WINDOW_MS);
          this.crashWindow.push(now);
          this.lastCrashTime = now;
          const crashes = this.crashWindow.length;

          if (crashes > MAX_CRASHES) {
            console.error(`[dsh-manager] 警告: DSH 在 ${CRASH_WINDOW_MS / 1000}s 内已崩溃 ${crashes} 次（>${MAX_CRASHES}），已暂停自动拉起以保护系统。请在管理后台检查配置或恢复快照。`);
            return;
          }

          const delay = Math.min(1000 * Math.pow(1.5, crashes - 1), 10000);
          console.log(`[dsh-manager] DSH 进程退出，守护管理器将在 ${(delay / 1000).toFixed(1)} 秒后自动重新拉起 DSH（窗口内第 ${crashes} 次）...`);
          clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            if (!this.stopping && !this.installing && !this.proc) {
              this.boot().catch(err => console.error('[dsh-manager] 自动拉起 DSH 失败:', err.message));
            }
          }, delay);
        }
      });

      // 等待真正就绪（杜绝外部假冒就绪）
      // 注意：外层是 new Promise(async executor)，回调里任何抛出都会让该 Promise 永不 settle
      // （这是旧实现的真实死锁来源——会把串行队列一起卡死）。这里显式 try/catch + catch 兜底。
      this.waitReady(60000, onProbe).then(async ok => {
       try {
        this.ready = ok;
        console.log(ok ? '[dsh-manager] DSH 已就绪' : '[dsh-manager] DSH 启动超时或崩溃');
        if (ok) {
          this.autoHealCountInCurrentBoot = 0;
          this.startTime = Date.now();
          if (this.launchToken) {
            await this.exchangeSessionCookie(this.launchToken);
          }
          return resolve({ ok: true });
        }

        // ==========================================================
        // 【启动失败自愈与故障插件自动隔离】
        // 限制：1. 开启了自愈功能 (autoHealEnabled)
        //       2. 单次启动周期内累计隔离未超过上限 (上限: 3 个)
        //       3. 未处于主动停止或升级安装状态
        // ==========================================================
        if (this.autoHealEnabled && !this.stopping && !this.installing) {
          if (this.autoHealCountInCurrentBoot < this.maxAutoHealPerBoot) {
            const detected = this.detectCrashingPlugin(this.recentLogs);
            if (detected) {
              this.autoHealCountInCurrentBoot++;
              console.warn(`[dsh-manager] 🛡️ 【启动故障自愈触发 (${this.autoHealCountInCurrentBoot}/${this.maxAutoHealPerBoot})】检测到拓展「${detected.name}」引发 DSH 启动失败 (${detected.matched})！`);
              console.log(`[dsh-manager] 正在自动隔离并停用拓展「${detected.name}」以恢复系统可用性...`);

              try {
                const pm = require('./plugin-manager');
                // P6：togglePlugin 现在会在 profile 写锁内完成"读-改-写"，必须 await
                await pm.togglePlugin(detected.name, false);

                const event = {
                  id: 'heal-' + Date.now(),
                  plugin: detected.name,
                  reason: detected.matched,
                  time: Date.now(),
                  logSnippet: this.recentLogs.slice(-20).join('\n')
                };
                this.autoIsolatedEvents.unshift(event);
                if (this.autoIsolatedEvents.length > 10) this.autoIsolatedEvents.pop();

                console.log(`[dsh-manager] 拓展「${detected.name}」已自动停用并固化状态，立即重新拉起 DSH 核心...`);
                await ensurePortReleased(DSH_PORT, 3000);
                const healBootRes = await this._bootInternal(onProbe);
                return resolve(healBootRes);
              } catch (healErr) {
                console.error('[dsh-manager] 执行插件自动隔离失败:', healErr.message);
              }
            } else {
              console.log('[dsh-manager] 未能从最近运行日志中定位到明确的第三方故障拓展，跳过自动隔离');
            }
          } else {
            console.warn(`[dsh-manager] ⚠️ 当前启动周期内自动隔离拓展次数已达上限 (${this.maxAutoHealPerBoot} 个)，已停止自动隔离以防死锁`);
          }
        }

        resolve({ ok: false });
       } catch (e) {
        console.error('[dsh-manager] 启动后就绪处理异常（已兜底 resolve）:', (e && e.message) || e);
        resolve({ ok: false, error: (e && e.message) || String(e) });
       }
      }).catch(err => {
        console.error('[dsh-manager] waitReady 异常（已兜底 resolve）:', (err && err.message) || err);
        resolve({ ok: false, error: (err && err.message) || String(err) });
      });
  }

  // 对外入口：串行化后执行真正的停止逻辑
  stop() {
    return this._enqueue(() => this._stopInternal());
  }

  _stopInternal() {
    return new Promise(resolve => {
      this.stopping = true;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.crashWindow = [];

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
      let settled = false;
      const done = (extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        this.stopping = false;
        resolve({ ok: true, ...extra });
      };

      const timer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch {}
        killPortProcess(DSH_PORT);
      }, 4000);

      // 兜底：极端情况下进程杀不掉/exit 事件丢失时也必须返回，避免调用方（含串行队列）永久挂起
      const hardTimer = setTimeout(() => {
        console.warn('[dsh-manager] 停止 DSH 超时（9s），强制返回');
        done({ forced: true });
      }, 9000);

      p.once('exit', async () => {
        try { await ensurePortReleased(DSH_PORT, 2500); } catch {}
        done();
      });

      try {
        p.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  // 重启 = 同一个队列任务内先停后起，避免中间被其它操作插入
  async restart(onProbe) {
    return this._enqueue(async () => {
      await this._stopInternal();
      return this._bootInternal(onProbe);
    });
  }

  async exchangeSessionCookie(token = this.launchToken) {
    if (!token) return '';
    const targetUrl = `http://127.0.0.1:${DSH_PORT}/?token=${encodeURIComponent(token)}`;
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: { 'Host': `127.0.0.1:${DSH_PORT}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000)
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
        // 必须带超时：若端口被"连上但不响应"的进程占住，无超时的 fetch 会让整个探活循环永久挂起
        const res = await fetch(`http://127.0.0.1:${DSH_PORT}/`, { signal: AbortSignal.timeout(3000) });
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

  /** 版本号是否合法（供 Admin API 入口复用同一套校验） */
  isValidVersion(value) {
    return isValidVersion(value);
  }

  async installVersion(version, onProgress, onLog) {
    // 入口强校验：版本号必须是合法 semver，杜绝 `../` 目录穿越与 npm 说明符注入
    const normalizedVersion = typeof version === 'string' ? version.trim() : '';
    if (!isValidVersion(normalizedVersion)) {
      return { ok: false, error: `版本号格式不合法: ${String(version).slice(0, 64)}` };
    }
    version = normalizedVersion;

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
      // 纵深防御：即便 previousVersion 来自 package.json，也强制落在缓存目录内
      let prevBackup;
      try {
        prevBackup = resolveWithinDir(this.versionsCacheDir, previousVersion);
      } catch (e) {
        log(`⚠️ 跳过本地快照（当前版本号不合法）: ${e.message}`);
        prevBackup = path.join(this.versionsCacheDir, '.invalid-' + Date.now());
      }
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
      const targetCached = resolveWithinDir(this.versionsCacheDir, version);
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
      // M5：切换成功后必须让版本缓存失效，否则 getStatus().version 与"回滚目标"都会停留在旧值
      this.lastKnownVersion = '';
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
        const prevCached = resolveWithinDir(this.versionsCacheDir, previousVersion);
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
        this.lastKnownVersion = ''; // 回滚后同样让版本缓存失效
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
