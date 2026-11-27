'use strict';

/**
 * Gateway assembly, middleware pipeline, slow-connection protection,
 * service startup orchestration, and 8-second hard-timeout graceful shutdown.
 */

const fs = require('fs');
const http = require('http');

const paths = require('./core/paths');
const CAPABILITIES = require('./core/capabilities');
const gatewayConfig = require('./config/gateway-config');
const { buildRuntimeConfig } = require('./config/runtime-config');

const session = require('./auth/session');
const rateLimit = require('./auth/rate-limit');
const setupGate = require('./auth/setup-gate');
const internalToken = require('./auth/internal-token');

const { AppError, translateServerMessage, safeLogError } = require('./i18n/errors');
const { negotiateLocale } = require('./i18n/negotiate');

const { sendJson, sendError, sendRedirect, isHtmlNavigation } = require('./http/respond');
const { serveUiAsset, serveFavicon } = require('./http/static');
const { renderTemplate, renderLockedPage } = require('./http/pages');

const { createDshProxy } = require('./proxy/dsh-proxy');
const { createVncProxy } = require('./proxy/vnc-proxy');
const { createWsUpgradeHandler } = require('./proxy/ws-upgrade');

const { handleHealthz } = require('./routes/health');
const { handleUiPrefs } = require('./routes/ui-prefs');
const { handlePublicAuthRoutes } = require('./routes/public-auth');
const { handleInternalDesktop } = require('./routes/internal-desktop');
const {
  ACCOUNT_CALLBACK_PATH,
  handleAccountCallbackRoute,
  handleAccountClientVersion,
  handleAccountStatus
} = require('./routes/account');
const { handleDesktopApiRoutes } = require('./routes/desktop-api');
const { isVncHttpPath, handleVncHttp } = require('./routes/vnc');
const { isBrowserPluginDisabled } = require('./routes/desktop-control');
const { createAdminRouter } = require('./routes/admin');

const PUBLIC_PROXY_PATHS = new Set([
  '/manifest.webmanifest',
  '/oauth/callback'
]);

function loadDefaultServices(capabilities) {
  const desktopManager = capabilities.desktop.supported
    ? require('./desktop/desktop-manager')
    : require('./desktop/desktop-stub');
  const dshManager = require('./dsh');
  const versionService = require('./dsh/version-service');
  const { DshCoreWatchdog } = require('./dsh/watchdog');
  const backupService = require('./backup');
  const pluginManager = require('./plugins/plugin-manager');

  let ToolCacheHealer = null;
  try {
    ({ ToolCacheHealer } = require('./maintenance/tool-cache-healer'));
  } catch (err) {
    console.warn('[gateway] 工具缓存自愈模块不可用，已降级为不自愈:', err && err.message);
  }

  return {
    desktopManager,
    dshManager,
    versionService,
    DshCoreWatchdog,
    backupService,
    pluginManager,
    ToolCacheHealer
  };
}

function createApp(deps = {}) {
  const capabilities = deps.capabilities || CAPABILITIES;
  const services = deps.services || loadDefaultServices(capabilities);
  const {
    desktopManager,
    dshManager,
    versionService,
    DshCoreWatchdog,
    backupService,
    pluginManager,
    ToolCacheHealer
  } = services;

  const loadRes = deps.persisted !== undefined
    ? { config: deps.persisted, configState: deps.configState || gatewayConfig.getConfigState() }
    : gatewayConfig.loadGatewayConfig();

  const persisted = loadRes.config || {};
  const getConfigState = deps.getConfigState || (() => (deps.configState || gatewayConfig.getConfigState()));
  const runtimeConfig = buildRuntimeConfig(persisted, deps.env || process.env, capabilities);

  rateLimit.setTrustProxy(runtimeConfig.trustProxy);

  if (!getConfigState().locked && runtimeConfig.authTokenSource !== 'env' && persisted.authToken !== undefined) {
    session.updateAuthToken(persisted.authToken);
  } else if (runtimeConfig.authTokenSource === 'env') {
    console.log('[gateway] 认证口令来源: 环境变量 AUTH_TOKEN（优先于持久化配置）');
  }

  if (capabilities.desktop.supported && runtimeConfig.desktopConfig) {
    if (typeof desktopManager.updateConfig === 'function') {
      desktopManager.updateConfig(runtimeConfig.desktopConfig);
    } else if (typeof desktopManager.applyConfig === 'function') {
      if (typeof runtimeConfig.desktopConfig.enabled === 'boolean' && typeof desktopManager.setEnabled === 'function') {
        desktopManager.setEnabled(runtimeConfig.desktopConfig.enabled);
      }
      desktopManager.applyConfig(runtimeConfig.desktopConfig);
    }
  }

  if (typeof dshManager.setAutoHeal === 'function') {
    dshManager.setAutoHeal(runtimeConfig.autoHealPlugins, runtimeConfig.autoHealMaxPerBoot);
  }
  if (runtimeConfig.npmRegistry && typeof dshManager.setNpmRegistry === 'function') {
    try {
      dshManager.setNpmRegistry(runtimeConfig.npmRegistry);
    } catch (err) {
      console.warn('[gateway] 应用持久化 npm 镜像源失败:', err && err.message);
    }
  }

  let dshWatchdog = null;
  let toolCacheHealer = null;

  function getWatchdogStatusSafe() {
    try {
      return dshWatchdog ? dshWatchdog.getStatus() : { enabled: false, running: false };
    } catch (err) {
      return { enabled: false, running: false, error: (err && err.message) || String(err) };
    }
  }

  const dshProxy = deps.dshProxy || createDshProxy({ runtimeConfig, dshManager });
  const vncProxy = deps.vncProxy || createVncProxy({ runtimeConfig });
  const adminRouter = createAdminRouter();

  const routeCtx = {
    runtimeConfig,
    capabilities,
    desktopManager,
    dshManager,
    versionService,
    backupService,
    pluginManager,
    dshProxy,
    vncProxy,
    getConfigState,
    getWatchdogStatusSafe,
    getToolCacheHealer: () => toolCacheHealer,
    scheduleRestart: deps.scheduleRestart
  };

  async function handleHttpRequest(req, res) {
    const rawUrl = req.url || '/';
    const safePath = '/' + rawUrl.replace(/^\/+/, '');
    const parsedUrl = new URL(safePath, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;
    req.url = pathname + parsedUrl.search;

    // 1. Unauthenticated static UI assets, prefs, favicon, and /healthz (always available, including locked mode)
    if (pathname === '/__ui/prefs' && req.method === 'GET') {
      return handleUiPrefs(req, res);
    }
    if (pathname.startsWith('/__ui/')) {
      if (serveUiAsset(req, res, pathname)) return;
    }
    if (pathname === '/favicon.svg' || pathname === '/favicon.ico') {
      if (serveFavicon(req, res, pathname)) return;
    }
    if (pathname === '/healthz') {
      return handleHealthz(req, res, routeCtx);
    }

    // 2. Internal loopback API (before setup/auth gates; capability-guarded first)
    if (pathname.startsWith('/__internal/desktop/')) {
      return handleInternalDesktop(req, res, pathname, routeCtx);
    }

    // 3. Fail-closed locked gate: unreadable or corrupted config/secret files NEVER expose /setup
    const cfgState = getConfigState();
    if (cfgState && cfgState.locked) {
      const filesText = (cfgState.files || []).map((f) => f.path).join(', ');
      if (pathname === '/__auth/setup') {
        return sendError(res, req, new AppError('SETUP_LOCKED_UNREADABLE_CONFIG', { files: filesText }, 423));
      }
      const isPageTarget =
        isHtmlNavigation(req) ||
        pathname === '/' ||
        pathname === '/setup' ||
        pathname === '/login' ||
        pathname === runtimeConfig.adminPath ||
        pathname === runtimeConfig.adminPath + '/';
      if (isPageTarget) {
        return renderLockedPage(req, res, runtimeConfig, cfgState);
      }
      return sendError(res, req, new AppError('SETUP_LOCKED_UNREADABLE_CONFIG', { files: filesText }, 503));
    }

    // 4. Public auth & setup routes
    if (await handlePublicAuthRoutes(req, res, pathname, routeCtx)) {
      return;
    }

    // 5. Setup gate: block all non-public routes until password is configured
    if (setupGate.isSetupRequired()) {
      const locale = negotiateLocale(req);
      const isApiReq = pathname.startsWith(runtimeConfig.adminPath + '/api/') || pathname.startsWith('/__api/');
      if (!isApiReq && isHtmlNavigation(req)) {
        return sendRedirect(res, '/setup');
      }
      return sendJson(res, 401, {
        ok: false,
        errorCode: 'SETUP_REQUIRED',
        params: {},
        error: translateServerMessage(locale, 'SETUP_REQUIRED'),
        setupRequired: true
      });
    }

    // 6. Account manual OAuth callback route (auth-protected)
    if (pathname === ACCOUNT_CALLBACK_PATH) {
      return handleAccountCallbackRoute(req, res, routeCtx);
    }

    // 7. Public proxy passthrough paths (e.g. /oauth/callback)
    if (PUBLIC_PROXY_PATHS.has(pathname)) {
      await dshProxy.alignHeaders(req);
      return dshProxy.web(req, res);
    }

    // 8. Unified session/token authentication gate
    if (!session.checkRequestAuth(req)) {
      if (isHtmlNavigation(req)) {
        return sendRedirect(res, '/login?redirect=' + encodeURIComponent(req.url || '/'));
      }
      return sendError(res, req, new AppError('AUTH_REQUIRED', {}, 401));
    }

    // 9. Authenticated account & stable desktop APIs
    if (pathname === '/__api/account/client-version' && req.method === 'GET') {
      return handleAccountClientVersion(req, res);
    }
    if (pathname === '/__api/account/status' && req.method === 'GET') {
      return handleAccountStatus(req, res);
    }
    if (await handleDesktopApiRoutes(req, res, pathname, routeCtx)) {
      return;
    }

    // 10. Admin UI page and Admin API
    if (pathname === runtimeConfig.adminPath || pathname === runtimeConfig.adminPath + '/') {
      return renderTemplate(req, res, 'admin', {}, 200, { runtimeConfig, capabilities });
    }
    if (pathname.startsWith(runtimeConfig.adminPath + '/api/')) {
      return adminRouter.handleAdminApi(req, res, pathname, parsedUrl.searchParams, routeCtx);
    }

    // 11. VNC route
    if (isVncHttpPath(pathname, runtimeConfig.vncPath)) {
      return handleVncHttp(req, res, pathname, parsedUrl, routeCtx);
    }

    // 12. DSH catch-all reverse proxy
    await dshProxy.alignHeaders(req);
    return dshProxy.web(req, res);
  }

  function handleRequestCrash(err, req, res) {
    const { ref } = safeLogError(err, 'http-crash');
    try {
      if (res && !res.headersSent) {
        const locale = negotiateLocale(req);
        sendJson(res, 500, {
          ok: false,
          errorCode: 'INTERNAL_ERROR',
          params: { ref },
          error: translateServerMessage(locale, 'INTERNAL_ERROR', { ref })
        });
      } else if (res && !res.writableEnded && typeof res.end === 'function') {
        res.end();
      }
    } catch {}
  }

  const handleUpgrade = createWsUpgradeHandler({
    runtimeConfig,
    capabilities,
    getConfigState,
    desktopManager,
    isBrowserPluginDisabled: () => isBrowserPluginDisabled(pluginManager),
    dshProxy,
    vncProxy
  });

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch((err) => handleRequestCrash(err, req, res));
  });

  // Request and slow-connection timeout guards
  const envSource = deps.env || process.env;
  const snapshotTimeoutMs = Number(envSource.DSH_SNAPSHOT_TIMEOUT_MS) > 0
    ? Number(envSource.DSH_SNAPSHOT_TIMEOUT_MS)
    : 30 * 60 * 1000;
  server.headersTimeout = 20000;
  server.keepAliveTimeout = 15000;
  server.requestTimeout = Math.max(600000, snapshotTimeoutMs + 60000);
  server.connectionsCheckingInterval = 5000;
  server.on('connection', (socket) => {
    try {
      socket.setTimeout(20000, () => {
        try {
          socket.destroy();
        } catch {}
      });
      socket.once('data', () => {
        try {
          socket.setTimeout(0);
        } catch {}
      });
    } catch {}
  });

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((err) => {
      safeLogError(err, 'ws-upgrade');
      try {
        socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      } catch {}
    });
  });

  let shuttingDown = false;
  async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    const code = typeof exitCode === 'number' ? exitCode : 0;
    console.log('\n[gateway] 正在退出，关闭桌面与 DSH 进程...');
    if (dshWatchdog) {
      try {
        dshWatchdog.stop();
      } catch {}
    }
    if (toolCacheHealer) {
      try {
        toolCacheHealer.stop();
      } catch {}
    }
    const hardTimer = setTimeout(() => {
      console.error('[gateway] 退出超时，强制结束');
      process.exit(code);
    }, 8000);
    if (hardTimer.unref) hardTimer.unref();

    try {
      server.close();
    } catch {}
    try {
      await desktopManager.stop();
    } catch (err) {
      console.warn('[gateway] 关闭桌面异常(忽略):', err && err.message);
    }
    try {
      await dshManager.stop();
    } catch (err) {
      console.warn('[gateway] 关闭 DSH 异常(忽略):', err && err.message);
    }
    process.exit(code);
  }

  async function bootBackgroundServices() {
    const cfgState = getConfigState();
    if (cfgState && cfgState.locked) {
      console.error('[gateway] 处于 fail-closed 锁定模式，跳过配置写入、桌面与 DSH 自动启动');
      return;
    }

    const configFile = paths.getGatewayConfigFile();
    if (!fs.existsSync(configFile)) {
      const ds0 = desktopManager.getStatus();
      const initialCfg = {
        proxyPort: runtimeConfig.proxyPort,
        adminPath: runtimeConfig.adminPath,
        vncPath: runtimeConfig.vncPath,
        autoHealPlugins: runtimeConfig.autoHealPlugins,
        autoHealMaxPerBoot: runtimeConfig.autoHealMaxPerBoot,
        pruneStaleBundles: runtimeConfig.pruneStaleBundles,
        pruneBundlesExtra: runtimeConfig.pruneBundlesExtra
      };
      if (capabilities.desktop.supported) {
        initialCfg.desktop = {
          enabled: ds0.enabled,
          width: ds0.width,
          height: ds0.height,
          enableCdp: ds0.enableCdp,
          cdpPort: ds0.cdpPort,
          idleTimeoutMinutes: ds0.idleTimeoutMinutes,
          enableSidebarTab: ds0.enableSidebarTab,
          screenshotQuality: ds0.screenshotQuality,
          screenshotDir: ds0.screenshotDir
        };
      }
      const saved = gatewayConfig.mergeSaveGatewayConfig(initialCfg);
      if (saved.ok) {
        console.log('[gateway] 已生成初始配置文件:', configFile);
      }
    }

    if (!capabilities.desktop.supported) {
      console.log('[desktop-manager] mini 镜像：未预装桌面与 Chromium 栈，跳过开机自动启动');
    } else if (!desktopManager.isEnabled()) {
      console.log('[desktop-manager] 容器浏览器已被管理后台彻底停用，跳过开机自动启动');
    } else if (isBrowserPluginDisabled(pluginManager)) {
      console.log('[desktop-manager] 浏览器插件已被停用，跳过开机自动启动桌面');
    } else {
      await desktopManager.start().catch((err) => console.error('[desktop-manager] 启动失败:', err && err.message));
    }

    await dshManager.boot().catch((err) => console.error('[dsh-manager] 启动失败:', err && err.message));

    if (DshCoreWatchdog) {
      try {
        dshWatchdog = new DshCoreWatchdog({ dshManager });
        dshWatchdog.start();
      } catch (err) {
        console.error('[gateway] 启动 DSH 看门狗失败（已忽略，不影响网关运行）:', err && err.message);
      }
    }

    if (ToolCacheHealer) {
      try {
        toolCacheHealer = new ToolCacheHealer();
        toolCacheHealer.start();
        console.log('[gateway] 工具缓存自愈已启用（npx + pnpm dlx，每 60s 检查一次，静默 120s 才动手）');
      } catch (err) {
        console.error('[gateway] 启动工具缓存自愈失败（已忽略，不影响网关运行）:', err && err.message);
      }
    }

    if (typeof dshManager.ensureDefaultSnapshot === 'function') {
      dshManager.ensureDefaultSnapshot();
    }
  }

  return {
    server,
    runtimeConfig,
    capabilities,
    services,
    handleHttpRequest,
    handleUpgrade,
    bootBackgroundServices,
    shutdown
  };
}

function start(deps = {}) {
  const app = createApp(deps);
  const { server, runtimeConfig, capabilities, shutdown, bootBackgroundServices } = app;
  const cfgState = (deps.getConfigState || gatewayConfig.getConfigState)();

  if (!cfgState.locked) {
    try {
      const tokenPath = internalToken.tokenFilePath();
      internalToken.getInternalToken();
      console.log('[gateway] 内部接口密钥已就绪:', tokenPath);
    } catch (err) {
      console.warn('[gateway] 内部接口密钥初始化失败:', err && err.message);
    }
  }

  server.listen(runtimeConfig.proxyPort, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('  网关已启动');
    console.log('  监听端口: 0.0.0.0:' + runtimeConfig.proxyPort + ' (来源: ' + runtimeConfig.proxyPortSource + ')');
    console.log('  管理路径: ' + runtimeConfig.adminPath + ' (来源: ' + runtimeConfig.adminPathSource + ')  桌面路径: ' + runtimeConfig.vncPath + ' (来源: ' + runtimeConfig.vncPathSource + ')');
    console.log('  认证口令来源: ' + runtimeConfig.authTokenSource);
    console.log('  锁定状态: ' + (cfgState.locked ? 'LOCKED (fail-closed)' : '正常'));
    console.log('  认证状态: ' + (session.isAuthEnabled() ? '已启用认证码保护 (AUTH_TOKEN)' : '尚未设置口令 (引导至 /setup)'));
    console.log('  DSH Web:  http://127.0.0.1:' + runtimeConfig.proxyPort + '/');
    console.log('  管理面板: http://127.0.0.1:' + runtimeConfig.proxyPort + runtimeConfig.adminPath + '/');
    if (capabilities.vnc.supported) {
      console.log('  noVNC 桌面: http://127.0.0.1:' + runtimeConfig.proxyPort + runtimeConfig.vncPath + '/');
    } else {
      console.log('  容器浏览器: 未启用（mini 镜像）');
    }
    console.log('==================================================');
  });

  if (!deps.skipSignalHandlers) {
    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));
    process.on('unhandledRejection', (reason) => {
      console.error('[gateway] 未处理的 Promise 拒绝（已忽略，进程继续运行）:', (reason && reason.stack) || reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('[gateway] 未捕获异常，优雅退出以交由守护进程重启:', (err && err.stack) || err);
      shutdown(1).catch(() => process.exit(1));
    });
  }

  const readyPromise = bootBackgroundServices();
  return { app, server, shutdown, readyPromise };
}

module.exports = {
  createApp,
  start
};
