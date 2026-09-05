const http = require('http');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');

const {
  isAuthEnabled,
  verifyToken,
  checkRequestAuth,
  setAuthCookie,
  clearAuthCookie,
  checkRateLimit,
  recordAuthAttempt,
  updateAuthToken,
  getAuthToken
} = require('./auth');

const { ensureUpstreamCookie, injectPolyfill } = require('./token-crawler');
const desktopManager = require('./desktop-manager');
const dshManager = require('./dsh-manager');
const backupService = require('./backup-service');
const pluginManager = require('./plugin-manager');

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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.error('[gateway] 保存持久化配置失败:', err.message);
    return false;
  }
}

const persisted = loadPersistedConfig();

// 应用持久化认证码与桌面设置
if (persisted.authToken !== undefined) {
  updateAuthToken(persisted.authToken);
}
if (persisted.desktop) {
  desktopManager.updateConfig(persisted.desktop);
}

// ── 端口与动态路径配置 ───────────────────────────────────────
const PROXY_PORT = Number(persisted.proxyPort || process.env.PROXY_PORT) || 3080;
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const VNC_PORT = Number(process.env.VNC_PORT) || 6080;

function normalizeRoutePath(raw, defaultPath) {
  let p = (raw || defaultPath).trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');
  return p.length === 0 ? defaultPath : p;
}

const ADMIN_PATH = normalizeRoutePath(persisted.adminPath || process.env.ADMIN_PATH, '/admin');
const VNC_PATH = normalizeRoutePath(persisted.vncPath || process.env.VNC_PATH, '/vnc');

const DSH_TARGET = 'http://127.0.0.1:' + DSH_PORT;
const VNC_TARGET = 'http://127.0.0.1:' + VNC_PORT;

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
  console.warn('[dsh-proxy] 上游连接等待中 (DSH 启动阶段):', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'DeepSeek Harness 正在启动就绪中，请稍候数秒后刷新' }));
  }
});

vncProxy.on('error', (err, req, res) => {
  console.warn('[vnc-proxy] 上游连接等待中 (VNC 启动阶段):', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'VNC 图形桌面正在就绪中，请稍候数秒后刷新' }));
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
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 512) req.destroy();
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
        dsh: {
          version: dshManager.getCurrentVersion(),
          ready: dshManager.ready
        },
        desktop: desktopManager.getStatus(),
        paths: {
          admin: ADMIN_PATH,
          vnc: VNC_PATH,
          proxyPort: PROXY_PORT
        },
        authEnabled: isAuthEnabled(),
        authToken: getAuthToken()
      });
    }

    // 2. DSH 版本列表
    if (subPath === '/api/dsh/versions' && req.method === 'GET') {
      const force = query.get('refresh') === '1';
      const data = await dshManager.fetchAvailableVersions(force);
      return sendJson(res, 200, data);
    }

    // 3. 安装/切换 DSH 版本 (支持实时 SSE 流式推送详细日志)
    if (subPath === '/api/dsh/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const version = (body.version || '').trim();
      if (!version) return sendJson(res, 400, { ok: false, error: '版本号不能为空' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });

      const sendEvt = (data) => {
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
      };

      const r = await dshManager.installVersion(version, (line) => {
        sendEvt({ type: 'log', message: line });
      });

      sendEvt({ type: 'done', ...r });
      res.end();
      return;
    }

    // 4. 重启 DSH
    if (subPath === '/api/dsh/restart' && req.method === 'POST') {
      const r = await dshManager.restart();
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    // 5. 桌面启停控制
    if (subPath === '/api/desktop/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await desktopManager.start(body);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/desktop/stop' && req.method === 'POST') {
      const r = desktopManager.stop();
      return sendJson(res, 200, r);
    }

    if (subPath === '/api/desktop/restart' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await desktopManager.restart(body);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    if (subPath === '/api/desktop/keepalive' && req.method === 'POST') {
      const body = await readJsonBody(req);
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
        const r = await backupService.createBackup(body.name);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (subPath === '/api/snapshots/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const r = await backupService.restoreBackup(body.filename, dshManager);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (subPath === '/api/snapshots/import' && req.method === 'POST') {
      const filename = query.get('filename') || req.headers['x-filename'] || 'imported-snapshot.tar.gz';
      try {
        const r = await backupService.importBackupStream(req, filename);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
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
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (subPath === '/api/plugins/toggle' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (!body || !body.name) throw new Error('缺少插件名称');
        const r = pluginManager.togglePlugin(body.name, body.enabled !== false);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (subPath === '/api/plugins/uninstall' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (!body || !body.name) throw new Error('缺少插件名称');
        const r = pluginManager.uninstallPlugin(body.name);
        return sendJson(res, 200, r);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
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

      const newCfg = {
        proxyPort: newPort,
        adminPath: newAdmin,
        vncPath: newVnc,
        authToken: body.authToken !== undefined ? String(body.authToken).trim() : getAuthToken(),
        desktop: {
          width,
          height,
          enableCdp,
          cdpPort: newCdpPort,
          idleTimeoutMinutes
        },
        savedAt: new Date().toISOString()
      };

      const saved = savePersistedConfig(newCfg);
      if (!saved) {
        return sendJson(res, 500, { ok: false, error: '持久化配置文件写入失败' });
      }

      console.log('[gateway] 管理后台提交新配置:', newCfg);

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
        desktopManager.stop();
        await dshManager.stop();
        process.exit(0);
      }, 800);

      return;
    }

    return sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

// ── 内部桌面控制 API (供本地插件调用) ─────────────────────────
async function handleInternalDesktopApi(req, res, pathname) {
  try {
    const action = pathname.replace('/__internal/desktop/', '').trim();
    if (action === 'status') return sendJson(res, 200, desktopManager.getStatus());

    const body = await readJsonBody(req);
    if (action === 'start') {
      const r = await desktopManager.start(body);
      return sendJson(res, 200, r);
    }
    if (action === 'stop') {
      const r = desktopManager.stop();
      return sendJson(res, 200, r);
    }
    if (action === 'restart') {
      const r = await desktopManager.restart(body);
      return sendJson(res, 200, r);
    }
    if (action === 'keepalive') {
      desktopManager.touchActivity(body.durationMinutes);
      return sendJson(res, 200, { ok: true, status: desktopManager.getStatus() });
    }
    return sendJson(res, 404, { ok: false, error: '未知操作' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
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
        setAuthCookie(res);
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

function isAllowedWsOrigin(req) {
  const origin = req.headers['origin'];
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers['host'];
  } catch {
    return false;
  }
}

// ── 主 HTTP 路由调度 ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const rawUrl = req.url || '/';
  const safePath = '/' + rawUrl.replace(/^\/+/, '');
  const parsedUrl = new URL(safePath, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  req.url = pathname + parsedUrl.search;

  // 1. 公开路径白名单
  if (pathname === '/login') return serveStaticHtml(res, 'login.html');
  if (pathname === '/__auth/verify' && req.method === 'POST') return handleAuthVerify(req, res);
  if (pathname === '/logout') {
    clearAuthCookie(res);
    res.writeHead(302, { Location: '/login' });
    return res.end();
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

  // 2. 本地回环免鉴权内部接口 (供容器内插件工具通信)
  if (pathname.startsWith('/__internal/desktop/')) {
    const isLoopbackReq = ['127.0.0.1', '::1', 'localhost'].includes(req.socket.remoteAddress);
    if (isLoopbackReq) {
      return handleInternalDesktopApi(req, res, pathname);
    }
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

  // 4. 自定义 Admin 路由 (ADMIN_PATH)
  if (pathname === ADMIN_PATH || pathname === ADMIN_PATH + '/') {
    return serveStaticHtml(res, 'admin.html');
  }
  if (pathname.startsWith(ADMIN_PATH + '/api/')) {
    return handleAdminApi(req, res, pathname, parsedUrl.searchParams);
  }

  // 5. 自定义 VNC 路由 (VNC_PATH)
  if (pathname === VNC_PATH || pathname.startsWith(VNC_PATH + '/')) {
    // 自动唤醒桌面 (若处于休眠状态)
    if (!desktopManager.running) {
      desktopManager.start().catch(() => {});
    } else {
      desktopManager.touchActivity();
    }

    if (pathname === VNC_PATH || pathname === VNC_PATH + '/') {
      const vncPrefix = VNC_PATH.replace(/^\//, '');
      res.writeHead(302, {
        Location: VNC_PATH + '/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=' + vncPrefix + '/websockify'
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
});

// ── WebSocket 升级握手调度 ───────────────────────────────────
server.on('upgrade', async (req, socket, head) => {
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

  // 3. VNC WebSocket 握手
  const vncWsPath = VNC_PATH + '/websockify';
  if (pathname === vncWsPath || pathname.startsWith(vncWsPath) || pathname === '/websockify') {
    desktopManager.touchActivity();
    req.url = req.url.slice(VNC_PATH.length) || '/';
    return vncProxy.ws(req, socket, head);
  }

  // 4. DSH WebSocket 握手 (/events/mux, /events/host, etc.)
  await alignHeadersForDsh(req);
  dshProxy.ws(req, socket, head);
});

// ── 服务自举与平滑关闭 ───────────────────────────────────────
async function bootstrap() {
  server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  网关已启动');
    console.log('  监听端口: 0.0.0.0:' + PROXY_PORT);
    console.log('  认证状态: ' + (isAuthEnabled() ? '已启用认证码保护 (AUTH_TOKEN)' : '未启用认证 (无感直通)'));
    console.log('  DSH Web:  http://127.0.0.1:' + PROXY_PORT + '/');
    console.log('  管理面板: http://127.0.0.1:' + PROXY_PORT + ADMIN_PATH + '/');
    console.log('  noVNC 桌面: http://127.0.0.1:' + PROXY_PORT + VNC_PATH + '/');
    console.log('==================================================');
  });

  // 启动虚拟桌面 (若未显式关闭)
  if (process.env.DSH_DESKTOP_ENABLED !== '0') {
    await desktopManager.start().catch(err => console.error('[desktop-manager] 启动失败:', err.message));
  }

  // 启动 DSH 核心服务
  await dshManager.boot().catch(err => console.error('[dsh-manager] 启动失败:', err.message));

  // 默认首次启动自动创建初始配置快照 (自动防重复创建)
  dshManager.ensureDefaultSnapshot();
}

async function shutdown() {
  console.log('\n[gateway] 正在退出，关闭桌面与 DSH 进程...');
  desktopManager.stop();
  await dshManager.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bootstrap();
