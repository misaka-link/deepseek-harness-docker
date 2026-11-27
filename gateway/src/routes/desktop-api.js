'use strict';

/**
 * Authenticated stable desktop & account convenience APIs:
 *   GET  /__api/desktop/status
 *   POST /__api/desktop/start
 *   GET  /desktop-starting
 */

const { readJsonBody } = require('../http/body');
const { sendJson, sendError, sendCapabilityUnavailable } = require('../http/respond');
const { renderDesktopStartingPage, renderCapabilityGonePage } = require('../http/pages');

async function handleDesktopApiRoutes(req, res, pathname, ctx) {
  const { capabilities, runtimeConfig, desktopManager } = ctx;

  if (pathname === '/desktop-starting' && req.method === 'GET') {
    if (!capabilities.desktop.supported) {
      renderCapabilityGonePage(req, res, runtimeConfig);
      return true;
    }
    renderDesktopStartingPage(req, res, runtimeConfig);
    return true;
  }

  if (pathname === '/__api/desktop' || pathname.startsWith('/__api/desktop/')) {
    if (!capabilities.desktop.supported) {
      sendCapabilityUnavailable(res, req, 'desktop');
      return true;
    }
  }

  if (pathname === '/__api/desktop/status' && req.method === 'GET') {
    sendJson(res, 200, {
      desktop: desktopManager.getStatus(),
      paths: {
        admin: runtimeConfig.adminPath,
        vnc: runtimeConfig.vncPathHref,
        proxyPort: runtimeConfig.proxyPort
      }
    });
    return true;
  }

  if (pathname === '/__api/desktop/start' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const r = await desktopManager.start(body);
      sendJson(res, r && r.ok ? 200 : 500, r);
    } catch (err) {
      sendError(res, req, err);
    }
    return true;
  }

  return false;
}

module.exports = { handleDesktopApiRoutes };
