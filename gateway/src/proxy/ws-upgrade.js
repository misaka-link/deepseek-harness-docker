'use strict';

/**
 * WebSocket upgrade dispatcher with locked/setup/CSWSH/auth gates,
 * exact websockify matching, and upstream handshake timeout guards.
 */

const wsOrigin = require('../auth/ws-origin');
const session = require('../auth/session');
const setupGate = require('../auth/setup-gate');

function isVncWebSocketPath(pathname, vncPath = '/vnc') {
  const norm = String(vncPath || '/vnc').replace(/\/+$/, '') || '/vnc';
  const vncWsPath = norm + '/websockify';
  return pathname === vncWsPath || pathname === '/websockify' || (norm !== '/vnc' && pathname === '/vnc/websockify');
}

function createWsUpgradeHandler({
  runtimeConfig,
  capabilities,
  getConfigState,
  desktopManager,
  isBrowserPluginDisabled,
  dshProxy,
  vncProxy
}) {
  return async function handleUpgrade(req, socket, head) {
    const rawUrl = req.url || '/';
    const safePath = '/' + rawUrl.replace(/^\/+/, '');
    const parsedUrl = new URL(safePath, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;
    req.url = pathname + parsedUrl.search;

    // 0. Fail-closed locked gate
    const cfgState = typeof getConfigState === 'function' ? getConfigState() : { locked: false };
    if (cfgState && cfgState.locked) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }

    // 1. Setup gate
    if (setupGate.isSetupRequired()) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }

    // 2. CSWSH origin verification
    if (!wsOrigin.isAllowedWsOrigin(req, runtimeConfig.publicHosts)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    // 3. Authentication check
    if (!session.checkRequestAuth(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }

    const timeoutMs = runtimeConfig.proxyTimeoutMs;

    // 4. VNC WebSocket upgrade
    if (isVncWebSocketPath(pathname, runtimeConfig.vncPath)) {
      if (!capabilities.desktop.supported) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      if (!desktopManager.isEnabled() || (typeof isBrowserPluginDisabled === 'function' && isBrowserPluginDisabled())) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }

      desktopManager.touchActivity();
      if (!desktopManager.getStatus().running) {
        desktopManager.start().catch(() => {});
      }

      req.url = '/websockify' + (parsedUrl.search || '');
      if (timeoutMs) {
        const vncWsTimer = setTimeout(() => {
          if (req.__vncWsOpened) return;
          req.__vncWsTimedOut = true;
          console.warn('[vnc-proxy] WS 上游 ' + timeoutMs + 'ms 未完成握手，关闭连接:', req.url);
          try {
            if (req.__vncWsProxyReq) req.__vncWsProxyReq.destroy(new Error('vnc_ws_timeout'));
          } catch {}
          try {
            socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n');
          } catch {}
        }, timeoutMs);
        if (vncWsTimer.unref) vncWsTimer.unref();
        req.__vncWsTimer = vncWsTimer;
        socket.on('close', () => {
          if (req.__vncWsTimer) {
            clearTimeout(req.__vncWsTimer);
            req.__vncWsTimer = null;
          }
        });
      }
      return vncProxy.ws(req, socket, head);
    }

    // 5. DSH WebSocket upgrade
    await dshProxy.alignHeaders(req);
    if (timeoutMs) {
      const wsTimer = setTimeout(() => {
        if (req.__dshWsOpened) return;
        req.__dshWsTimedOut = true;
        console.warn('[dsh-proxy] WS 上游 ' + timeoutMs + 'ms 未完成握手，关闭连接:', req.url);
        try {
          if (req.__dshWsProxyReq) req.__dshWsProxyReq.destroy(new Error('dsh_ws_timeout'));
        } catch {}
        try {
          socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n');
        } catch {}
      }, timeoutMs);
      if (wsTimer.unref) wsTimer.unref();
      req.__dshWsTimer = wsTimer;
      socket.on('close', () => {
        if (req.__dshWsTimer) {
          clearTimeout(req.__dshWsTimer);
          req.__dshWsTimer = null;
        }
      });
    }
    dshProxy.ws(req, socket, head);
  };
}

module.exports = {
  isVncWebSocketPath,
  createWsUpgradeHandler
};
