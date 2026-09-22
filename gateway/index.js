const http = require('http');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');

const {
  isAuthEnabled,
  isSetupRequired,
  isWeakPassword,
  verifyToken,
  checkRequestAuth,
  setAuthCookie,
  clearAuthCookie,
  checkRateLimit,
  recordAuthAttempt,
  resolveClientIp,
  setTrustProxy,
  updateAuthToken,
  getAuthToken
} = require('./auth');

const { ensureUpstreamCookie, injectPolyfill } = require('./token-crawler');
const desktopManager = require('./desktop-manager');
const dshManager = require('./dsh-manager');
const backupService = require('./backup-service');
const pluginManager = require('./plugin-manager');
const versionService = require('./version-service');
const { getInternalToken, verifyInternalToken } = require('./internal-token');
const wsOrigin = require('./ws-origin');

// ── 配置文件持久化与动态读取 ──────────────────────────────────
const CONFIG_FILE = process.env.GATEWAY_CONFIG_FILE || '/root/.dsh/gateway.config.json';

function loadPersistedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('[gateway] 成功加载持久化网关配置文件:', CONFIG_FILE);
      return data;
    }
  } catch (err) {
    console.warn('[gateway] 读取持久化配置失败:', err.message);
  }
  return {};
}

function savePersistedConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    // 该文件包含 authToken 等敏感字段：写入即收紧为 0600（仅属主可读写）
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    return true;
  } catch (err) {
    console.error('[gateway] 保存持久化配置失败:', err.message);
    return false;
  }
}

/**
 * 回给管理后台的错误文案（N1）：抹掉宿主绝对路径等内部细节，完整错误只写服务端日志。
 * 管理 API 本身在鉴权之后，这里防的是"错误串里带出宿主目录/内部路径"这类信息外溢。
 */
function safeErrMsg(err) {
  const raw = err && err.message ? String(err.message) : String(err ?? '未知错误');
  console.error('[gateway] API 错误:', raw);
  return raw.replace(/(?:\/[\w.@%+-]+){2,}/g, '<path>').slice(0, 300);
}

// 局部合并写入持久化配置的 desktop 段（供「彻底开关」等运行时开关使用，不影响其它字段）
function persistDesktopConfig(patch = {}) {
  try {
    const cfg = loadPersistedConfig();
    cfg.desktop = { ...(cfg.desktop || {}), ...patch };
    cfg.savedAt = new Date().toISOString();
    if (!savePersistedConfig(cfg)) return null;
    console.log('[gateway] 已持久化桌面配置:', JSON.stringify(patch));
    return cfg;
  } catch (err) {
    console.error('[gateway] 持久化桌面配置异常:', err.message);
    return null;
  }
}

// 桌面运行参数补丁的规范化（enabled 除外，总开关走专用接口）
function normalizeDesktopConfigPatch(input = {}) {
  const patch = {};
  const w = Number(input.width), h = Number(input.height);
  if (w > 0) patch.width = w;
  if (h > 0) patch.height = h;
  if (typeof input.idleTimeoutMinutes === 'number') patch.idleTimeoutMinutes = input.idleTimeoutMinutes;
  if (typeof input.enableCdp === 'boolean') patch.enableCdp = input.enableCdp;
  const cdp = Number(input.cdpPort);
  if (cdp > 0) patch.cdpPort = cdp;
  if (typeof input.enableSidebarTab === 'boolean') patch.enableSidebarTab = input.enableSidebarTab;
  if (typeof input.screenshotQuality === 'string' && ['high', 'medium', 'low'].includes(input.screenshotQuality)) {
    patch.screenshotQuality = input.screenshotQuality;
  }
  if (typeof input.screenshotDir === 'string') patch.screenshotDir = input.screenshotDir.trim();
  return patch;
}

// 桌面运行参数的唯一写入路径：持久化 + 应用（Admin 页与内部插件共用）
function applyDesktopConfigPatch(input = {}) {
  const patch = normalizeDesktopConfigPatch(input);
  if (!Object.keys(patch).length) return { ok: false, error: '没有可应用的配置项' };
  if (!persistDesktopConfig(patch)) return { ok: false, error: '桌面配置持久化失败，操作已取消' };
  const changed = desktopManager.applyConfig(patch);
  return { ok: true, changed, desktop: desktopManager.getStatus() };
}

// 浏览器总开关的唯一写入路径：持久化 + 立即启停
async function applyDesktopMaster(enabled, opts = {}) {
  const next = enabled !== false;
  const startNow = opts.startNow !== false; // 启用时默认立即拉起桌面；镜像调用可传 false 只改状态
  // 约定：插件停用 → 浏览器也不能用。插件被禁用时不允许再把浏览器开关打开。
  if (next && isBrowserPluginDisabled()) {
    return { ok: false, error: '浏览器插件已被停用：请先在「拓展与插件管理」页启用插件，再启用浏览器' };
  }
  if (!persistDesktopConfig({ enabled: next })) {
    return { ok: false, error: '浏览器总开关持久化失败，操作已取消' };
  }
  desktopManager.setEnabled(next);
  let r = { ok: true, skipped: true };
  if (next && startNow) r = await desktopManager.start();
  else if (!next) r = await desktopManager.stop();
  return { ok: true, enabled: next, result: r, desktop: desktopManager.getStatus() };
}

// 本插件：浏览器能力与 AI 工具的唯一来源
const BROWSER_DESKTOP_PLUGIN = '@dsh-custom/dsh-browser-desktop';

// 插件是否被「显式禁用」（安装着但不在 bundles 中）。
// 注意：插件从未安装（不存在）时返回 false，不影响无插件部署的桌面自举。
function isBrowserPluginDisabled() {
  try {
    const list = pluginManager.getPlugins().plugins || [];
    const p = list.find(x => x.name === BROWSER_DESKTOP_PLUGIN);
    return !!p && p.enabled === false;
  } catch {
    return false;
  }
}

// 浏览器被「彻底停用」后访问 VNC 的提示页（避免只看到黑屏 / 连接失败而无解释）
function serveDesktopDisabledPage(res) {
  const adminPath = ADMIN_PATH || '/admin';
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>容器浏览器已停用</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e5e7eb;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .box{max-width:560px;padding:32px 36px;border:1px solid #2c2c2e;border-radius:14px;background:#1b1b1c;text-align:center}
  h1{font-size:18px;margin:0 0 12px}
  p{font-size:13px;line-height:1.8;color:#9ca3af;margin:0 0 20px}
  a{display:inline-block;padding:9px 18px;border-radius:8px;background:#4176e6;color:#fff;text-decoration:none;font-size:13px}
</style></head>
<body><div class="box">
  <h1>🖥️ 容器浏览器当前不可用</h1>
  <p>原因：浏览器已在管理后台被「彻底停用」，或浏览器插件已被停用。<br>当前容器不会启动 Xvfb / Chromium 桌面，因此 VNC 无法连接。<br>如需继续使用，请在管理后台「浏览器与桌面控制」页点击「启用浏览器」。</p>
  <a href="${adminPath}/">前往管理后台启用</a>
</div></body></html>`;
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache' });
  res.end(html);
}

// 是否为「浏览器直接导航」（HTML 页面请求）。用于在桌面尚未就绪时返回可自动刷新的页面，
// 而不是把 HTML 塞进资源请求、或让用户看到裸 JSON / 502。
function isHtmlNavigation(req) {
  return !!req && req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

// 桌面/浏览器「启动中」独立页面：默认 3 秒后自动刷新，桌面就绪后无感进入 noVNC。
// 页面文件：gateway/public/desktop-starting.html（零外部依赖，可单独打开预览）。
function serveDesktopStartingPage(res, { retrySeconds = 3 } = {}) {
  const seconds = Number(retrySeconds) > 0 ? Number(retrySeconds) : 3;
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, 'public', 'desktop-starting.html'), 'utf8')
      .replace(/__DSH_ADMIN_PATH__/g, ADMIN_PATH)
      .replace('__DSH_RETRY_SECONDS__', String(seconds));
  } catch (err) {
    // 兜底：页面文件缺失也绝不回退到裸 JSON / 502
    html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="${seconds}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>容器桌面正在启动</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="text-align:center;font-size:14px">🖥️ 容器桌面正在启动，${seconds} 秒后自动刷新…</div>
</body></html>`;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  res.end(html);
}

const persisted = loadPersistedConfig();

// 是否信任反向代理（决定限流 IP 取 XFF 还是 socket 对端）：配置显式值优先于环境变量
if (persisted.trustProxy !== undefined) {
  setTrustProxy(persisted.trustProxy === true || persisted.trustProxy === '1' || persisted.trustProxy === 'true');
}

// 应用持久化认证码与桌面设置
// M13：显式环境变量 AUTH_TOKEN 优先于持久化口令 —— 否则在 .env 里轮换口令不生效
// （容器里会继续用数据卷中的旧口令，运维会以为已经换掉了）。
const AUTH_TOKEN_SOURCE = (process.env.AUTH_TOKEN || process.env.ACCESS_CODE || '').trim()
  ? 'env'
  : (persisted.authToken !== undefined ? 'persisted' : 'default');
if (AUTH_TOKEN_SOURCE !== 'env' && persisted.authToken !== undefined) {
  updateAuthToken(persisted.authToken);
}
if (AUTH_TOKEN_SOURCE === 'env') {
  console.log('[gateway] 认证口令来源: 环境变量 AUTH_TOKEN（优先于持久化配置）');
}
// M13：环境变量与持久化配置不一致时给出显式告警，避免"面板改了没生效"的静默困惑
function warnConfigConflict(label, envValue, persistedValue) {
  if (envValue === undefined || envValue === '' || persistedValue === undefined) return;
  if (String(envValue) !== String(persistedValue)) {
    console.warn(`[gateway] 配置冲突: ${label} 环境变量(${envValue}) 与持久化配置(${persistedValue}) 不一致，按 M13 规则以环境变量为准`);
  }
}
warnConfigConflict('PROXY_PORT', process.env.PROXY_PORT, persisted.proxyPort);
warnConfigConflict('ADMIN_PATH', process.env.ADMIN_PATH, persisted.adminPath);
warnConfigConflict('VNC_PATH', process.env.VNC_PATH, persisted.vncPath);
if (persisted.desktop) {
  desktopManager.updateConfig(persisted.desktop);
}
// 启动崩溃自愈与故障插件自动隔离（默认开启，单次启动周期上限默认 5 个，允许用户自定义）
const autoHealEnabled = persisted.autoHealPlugins !== false;
const autoHealMaxPerBoot = Math.max(1, Math.min(50, Number(persisted.autoHealMaxPerBoot) || 5));
dshManager.setAutoHeal(autoHealEnabled, autoHealMaxPerBoot);

// ── 端口与动态路径配置 ───────────────────────────────────────
// M13：显式环境变量优先于持久化配置（否则 .env 里的 PROXY_PORT 成了"死配置"，
// 面板改过端口后 compose 的 3080:3080 会静默失配）。
const PROXY_PORT_SOURCE = process.env.PROXY_PORT ? 'env' : (persisted.proxyPort ? 'persisted' : 'default');
const PROXY_PORT = Number(process.env.PROXY_PORT || persisted.proxyPort) || 3080;
process.env.PROXY_PORT = String(PROXY_PORT);
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const VNC_PORT = Number(process.env.VNC_PORT) || 6080;

function normalizeRoutePath(raw, defaultPath) {
  let p = (raw || defaultPath).trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');
  return p.length === 0 ? defaultPath : p;
}

const ADMIN_PATH_SOURCE = process.env.ADMIN_PATH ? 'env' : (persisted.adminPath ? 'persisted' : 'default');
const VNC_PATH_SOURCE = process.env.VNC_PATH ? 'env' : (persisted.vncPath ? 'persisted' : 'default');
const ADMIN_PATH = normalizeRoutePath(process.env.ADMIN_PATH || persisted.adminPath, '/admin');
const VNC_PATH = normalizeRoutePath(process.env.VNC_PATH || persisted.vncPath, '/vnc');
// 对外下发的 VNC 基地址统一带尾斜杠：任何消费者（侧边栏 iframe、跳转链接、第三方集成）
// 直接把它当 href / 拼相对路径，都不会因缺尾斜杠而把基准路径解析错（无需依赖 302 兜底）。
const VNC_PATH_HREF = VNC_PATH + '/';

const DSH_TARGET = 'http://127.0.0.1:' + DSH_PORT;
const VNC_TARGET = 'http://127.0.0.1:' + VNC_PORT;

// 对外主机名白名单（WebSocket 同源校验用）：配置 / 环境变量里的显式值，逗号分隔。
// 例如部署在域名 https://dsh.example.com 后，可设 PUBLIC_HOST=dsh.example.com。
const PUBLIC_HOSTS = String(persisted.publicHost || process.env.PUBLIC_HOST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PUBLIC_PATHS = new Set([
  '/login',
  '/favicon.ico',
  '/favicon.svg',
  '/manifest.webmanifest'
]);

// ── 反向代理实例与容错处理 ─────────────────────────────────
const dshProxy = httpProxy.createProxyServer({
  target: DSH_TARGET,
  ws: true,
  changeOrigin: true
});

const vncProxy = httpProxy.createProxyServer({
  target: VNC_TARGET,
  ws: true,
  changeOrigin: true
});

dshProxy.on('error', (err, req, res) => {
  console.warn('[dsh-proxy] 上游连接等待中 (DSH 启动/停止阶段):', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    let errorMsg = 'DeepSeek Harness 正在启动就绪中，请稍候数秒后刷新';
    if (dshManager.manualStopped) {
      errorMsg = 'DeepSeek Harness 服务当前处于手动停止状态。如需使用，请前往管理面板手动点击【启动 DSH】。';
    } else if (dshManager.lastExitInfo && !dshManager.proc) {
      errorMsg = `DeepSeek Harness 启动异常退出 (代码: ${dshManager.lastExitInfo.code || -1})。请前往 /admin/ 查看详细日志排查。`;
    }

    const isHtml = (req.headers.accept || '').includes('text/html');
    if (isHtml) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="5" />
  <title>DeepSeek Harness - 启动就绪中</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f8fafc; color: #0f172a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .box { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; max-width: 480px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.08); text-align: center; }
    h2 { font-size: 18px; margin-bottom: 12px; color: #1677ff; }
    p { font-size: 13px; color: #64748b; line-height: 1.6; margin-bottom: 20px; }
    .btn { display: inline-block; padding: 8px 16px; border-radius: 8px; background: #0f172a; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="box">
    <h2>⚡ DeepSeek Harness 启动就绪中</h2>
    <p>${errorMsg}<br/>页面将在 5 秒后自动刷新检测...</p>
    <a href="/admin/" class="btn">前往管理控制台查看实时日志 ↗</a>
  </div>
</body>
</html>`);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: errorMsg, exitInfo: dshManager.lastExitInfo }));
    }
  }
});

vncProxy.on('error', (err, req, res) => {
  console.warn('[vnc-proxy] 上游连接等待中 (VNC 启动阶段):', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    // 浏览器直接导航（noVNC 页面本身）时返回独立的「启动中」页（3s 自动刷新），
    // 避免用户看到原始 JSON 502 而误以为“桌面连不上”。
    if (isHtmlNavigation(req)) {
      return serveDesktopStartingPage(res);
    }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'VNC 图形桌面正在就绪中，请稍候数秒后刷新' }));
  }
});

vncProxy.on('proxyRes', (proxyRes, req, res) => {
  const ct = String(proxyRes.headers['content-type'] || '').toLowerCase();
  // 针对 noVNC 的 html 页面严禁客户端持久强缓存，保证镜像或版本更新后即刻拉取最新版本化入口
  if (ct.includes('text/html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
});

// Polyfill 与回环补丁
const LOOPBACK_NEEDLE_1 = 'isLoopbackHostname(pageLocation.hostname)';
const LOOPBACK_NEEDLE_2 = 'connection.isLoopback ? "host" : "memory"';
const LOOPBACK_NEEDLE_3 = 'connection.isLoopback?"host":"memory"';

dshProxy.on('proxyRes', (proxyRes, req, res) => {
  // 若上游遇到临时 401，自动重新触发握手重试
  if (proxyRes.statusCode === 401) {
    dshManager.exchangeSessionCookie().catch(() => {});
  }

  const ct = String(proxyRes.headers['content-type'] || '').toLowerCase();

  if (ct.includes('text/html')) {
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');

    // 严禁浏览器缓存 HTML 主入口，确保每次加载均获取最新组合包版本 (彻底消除 rev 过期 404)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    let injected = false;
    const origWrite = res.write.bind(res);
    res.write = function (chunk, ...rest) {
      if (!injected && chunk) {
        injected = true;
        let htmlStr = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        htmlStr = injectPolyfill(htmlStr);
        chunk = Buffer.from(htmlStr);
      }
      return origWrite(chunk, ...rest);
    };
    return;
  }

  if (ct.includes('javascript')) {
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');

    const chunks = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return true;
    };

    res.end = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      res.write = origWrite;
      res.end = origEnd;

      let body = Buffer.concat(chunks).toString('utf8');
      if (body.includes(LOOPBACK_NEEDLE_1)) body = body.split(LOOPBACK_NEEDLE_1).join('true');
      if (body.includes(LOOPBACK_NEEDLE_2)) body = body.split(LOOPBACK_NEEDLE_2).join('"host"');
      if (body.includes(LOOPBACK_NEEDLE_3)) body = body.split(LOOPBACK_NEEDLE_3).join('"host"');

      origEnd(Buffer.from(body), ...rest);
    };
  }
});

async function alignHeadersForDsh(req) {
  req.headers['host'] = '127.0.0.1:' + DSH_PORT;
  if (req.headers['origin']) req.headers['origin'] = DSH_TARGET;
  if (req.headers['sec-fetch-site'] === 'cross-site') req.headers['sec-fetch-site'] = 'same-origin';

  const pathname = (req.url || '').split('?')[0];
  if (pathname.endsWith('.js') || pathname.endsWith('.html') || pathname === '/' || pathname.startsWith('/plugins/')) {
    req.headers['accept-encoding'] = 'identity';
  }

  // 网关将动态捕获并换取的合法官方 dsh-auth-... 签名 Cookie 注入请求标头
  const upstreamCookie = (await dshManager.ensureValidUpstreamCookie()) || (await ensureUpstreamCookie(DSH_TARGET));
  if (upstreamCookie) {
    const existing = req.headers['cookie'] || '';
    req.headers['cookie'] = existing ? (existing + '; ' + upstreamCookie) : upstreamCookie;
  }
}

function serveStaticHtml(res, filename) {
  const filePath = path.join(__dirname, 'public', filename);
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('无法加载页面: ' + filename);
  }
}

function getClientIp(req) {
  // 限流用 IP 的解析策略见 auth.resolveClientIp：默认只用 socket 对端地址，
  // 仅当显式信任代理（TRUST_PROXY / gateway.config.json trustProxy）时才采用 XFF。
  return resolveClientIp(req);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 512) {
        req.destroy(new Error('Payload too large'));
        reject(new Error('请求体过大 (超过 512KB)'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

// ── Admin API 处理器 ─────────────────────────────────────────
async function handleAdminApi(req, res, pathname, query) {
  const subPath = pathname.slice(ADMIN_PATH.length);

  try {
    // 1. 全局状态
    if (subPath === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        project: {
          version: versionService.getLocalProjectVersion()
        },
        dsh: dshManager.getStatus(),
        desktop: desktopManager.getStatus(),
        paths: {
          admin: ADMIN_PATH,
          vnc: VNC_PATH_HREF,
          proxyPort: PROXY_PORT
        },
        authEnabled: isAuthEnabled(),
        authToken: isAuthEnabled() && getAuthToken() ? '******' : '',
        hasAuthToken: Boolean(getAuthToken()),
        autoHealPlugins: dshManager.autoHealEnabled,
        autoHealMaxPerBoot: dshManager.maxAutoHealPerBoot,
        autoIsolatedEvents: dshManager.getAutoIsolatedEvents()
      });
    }

    // 1.1 版本与多级安全预警检测 (支持多通道 CDN / GitHub / 本地兜底)
    if (subPath === '/api/version/check' && req.method === 'GET') {
      const force = query.get('refresh') === '1';
      const checkRes = await versionService.check(force, dshManager);
      return sendJson(res, 200, checkRes);
    }

    // 2. DSH 版本列表
    if (subPath === '/api/dsh/versions' && req.method === 'GET') {
      const force = query.get('refresh') === '1';
      const data = await dshManager.fetchAvailableVersions(force);
      if (Array.isArray(data.versions)) {
        data.versionEvaluations = {};
        for (const v of data.versions) {
          data.versionEvaluations[v] = versionService.evaluateTargetVersion(v);
        }
      }
      return sendJson(res, 200, data);
    }

    // 2.1 DSH 实时日志与崩溃信息获取
    if (subPath === '/api/dsh/logs' && req.method === 'GET') {
      const count = Math.min(Number(query.get('lines')) || 100, 300);
      return sendJson(res, 200, {
        ok: true,
        running: dshManager.proc !== null && dshManager.proc.exitCode === null,
        ready: dshManager.ready,
        pid: dshManager.proc ? dshManager.proc.pid : null,
        manualStopped: !!dshManager.manualStopped,
        exitInfo: dshManager.lastExitInfo,
        recentLogs: dshManager.getRecentLogs(count)
      });
    }

    // 3. 安装/切换 DSH 版本 (支持实时 SSE 流式推送详细日志)
    if (subPath === '/api/dsh/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const version = (body.version || '').trim();
      if (!version) return sendJson(res, 400, { ok: false, error: '版本号不能为空' });
      // 强校验：版本号必须是合法 semver（阻断 `../` 目录穿越与 npm 说明符注入）
      if (!dshManager.isValidVersion(version)) {
        return sendJson(res, 400, { ok: false, error: '版本号格式不合法（仅允许形如 0.1.6-alpha.2 的版本号）' });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });

      const sendEvt = (data) => {
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
      };

      const r = await dshManager.installVersion(
        version,
        (prog) => {
          sendEvt({ type: 'progress', ...prog });
        },
        (line) => {
          sendEvt({ type: 'log', message: line });
        }
      );

      sendEvt({ type: 'done', ...r });
      res.end();
      return;
    }

    // 4. DSH 服务启停与重启控制
    if (subPath === '/api/dsh/start' && req.method === 'POST') {
      dshManager.manualStopped = false;
      const r = await dshManager.boot();
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/dsh/stop' && req.method === 'POST') {
      dshManager.manualStopped = true;
      const r = await dshManager.stop();
      return sendJson(res, 200, r);
    }

    if (subPath === '/api/dsh/restart' && req.method === 'POST') {
      dshManager.manualStopped = false;
      const r = await dshManager.restart();
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/dsh/auto-heal/clear' && req.method === 'POST') {
      dshManager.clearAutoIsolatedEvents();
      return sendJson(res, 200, { ok: true });
    }

    // 5. 桌面启停控制
    // 5.1 「彻底开关」总开关：持久化，停用后连网关/容器重启也不再自动启动
    if (subPath === '/api/desktop/master' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await applyDesktopMaster(body?.enabled !== false);
      if (!r.ok) return sendJson(res, 500, r);
      // AI 工具与提示词菜单的增/删由插件在【服务重启】时确定：restart=true 时立即重启 DSH
      if (body?.restart === true) {
        console.log('[gateway] 浏览器总开关已切换，正在重启 DSH 以同步 AI 工具菜单...');
        const rr = await dshManager.restart().catch(err => ({ ok: false, error: safeErrMsg(err) }));
        r.dshRestarted = !!rr.ok;
        if (!r.dshRestarted) r.warning = '状态已保存且桌面已停用，但 DSH 重启失败：' + (rr.error || '未知错误');
      }
      return sendJson(res, 200, r);
    }

    // 5.2 桌面运行参数（分辨率/休眠/CDP/截图默认值/侧边栏Tab）：
    //     Admin「浏览器与桌面控制」页是唯一权威写入点，直接持久化到 gateway.config.json
    if (subPath === '/api/desktop/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = applyDesktopConfigPatch(body);
      return sendJson(res, r.ok ? 200 : (r.error?.includes('没有可应用') ? 400 : 500), r);
    }

    if (subPath === '/api/desktop/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await desktopManager.start(body);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/desktop/stop' && req.method === 'POST') {
      const r = await desktopManager.stop();
      return sendJson(res, 200, r);
    }

    if (subPath === '/api/desktop/restart' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await desktopManager.restart(body);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/desktop/keepalive' && req.method === 'POST') {
      const body = await readJsonBody(req);
      desktopManager.applyConfig(body);
      desktopManager.touchActivity(body.durationMinutes);
      return sendJson(res, 200, { ok: true, status: desktopManager.getStatus() });
    }

    // 6. 配置快照备份、恢复与导入 (完全与 Web 服务解耦，异步非阻塞执行)
    if (subPath === '/api/snapshots' && req.method === 'GET') {
      return sendJson(res, 200, backupService.listBackups());
    }

    if (subPath === '/api/snapshots/create' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const r = await backupService.createBackup(body.name, body.type || body.backupType);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const r = await backupService.restoreBackup(body.filename, dshManager);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/import' && req.method === 'POST') {
      const filename = query.get('filename') || req.headers['x-filename'] || 'imported-snapshot.tar.gz';
      try {
        const r = await backupService.importBackupStream(req, filename);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/snapshots/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = backupService.deleteBackup(body.filename);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/snapshots/download' && req.method === 'GET') {
      const file = query.get('file') || '';
      const filePath = backupService.getBackupPath(file);
      if (!filePath) return sendJson(res, 404, { ok: false, error: '快照文件未找到' });

      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="' + path.basename(filePath) + '"'
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    // 6.5 DSH 拓展插件识别、启用/禁用与清理卸载
    if (subPath === '/api/plugins' && req.method === 'GET') {
      try {
        const r = pluginManager.getPlugins();
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/plugins/toggle' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (!body || !body.name) throw new Error('缺少插件名称');
        const enabled = body.enabled !== false;
        const r = await pluginManager.togglePlugin(body.name, enabled);
        // 与浏览器总开关保持一致（"插件停用 → 浏览器也用不了"）：
        // 禁用本插件时顺带彻底停用浏览器；启用时恢复总开关（不强行拉起桌面，按需启动）。
        let desktopMirrored = null;
        if (body.name === BROWSER_DESKTOP_PLUGIN) {
          const m = await applyDesktopMaster(enabled, { startNow: false });
          desktopMirrored = m.ok === true;
        }
        // restart=true 时立即重启 DSH，使 bundle 启停真正生效（否则需用户手动重启）
        let restarted = false;
        if (body.restart === true) {
          console.log(`[gateway] 插件 ${body.name} 已${enabled ? '启用' : '禁用'}，正在重启 DSH 以生效...`);
          const rr = await dshManager.restart().catch(err => ({ ok: false, error: safeErrMsg(err) }));
          restarted = !!rr.ok;
          if (!restarted) {
            // 状态已持久化，仅本次自动重启失败：如实返回，避免用户误以为已生效
            return sendJson(res, 500, { ...r, restarted: false, error: '插件状态已保存，但 DSH 自动重启失败: ' + (rr.error || '未知错误') });
          }
        }
        return sendJson(res, 200, { ...r, restarted, desktopMirrored });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/plugins/uninstall' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (!body || !body.name) throw new Error('缺少插件名称');
        const r = await pluginManager.uninstallPlugin(body.name);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    if (subPath === '/api/plugins/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (!body || !body.name) throw new Error('缺少插件名称');
        const r = await pluginManager.installPlugin(body.name);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
      }
    }

    // 7. 保存网关与系统配置并立即重启
    if (subPath === '/api/config/save' && req.method === 'POST') {
      const body = await readJsonBody(req);

      const newPort = Number(body.proxyPort) || PROXY_PORT;
      if (newPort < 1 || newPort > 65535) {
        return sendJson(res, 400, { ok: false, error: '端口号必须在 1 ~ 65535 范围内' });
      }

      const newAdmin = normalizeRoutePath(body.adminPath, '/admin');
      const newVnc = normalizeRoutePath(body.vncPath, '/vnc');
      if (newAdmin === newVnc) {
        return sendJson(res, 400, { ok: false, error: '管理后台路径与 VNC 路径不能相同' });
      }

      const newCdpPort = Number(body.cdpPort) || 9222;
      const enableCdp = body.enableCdp !== false;
      const newResolution = (body.resolution || '1440x900').trim();
      const parts = newResolution.split('x');
      const width = parseInt(parts[0]) || 1440;
      const height = parseInt(parts[1]) || 900;
      const idleTimeoutMinutes = body.idleTimeoutMinutes !== undefined ? Number(body.idleTimeoutMinutes) : 30;

      let updatedToken = getAuthToken();
      if (body.clearAuthToken === true) {
        updatedToken = '';
      } else if (body.authToken !== undefined && body.authToken !== '' && body.authToken !== '******') {
        updatedToken = String(body.authToken).trim();
      }
      // 口令强度校验：拒绝弱口令（与初始化向导同一套规则）
      if (updatedToken && updatedToken !== getAuthToken() && isWeakPassword(updatedToken)) {
        return sendJson(res, 400, { ok: false, error: '访问口令过弱：长度至少 6 位，且不要使用 admin / password 等常见弱口令' });
      }

      const autoHealPlugins = body.autoHealPlugins !== false;
      const autoHealMaxPerBoot = Math.max(1, Math.min(50, Number(body.autoHealMaxPerBoot) || 5));
      dshManager.setAutoHeal(autoHealPlugins, autoHealMaxPerBoot);

      // 桌面运行参数以 DesktopManager 当前值为准（权威在「浏览器与桌面控制」页）
      const ds = desktopManager.getStatus();

      const newCfg = {
        proxyPort: newPort,
        adminPath: newAdmin,
        vncPath: newVnc,
        authToken: updatedToken,
        autoHealPlugins,
        autoHealMaxPerBoot,
        desktop: {
          // 桌面运行参数一律以 DesktopManager 当前值为准（权威在 Admin「浏览器与桌面控制」页），
          // 此页保存网关/系统配置时不得覆盖，避免形成第二个写入点。
          enabled: desktopManager.isEnabled(),
          width: ds.width,
          height: ds.height,
          enableCdp: ds.enableCdp,
          cdpPort: ds.cdpPort,
          idleTimeoutMinutes: ds.idleTimeoutMinutes,
          enableSidebarTab: ds.enableSidebarTab,
          screenshotQuality: ds.screenshotQuality,
          screenshotDir: ds.screenshotDir
        },
        savedAt: new Date().toISOString()
      };

      const saved = savePersistedConfig(newCfg);
      if (!saved) {
        return sendJson(res, 500, { ok: false, error: '持久化配置文件写入失败' });
      }

      const logSafeCfg = {
        ...newCfg,
        authToken: newCfg.authToken ? '******' : ''
      };
      console.log('[gateway] 管理后台提交新配置:', logSafeCfg);

      // 返回跳转新 URL 信息
      sendJson(res, 200, {
        ok: true,
        message: '配置已持久化保存，网关服务将在 1 秒后重启生效...',
        newPort,
        newAdminPath: newAdmin,
        newVncPath: newVnc
      });

      // 延迟触发重启
      setTimeout(async () => {
        console.log('[gateway] 执行重启以应用新网关配置...');
        // 先优雅停止桌面并等待进程真正退出，避免新网关启动时撞上未退场的旧进程
        await desktopManager.stop();
        await dshManager.stop();
        process.exit(0);
      }, 800);

      return;
    }

    return sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
  }
}

// ── 内部桌面控制 API (供本地插件调用) ─────────────────────────
async function handleInternalDesktopApi(req, res, pathname) {
  try {
    const action = pathname.replace('/__internal/desktop/', '').trim();
    // 附带网关权威的 VNC 路径，供插件生成正确的 vncUrl（避免沿用过期的本地/补丁配置）
    if (action === 'status') return sendJson(res, 200, { ...desktopManager.getStatus(), vncPath: VNC_PATH_HREF });

    const body = await readJsonBody(req);
    // 内部（loopback）权威写入路径：供插件做一次性迁移 / 与 Admin 保持同一权威
    if (action === 'config') {
      const r = applyDesktopConfigPatch(body);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (action === 'master') {
      const r = await applyDesktopMaster(body?.enabled !== false);
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (action === 'start') {
      const r = await desktopManager.start(body);
      return sendJson(res, 200, r);
    }
    if (action === 'stop') {
      const r = await desktopManager.stop();
      return sendJson(res, 200, r);
    }
    if (action === 'restart') {
      const r = await desktopManager.restart(body);
      return sendJson(res, 200, r);
    }
    if (action === 'keepalive') {
      desktopManager.applyConfig(body);
      desktopManager.touchActivity(body.durationMinutes);
      return sendJson(res, 200, { ok: true, status: desktopManager.getStatus() });
    }
    return sendJson(res, 404, { ok: false, error: '未知操作' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: safeErrMsg(err) });
  }
}

function handleAuthVerify(req, res) {
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: rateLimit.error }));
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 64) req.destroy();
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const token = (data.token || '').trim();
      if (verifyToken(token)) {
        recordAuthAttempt(clientIp, true);
        setAuthCookie(res, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        recordAuthAttempt(clientIp, false);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '认证码错误，请重新输入' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '请求数据格式错误' }));
    }
  });
}

// 初始化向导提交：设置访问口令（仅在"尚未设置"时可用）
function handleSetupSubmit(req, res) {
  if (!isSetupRequired()) {
    return sendJson(res, 409, { ok: false, error: '访问口令已设置；如需修改请前往管理后台' });
  }
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) return sendJson(res, 429, { ok: false, error: rateLimit.error });

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 64) req.destroy();
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const pwd = typeof data.password === 'string' ? data.password : '';
      const confirm = typeof data.confirm === 'string' ? data.confirm : '';
      if (!pwd || !confirm) return sendJson(res, 400, { ok: false, error: '请填写口令并二次确认' });
      if (pwd !== confirm) return sendJson(res, 400, { ok: false, error: '两次输入的口令不一致' });
      if (isWeakPassword(pwd)) return sendJson(res, 400, { ok: false, error: '口令过弱：长度至少 6 位，且不要使用常见弱口令' });

      // 合并写回，避免覆盖 desktop/paths 等其它持久化字段
      const cfg = loadPersistedConfig();
      cfg.authToken = pwd;
      cfg.savedAt = new Date().toISOString();
      if (!savePersistedConfig(cfg)) {
        return sendJson(res, 500, { ok: false, error: '口令持久化失败，请检查数据卷权限后重试' });
      }
      updateAuthToken(pwd);
      recordAuthAttempt(clientIp, true);
      setAuthCookie(res);
      console.log('[gateway] 已通过初始化向导设置访问口令');
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求数据格式错误' });
    }
  });
}

/**
 * WebSocket 同源校验（防 CSWSH）：实现见 ws-origin.js。
 * 关键点：**绝不采用 `x-forwarded-host`** —— 该头可被客户端伪造（或经代理原样透传），
 * 攻击者只要把它设成自己页面的域名，Origin 校验就会被绕过。
 * 现在只认「真实 `host` 头」+「显式配置的对外主机名」。
 */
function isAllowedWsOrigin(req) {
  return wsOrigin.isAllowedWsOrigin(req, PUBLIC_HOSTS);
}

// ── 主 HTTP 路由调度 ─────────────────────────────────────────
async function handleHttpRequest(req, res) {
  const rawUrl = req.url || '/';
  const safePath = '/' + rawUrl.replace(/^\/+/, '');
  const parsedUrl = new URL(safePath, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  req.url = pathname + parsedUrl.search;

  // 1. 公开路径白名单
  //    未设置访问口令时，登录页改为"初始化向导"，其余请求一律被引导到 /setup
  if (pathname === '/login') {
    if (isSetupRequired()) { res.writeHead(302, { Location: '/setup' }); return res.end(); }
    return serveStaticHtml(res, 'login.html');
  }
  if (pathname === '/__auth/verify' && req.method === 'POST') return handleAuthVerify(req, res);
  if (pathname === '/logout') {
    clearAuthCookie(res);
    res.writeHead(302, { Location: isSetupRequired() ? '/setup' : '/login' });
    return res.end();
  }
  if (pathname === '/setup' && req.method === 'GET') {
    // 口令已设置后不再展示初始化向导：否则会留下一个"看着能用、提交必然失败"的僵尸表单
    if (!isSetupRequired()) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return serveStaticHtml(res, 'setup.html');
  }
  if (pathname === '/__auth/setup' && req.method === 'POST') return handleSetupSubmit(req, res);

  // 免鉴权健康检查：供 Docker HEALTHCHECK / 负载均衡探活使用（不泄漏任何敏感信息）
  if (pathname === '/healthz') {
    const ds = desktopManager.getStatus();
    const dsh = dshManager.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      uptimeSeconds: Math.floor(process.uptime()),
      port: PROXY_PORT,
      authEnabled: isAuthEnabled(),
      setupRequired: isSetupRequired(),
      // M13：回显"实际生效值 + 来源"，便于排查 .env / 持久化配置 / 默认值之间的漂移
      configSource: {
        port: PROXY_PORT_SOURCE,
        adminPath: ADMIN_PATH_SOURCE,
        vncPath: VNC_PATH_SOURCE,
        authToken: AUTH_TOKEN_SOURCE
      },
      adminPath: ADMIN_PATH,
      vncPath: VNC_PATH,
      dsh: { running: !!dsh.running, ready: !!dsh.ready },
      desktop: { enabled: !!ds.enabled, running: !!ds.running }
    }));
  }

  if (pathname === '/favicon.svg' || pathname === '/favicon.ico') {
    const staticFile = path.join(__dirname, 'public', pathname.slice(1));
    if (fs.existsSync(staticFile)) {
      res.writeHead(200, {
        'Content-Type': pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/x-icon',
        'Cache-Control': 'public, max-age=86400'
      });
      return fs.createReadStream(staticFile).pipe(res);
    }
  }

  // 2. 本地回环 + 内部共享密钥的内部接口 (供容器内插件工具通信)
  //    仅凭"来源是回环"不够：网关若位于反向代理之后，外部请求的对端地址也会是 127.0.0.1。
  //    因此追加共享密钥校验（插件读 /root/.dsh/.internal-api-token，见 internal-token.js）。
  if (pathname.startsWith('/__internal/desktop/')) {
    const peer = wsOrigin.normalizeIp(req.socket && req.socket.remoteAddress);
    const isLoopbackReq = peer === '127.0.0.1' || peer === '::1';
    if (isLoopbackReq && verifyInternalToken(req)) {
      return handleInternalDesktopApi(req, res, pathname);
    }
    return sendJson(res, 403, { ok: false, error: '内部接口拒绝访问（需要回环来源 + 内部密钥）' });
  }

  // 3. 初始化闸门：未设置访问口令前，除上面的公开路径外一律不放行
  if (isSetupRequired()) {
    if (pathname.startsWith(ADMIN_PATH + '/api/') || pathname.startsWith('/__api/')) {
      return sendJson(res, 401, { ok: false, error: '尚未设置访问口令，请先访问 /setup 完成初始化', setupRequired: true });
    }
    const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
      res.writeHead(302, { Location: '/setup' });
      return res.end();
    }
    return sendJson(res, 401, { ok: false, error: '尚未设置访问口令，请先访问 /setup 完成初始化', setupRequired: true });
  }

  if (PUBLIC_PATHS.has(pathname)) {
    await alignHeadersForDsh(req);
    return dshProxy.web(req, res);
  }

  // 3. 统一身份鉴权校验 (未通过则统一拦截)
  if (!checkRequestAuth(req)) {
    const isHtmlNav = (req.headers.accept || '').includes('text/html') && req.method === 'GET';
    if (isHtmlNav) {
      const redirectTarget = encodeURIComponent(req.url || '/');
      res.writeHead(302, { Location: '/login?redirect=' + redirectTarget });
      return res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '未授权，请先登录' }));
    }
  }

  // 3.5 稳定桌面插件接口 (经鉴权后可用，提供与 ADMIN_PATH 解耦的稳定基准路径)
  if (pathname === '/__api/desktop/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      desktop: desktopManager.getStatus(),
      paths: { admin: ADMIN_PATH, vnc: VNC_PATH_HREF, proxyPort: PROXY_PORT }
    });
  }
  if (pathname === '/__api/desktop/start' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const r = await desktopManager.start(body);
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // 4. 自定义 Admin 路由 (ADMIN_PATH)
  if (pathname === ADMIN_PATH || pathname === ADMIN_PATH + '/') {
    return serveStaticHtml(res, 'admin.html');
  }
  if (pathname.startsWith(ADMIN_PATH + '/api/')) {
    return handleAdminApi(req, res, pathname, parsedUrl.searchParams);
  }

  // 5. 自定义 VNC 路由 (VNC_PATH)
  if (pathname === VNC_PATH || pathname.startsWith(VNC_PATH + '/')) {
    // 浏览器被管理后台「彻底停用」、或浏览器插件被停用时，给出明确提示页而不是让 noVNC 黑屏
    if (!desktopManager.isEnabled() || isBrowserPluginDisabled()) {
      return serveDesktopDisabledPage(res);
    }
    // 自动唤醒桌面：
    //   用「健康感知」的 getStatus().running 判断，而不是原始 this.running 标志。
    //   这样即使 Xvfb/Chromium 等关键进程已退出（例如用户把浏览器最后一个标签页/窗口关掉
    //   导致 Chromium 退出），打开 /vnc 也能自愈重启，而不是停在"空桌面"上。
    if (!desktopManager.getStatus().running) {
      desktopManager.start().catch(() => {});
      // 桌面尚未就绪：HTML 导航直接返回「启动中」独立页（3s 自动刷新），
      // 不再转发给还没监听的 websockify —— 从根上消除 502 / 裸 JSON / 黑屏。
      if (isHtmlNavigation(req)) {
        return serveDesktopStartingPage(res);
      }
    } else {
      desktopManager.touchActivity();
    }

    const novncRevision = process.env.NOVNC_ASSET_REVISION || '1.6.0';
    const versionedVncPath = `/novnc-${novncRevision}/vnc.html`;
    // websockify 端点必须下发【绝对路径】。noVNC 在浏览器侧用 `new URL(path, location.href)`
    // 解析 path 参数；由于 vnc.html 位于版本化子目录 (/vnc/novnc-<rev>/vnc.html)，
    // 相对路径 "vnc/websockify" 会被解析成 /vnc/novnc-<rev>/vnc/websockify（网关不认），
    // 导致 WebSocket 握手被拒 (1006)，页面显示 "Failed to connect"。
    const websockifyPath = `${VNC_PATH}/websockify`;

    // 5.1 访问桌面根入口 (如 /vnc 或 /vnc/) -> 302 自动重定向至带版本隔离的 vnc.html (附带防缓存头)
    if (pathname === VNC_PATH || pathname === VNC_PATH + '/') {
      res.writeHead(302, {
        Location: `${VNC_PATH}${versionedVncPath}?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=${websockifyPath}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      });
      return res.end();
    }

    // 5.2 兼容直接访问旧版未版本化路径 /vnc/vnc.html -> 自动无感重定向至最新版本化路径
    if (pathname === `${VNC_PATH}/vnc.html`) {
      const search = parsedUrl.search || `?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=${websockifyPath}`;
      res.writeHead(302, {
        Location: `${VNC_PATH}${versionedVncPath}${search}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      });
      return res.end();
    }

    // 重写前缀发给 noVNC 静态服务
    req.url = req.url.slice(VNC_PATH.length) || '/';
    return vncProxy.web(req, res);
  }

  // 6. DSH 主服务转发 (/*)
  await alignHeadersForDsh(req);
  dshProxy.web(req, res);
}

// 请求级异常兜底：单个请求出错只影响该请求，绝不拖垮整个网关进程
function handleRequestCrash(err, req, res) {
  console.error('[gateway] HTTP 请求处理异常:', (err && err.stack) || err);
  try {
    if (res && !res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '网关内部错误' }));
    } else if (res && typeof res.end === 'function') {
      res.end();
    }
  } catch {}
}

const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => handleRequestCrash(err, req, res));
});

// M15 请求级超时：防慢速请求长期占用连接（SSE / WebSocket 不受影响）
server.headersTimeout = 20000;
server.keepAliveTimeout = 15000;
server.requestTimeout = 600000; // 允许大快照上传，但仍有上界
// headersTimeout 的生效依赖周期性检查，默认间隔 30s 会导致"最坏要等 ~50s 才断开"；
// 收紧到 5s，让慢速请求在 ~20s 内被及时断开。
server.connectionsCheckingInterval = 5000;
// 补充：Node 的 headersTimeout 对"连上但一个字节都没发"的连接不生效（实测 40s 仍未断），
// 这里显式加连接级守卫——建立后 20s 内没有任何数据即断开；一旦开始发送数据就交给正常超时体系。
server.on('connection', (socket) => {
  try {
    socket.setTimeout(20000, () => { try { socket.destroy(); } catch {} });
    socket.once('data', () => { try { socket.setTimeout(0); } catch {} });
  } catch {}
});

// ── WebSocket 升级握手调度 ───────────────────────────────────
async function handleUpgrade(req, socket, head) {
  const rawUrl = req.url || '/';
  const safePath = '/' + rawUrl.replace(/^\/+/, '');
  const parsedUrl = new URL(safePath, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  req.url = pathname + parsedUrl.search;

  // 1. 跨站 CSWSH 校验
  if (!isAllowedWsOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }

  // 2. 身份认证检查
  if (!checkRequestAuth(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }

  // 3. VNC WebSocket 握手 (兼容版本化路径、相对路径与自定义前缀)
  const vncWsPath = VNC_PATH + '/websockify';
  // 轻微项：只精确匹配已知的 websockify 端点（原来 endsWith('/websockify') 过宽，
  // 任何以 /websockify 结尾的路径都会被当作桌面 WS 代理）
  if (pathname === vncWsPath || pathname === '/websockify') {
    // 浏览器被彻底停用（或插件被停用）时不再转发 VNC WebSocket（与 /vnc 提示页保持一致）
    if (!desktopManager.isEnabled() || isBrowserPluginDisabled()) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    desktopManager.touchActivity();
    // 与 /vnc 一致：若关键进程已退出（例如最后一个标签页被关掉导致 Chromium 退出），
    // 借着这次 WS 连接自愈重启，避免用户停在"空桌面"上。
    if (!desktopManager.getStatus().running) desktopManager.start().catch(() => {});
    req.url = '/websockify' + (parsedUrl.search || '');
    return vncProxy.ws(req, socket, head);
  }

  // 4. DSH WebSocket 握手 (/events/mux, /events/host, etc.)
  await alignHeadersForDsh(req);
  dshProxy.ws(req, socket, head);
}

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((err) => {
    console.error('[gateway] WebSocket 升级处理异常:', (err && err.stack) || err);
    try { socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n'); } catch {}
  });
});

// ── 服务自举与平滑关闭 ───────────────────────────────────────
async function bootstrap() {
  // 内部接口共享密钥：启动即生成并落盘（0600），保证插件在任何一次工具调用前都能读到
  try {
    const tokenPath = require('./internal-token').tokenFilePath();
    getInternalToken();
    console.log('[gateway] 内部接口密钥已就绪:', tokenPath);
  } catch (err) {
    console.warn('[gateway] 内部接口密钥初始化失败:', err.message);
  }

  server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  网关已启动');
    console.log('  监听端口: 0.0.0.0:' + PROXY_PORT + ' (来源: ' + PROXY_PORT_SOURCE + ')');
    console.log('  管理路径: ' + ADMIN_PATH + ' (来源: ' + ADMIN_PATH_SOURCE + ')  桌面路径: ' + VNC_PATH + ' (来源: ' + VNC_PATH_SOURCE + ')');
    console.log('  认证口令来源: ' + AUTH_TOKEN_SOURCE);
    console.log('  认证状态: ' + (isAuthEnabled() ? '已启用认证码保护 (AUTH_TOKEN)' : '未启用认证 (无感直通)'));
    console.log('  DSH Web:  http://127.0.0.1:' + PROXY_PORT + '/');
    console.log('  管理面板: http://127.0.0.1:' + PROXY_PORT + ADMIN_PATH + '/');
    console.log('  noVNC 桌面: http://127.0.0.1:' + PROXY_PORT + VNC_PATH + '/');
    console.log('==================================================');
  });

  // 首次启动即落盘配置文件：保证「gateway.config.json = 单一权威」始终存在（插件启动时读它）
  if (!fs.existsSync(CONFIG_FILE)) {
    const ds0 = desktopManager.getStatus();
    savePersistedConfig({
      proxyPort: PROXY_PORT,
      adminPath: ADMIN_PATH,
      vncPath: VNC_PATH,
      autoHealPlugins: autoHealEnabled,
      autoHealMaxPerBoot,
      desktop: {
        enabled: ds0.enabled, width: ds0.width, height: ds0.height,
        enableCdp: ds0.enableCdp, cdpPort: ds0.cdpPort,
        idleTimeoutMinutes: ds0.idleTimeoutMinutes,
        enableSidebarTab: ds0.enableSidebarTab,
        screenshotQuality: ds0.screenshotQuality, screenshotDir: ds0.screenshotDir
      },
      savedAt: new Date().toISOString()
    });
    console.log('[gateway] 已生成初始配置文件:', CONFIG_FILE);
  }

  // 启动虚拟桌面 (尊重管理后台「彻底开关」与环境变量；任一处显式关闭则不启动)
  if (!desktopManager.isEnabled()) {
    console.log('[desktop-manager] 容器浏览器已被管理后台彻底停用，跳过开机自动启动');
  } else if (isBrowserPluginDisabled()) {
    // 插件已被显式禁用：按"插件停用 → 浏览器也用不了"的约定，不自动启动桌面
    console.log('[desktop-manager] 浏览器插件已被停用，跳过开机自动启动桌面');
  } else {
    await desktopManager.start().catch(err => console.error('[desktop-manager] 启动失败:', err.message));
  }

  // 启动 DSH 核心服务
  await dshManager.boot().catch(err => console.error('[dsh-manager] 启动失败:', err.message));

  // 默认首次启动自动创建初始配置快照 (自动防重复创建)
  dshManager.ensureDefaultSnapshot();
}

async function shutdown(exitCode = 0) {
  const code = typeof exitCode === 'number' ? exitCode : 0;
  console.log('\n[gateway] 正在退出，关闭桌面与 DSH 进程...');
  // 兜底：无论如何 8 秒内必须退出，避免关机流程自身卡死
  const hardTimer = setTimeout(() => { console.error('[gateway] 退出超时，强制结束'); process.exit(code); }, 8000);
  if (hardTimer.unref) hardTimer.unref();
  try { await desktopManager.stop(); } catch (e) { console.warn('[gateway] 关闭桌面异常(忽略):', e && e.message); }
  try { await dshManager.stop(); } catch (e) { console.warn('[gateway] 关闭 DSH 异常(忽略):', e && e.message); }
  process.exit(code);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// 未处理的 Promise 拒绝：记录但【不退出】，避免单个后台任务异常拖垮唯一入口
process.on('unhandledRejection', (reason) => {
  console.error('[gateway] 未处理的 Promise 拒绝（已忽略，进程继续运行）:', (reason && reason.stack) || reason);
});
// 未捕获同步异常：记录后优雅退出，交由 entrypoint 守护循环重启
process.on('uncaughtException', (err) => {
  console.error('[gateway] 未捕获异常，优雅退出以交由守护进程重启:', (err && err.stack) || err);
  shutdown(1).catch(() => process.exit(1));
});

bootstrap();
