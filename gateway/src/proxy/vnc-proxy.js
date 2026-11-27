'use strict';

/**
 * noVNC / websockify reverse proxy and prefix rewriting helper.
 * Correctly strips whichever prefix actually matched (custom VNC_PATH or legacy /vnc).
 */

const httpProxy = require('http-proxy');
const { negotiateLocale } = require('../i18n/negotiate');
const { translateServerMessage } = require('../i18n/errors');
const { isHtmlNavigation } = require('../http/respond');
const { renderDesktopStartingPage } = require('../http/pages');

/**
 * Strip the actually matched VNC mount prefix from reqUrl while preserving query string.
 * Fixes custom VNC_PATH mismatch when a request arrives via the legacy `/vnc/*` prefix.
 */
function stripVncPrefix(reqUrl, vncPath = '/vnc') {
  const urlStr = String(reqUrl || '/');
  const qIdx = urlStr.indexOf('?');
  const pathname = qIdx === -1 ? urlStr : urlStr.slice(0, qIdx);
  const search = qIdx === -1 ? '' : urlStr.slice(qIdx);

  const normCustom = String(vncPath || '/vnc').replace(/\/+$/, '') || '/vnc';
  let matchedPrefix = null;

  if (pathname === normCustom || pathname.startsWith(normCustom + '/')) {
    matchedPrefix = normCustom;
  } else if (pathname === '/vnc' || pathname.startsWith('/vnc/')) {
    matchedPrefix = '/vnc';
  }

  if (!matchedPrefix) {
    return pathname + search;
  }

  const stripped = pathname.slice(matchedPrefix.length);
  const normalized = stripped ? (stripped.startsWith('/') ? stripped : '/' + stripped) : '/';
  return normalized + search;
}

function createVncProxy({ runtimeConfig }) {
  const proxy = httpProxy.createProxyServer({
    target: runtimeConfig.vncTarget,
    ws: true,
    changeOrigin: true
  });

  proxy.on('proxyReqWs', (proxyReq, req) => {
    try {
      req.__vncWsProxyReq = proxyReq;
    } catch {}
    const clearWs = () => {
      if (req.__vncWsTimer) {
        clearTimeout(req.__vncWsTimer);
        req.__vncWsTimer = null;
      }
    };
    proxyReq.on('upgrade', () => {
      req.__vncWsOpened = true;
      clearWs();
    });
    proxyReq.on('response', clearWs);
    proxyReq.on('error', clearWs);
    proxyReq.on('close', clearWs);
  });

  proxy.on('proxyRes', (proxyRes, req, res) => {
    const ct = String(proxyRes.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  });

  proxy.on('error', (err, req, res) => {
    if (req && req.__vncWsTimer) {
      clearTimeout(req.__vncWsTimer);
      req.__vncWsTimer = null;
    }
    if (req && req.__vncWsTimedOut) return;

    console.warn('[vnc-proxy] 上游连接等待中 (VNC 启动阶段):', err.message);
    if (!res || typeof res.writeHead !== 'function' || res.headersSent || res.writableEnded) return;

    if (isHtmlNavigation(req)) {
      return renderDesktopStartingPage(req, res, runtimeConfig);
    }

    const locale = negotiateLocale(req);
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(
      JSON.stringify({
        ok: false,
        errorCode: 'VNC_STARTING',
        params: {},
        error: translateServerMessage(locale, 'VNC_STARTING')
      })
    );
  });

  return {
    proxy,
    web: (req, res) => proxy.web(req, res),
    ws: (req, socket, head) => proxy.ws(req, socket, head)
  };
}

module.exports = {
  stripVncPrefix,
  createVncProxy
};
