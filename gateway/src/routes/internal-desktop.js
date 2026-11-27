'use strict';

/**
 * Container-internal desktop control API: /__internal/desktop/*
 * Requires:
 *   1. Desktop capability supported (403 CAPABILITY_UNAVAILABLE on mini)
 *   2. Loopback peer address (127.0.0.1 / ::1) + valid x-dsh-internal-token header
 */

const wsOrigin = require('../auth/ws-origin');
const { verifyInternalToken } = require('../auth/internal-token');
const { AppError } = require('../i18n/errors');
const { readJsonBody } = require('../http/body');
const { sendJson, sendError, sendCapabilityUnavailable } = require('../http/respond');
const { applyDesktopConfigPatch, applyDesktopMaster } = require('./desktop-control');

async function handleInternalDesktop(req, res, pathname, ctx) {
  const { capabilities, runtimeConfig, desktopManager, pluginManager } = ctx;

  if (!capabilities.desktop.supported) {
    return sendCapabilityUnavailable(res, req, 'desktop');
  }

  const peer = wsOrigin.normalizeIp(req.socket && req.socket.remoteAddress);
  const isLoopbackReq = peer === '127.0.0.1' || peer === '::1';
  if (!isLoopbackReq || !verifyInternalToken(req)) {
    return sendError(res, req, new AppError('AUTH_INTERNAL_FORBIDDEN', {}, 403));
  }

  const action = pathname.slice('/__internal/desktop/'.length).trim();

  try {
    if (action === 'status') {
      return sendJson(res, 200, {
        ...desktopManager.getStatus(),
        vncPath: runtimeConfig.vncPathHref
      });
    }

    const body = await readJsonBody(req);

    if (action === 'config') {
      const r = applyDesktopConfigPatch(body, { desktopManager });
      return sendJson(res, 200, r);
    }

    if (action === 'master') {
      const r = await applyDesktopMaster(body && body.enabled !== false, {}, { desktopManager, pluginManager });
      return sendJson(res, 200, r);
    }

    if (action === 'start') {
      const r = await desktopManager.start(body);
      if (!r || r.ok === false) {
        return sendJson(res, 500, {
          ok: false,
          errorCode: r && r.disabled ? 'DESKTOP_DISABLED' : 'DESKTOP_START_FAILED',
          params: {},
          ...(r || {})
        });
      }
      return sendJson(res, 200, r);
    }

    if (action === 'stop') {
      const r = await desktopManager.stop();
      return sendJson(res, r && r.ok === false ? 500 : 200, r);
    }

    if (action === 'restart') {
      const r = await desktopManager.restart(body);
      if (!r || r.ok === false) {
        return sendJson(res, 500, {
          ok: false,
          errorCode: r && r.disabled ? 'DESKTOP_DISABLED' : 'DESKTOP_START_FAILED',
          params: {},
          ...(r || {})
        });
      }
      return sendJson(res, 200, r);
    }

    if (action === 'keepalive') {
      desktopManager.applyConfig(body);
      desktopManager.touchActivity(body.durationMinutes);
      return sendJson(res, 200, { ok: true, status: desktopManager.getStatus() });
    }

    return sendError(res, req, new AppError('NOT_FOUND', {}, 404, 'NOT_FOUND'));
  } catch (err) {
    return sendError(res, req, err);
  }
}

module.exports = { handleInternalDesktop };
