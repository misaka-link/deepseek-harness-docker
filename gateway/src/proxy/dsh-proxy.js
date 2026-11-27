'use strict';

/**
 * DSH HTTP/WS reverse proxy with:
 *   - Native streaming passthrough for JS/CSS/plugins (preserving upstream br/gzip compression)
 *   - HTML-only polyfill injection (only `/` and `*.html` request `accept-encoding: identity`)
 *   - Upstream header-wait timeout (504) and graceful 502 status pages with dynamic ADMIN_PATH
 *   - Upstream 401 session cookie invalidation & re-exchange
 */

const httpProxy = require('http-proxy');
const { negotiateLocale } = require('../i18n/negotiate');
const { translateServerMessage } = require('../i18n/errors');
const { renderUpstreamTimeoutPage, renderUpstreamBadGatewayPage } = require('../http/pages');
const { attachHtmlInjection } = require('./html-inject');

function shouldDowngradeEncodingForHtml(pathname) {
  return pathname === '/' || pathname.endsWith('.html') || pathname.endsWith('.htm');
}

async function alignHeadersForDsh(req, runtimeConfig, dshManager) {
  req.headers.host = '127.0.0.1:' + runtimeConfig.dshPort;
  if (req.headers.origin) req.headers.origin = runtimeConfig.dshTarget;
  if (req.headers['sec-fetch-site'] === 'cross-site') req.headers['sec-fetch-site'] = 'same-origin';

  const pathname = (req.url || '/').split('?')[0];
  // Only downgrade compression for HTML entry documents; JS/CSS/plugins stream natively compressed
  if (shouldDowngradeEncodingForHtml(pathname)) {
    req.headers['accept-encoding'] = 'identity';
  }

  if (dshManager && typeof dshManager.ensureValidUpstreamCookie === 'function') {
    const upstreamCookie = await dshManager.ensureValidUpstreamCookie();
    if (upstreamCookie) {
      const existing = req.headers.cookie || '';
      req.headers.cookie = existing ? existing + '; ' + upstreamCookie : upstreamCookie;
    }
  }
}

function respondUpstreamTimeout(req, res, runtimeConfig) {
  if (!res || typeof res.writeHead !== 'function' || res.headersSent || res.writableEnded) return;
  const isHtml = String((req.headers && req.headers.accept) || '').includes('text/html');
  if (isHtml) {
    return renderUpstreamTimeoutPage(req, res, runtimeConfig);
  }
  const locale = negotiateLocale(req);
  const seconds = Math.round((runtimeConfig.proxyTimeoutMs || 30000) / 1000);
  const message = translateServerMessage(locale, 'UPSTREAM_TIMEOUT', { seconds });
  res.writeHead(504, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Retry-After': '5'
  });
  res.end(
    JSON.stringify({
      ok: false,
      errorCode: 'UPSTREAM_TIMEOUT',
      params: { seconds },
      error: 'upstream_timeout',
      message
    })
  );
}

function createDshProxy({ runtimeConfig, dshManager }) {
  const proxy = httpProxy.createProxyServer({
    target: runtimeConfig.dshTarget,
    ws: true,
    changeOrigin: true
  });

  proxy.on('proxyReq', (proxyReq, req) => {
    try {
      req.__dshProxyReq = proxyReq;
    } catch {}
  });

  proxy.on('proxyReqWs', (proxyReq, req) => {
    try {
      req.__dshWsProxyReq = proxyReq;
    } catch {}
    const clearWs = () => {
      if (req.__dshWsTimer) {
        clearTimeout(req.__dshWsTimer);
        req.__dshWsTimer = null;
      }
    };
    proxyReq.on('upgrade', () => {
      req.__dshWsOpened = true;
      clearWs();
    });
    proxyReq.on('response', clearWs);
    proxyReq.on('error', clearWs);
    proxyReq.on('close', clearWs);
  });

  proxy.on('proxyRes', (proxyRes, req, res) => {
    if (req && req.__dshProxyTimer) {
      clearTimeout(req.__dshProxyTimer);
      req.__dshProxyTimer = null;
    }
    if (res && res.writableEnded) {
      try {
        proxyRes.destroy();
      } catch {}
      return;
    }

    if (proxyRes.statusCode === 401 && dshManager) {
      if (typeof dshManager.invalidateUpstreamCookie === 'function') {
        try {
          dshManager.invalidateUpstreamCookie();
        } catch {}
      }
      if (typeof dshManager.exchangeSessionCookie === 'function') {
        dshManager.exchangeSessionCookie().catch(() => {});
      }
    }

    const ct = String(proxyRes.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) {
      attachHtmlInjection(proxyRes, res);
    }
    // Non-HTML (JS, CSS, plugins, binary, streams): zero interception, native compressed streaming
  });

  proxy.on('error', (err, req, res) => {
    if (req && req.__dshProxyTimer) {
      clearTimeout(req.__dshProxyTimer);
      req.__dshProxyTimer = null;
    }
    if (req && req.__dshWsTimer) {
      clearTimeout(req.__dshWsTimer);
      req.__dshWsTimer = null;
    }
    if (req && (req.__dshProxyTimedOut || req.__dshWsTimedOut)) return;

    console.warn('[dsh-proxy] 上游连接等待中 (DSH 启动/停止阶段):', err.message);
    if (!res || typeof res.writeHead !== 'function' || res.headersSent || res.writableEnded) return;

    const isHtml = String((req.headers && req.headers.accept) || '').includes('text/html');
    if (isHtml) {
      return renderUpstreamBadGatewayPage(req, res, runtimeConfig, dshManager);
    }

    const locale = negotiateLocale(req);
    let errorCode = 'UPSTREAM_STARTING';
    let params = {};
    if (dshManager && dshManager.manualStopped) {
      errorCode = 'UPSTREAM_STOPPED';
    } else if (dshManager && dshManager.lastExitInfo && !dshManager.proc) {
      errorCode = 'UPSTREAM_EXITED';
      params = { code: dshManager.lastExitInfo.code ?? -1 };
    }
    const errorMsg = translateServerMessage(locale, errorCode, params);
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(
      JSON.stringify({
        ok: false,
        errorCode,
        params,
        error: errorMsg,
        exitInfo: dshManager ? dshManager.lastExitInfo : null
      })
    );
  });

  function web(req, res) {
    const timeoutMs = runtimeConfig.proxyTimeoutMs;
    if (!timeoutMs) return proxy.web(req, res);

    let fired = false;
    const timer = setTimeout(() => {
      if (fired || res.headersSent || res.writableEnded) return;
      fired = true;
      req.__dshProxyTimedOut = true;
      console.warn('[dsh-proxy] 上游 ' + timeoutMs + 'ms 未返回响应头，返回 504:', req.method, req.url);
      try {
        if (req.__dshProxyReq) req.__dshProxyReq.destroy(new Error('dsh_proxy_timeout'));
      } catch {}
      respondUpstreamTimeout(req, res, runtimeConfig);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    req.__dshProxyTimer = timer;

    const clear = () => {
      if (req.__dshProxyTimer) {
        clearTimeout(req.__dshProxyTimer);
        req.__dshProxyTimer = null;
      }
    };
    res.on('close', clear);
    res.on('finish', clear);
    proxy.web(req, res);
  }

  return {
    proxy,
    web,
    ws: (req, socket, head) => proxy.ws(req, socket, head),
    alignHeaders: (req) => alignHeadersForDsh(req, runtimeConfig, dshManager)
  };
}

module.exports = {
  shouldDowngradeEncodingForHtml,
  alignHeadersForDsh,
  createDshProxy
};
