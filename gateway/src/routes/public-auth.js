'use strict';

/**
 * Public authentication & first-run setup routes:
 *   GET  /login
 *   POST /__auth/verify
 *   GET  /logout
 *   GET  /setup
 *   POST /__auth/setup
 */

const session = require('../auth/session');
const rateLimit = require('../auth/rate-limit');
const setupGate = require('../auth/setup-gate');
const gatewayConfig = require('../config/gateway-config');
const { AppError } = require('../i18n/errors');
const { readJsonBody } = require('../http/body');
const { sendJson, sendError, sendRedirect } = require('../http/respond');
const { renderTemplate } = require('../http/pages');

async function handleAuthVerify(req, res) {
  const clientIp = rateLimit.resolveClientIp(req);
  const rl = rateLimit.checkRateLimit(clientIp);
  if (!rl.allowed) {
    return sendError(res, req, new AppError('AUTH_RATE_LIMITED', { retryAfterSec: rl.retryAfterSec }, 429));
  }

  let data;
  try {
    data = await readJsonBody(req, { maxBytes: 64 * 1024, allowEmpty: false });
  } catch (err) {
    return sendError(res, req, err);
  }

  const token = typeof data.token === 'string' ? data.token.trim() : '';
  if (session.verifyToken(token)) {
    rateLimit.recordAuthAttempt(clientIp, true);
    session.setAuthCookie(res, req);
    return sendJson(res, 200, { ok: true });
  }

  rateLimit.recordAuthAttempt(clientIp, false);
  return sendError(res, req, new AppError('AUTH_INVALID_TOKEN', {}, 401));
}

async function handleSetupSubmit(req, res, ctx) {
  const cfgState = typeof ctx.getConfigState === 'function' ? ctx.getConfigState() : gatewayConfig.getConfigState();
  if (cfgState && cfgState.locked) {
    const files = (cfgState.files || []).map((f) => f.path).join(', ');
    return sendError(res, req, new AppError('SETUP_LOCKED_UNREADABLE_CONFIG', { files }, 423));
  }

  if (!setupGate.isSetupRequired()) {
    return sendError(res, req, new AppError('SETUP_ALREADY_DONE', {}, 409));
  }

  const clientIp = rateLimit.resolveClientIp(req);
  const rl = rateLimit.checkRateLimit(clientIp);
  if (!rl.allowed) {
    return sendError(res, req, new AppError('AUTH_RATE_LIMITED', { retryAfterSec: rl.retryAfterSec }, 429));
  }

  let data;
  try {
    data = await readJsonBody(req, { maxBytes: 64 * 1024, allowEmpty: false });
  } catch (err) {
    return sendError(res, req, err);
  }

  let pwd;
  try {
    pwd = setupGate.validateSetupPassword(data.password, data.confirm);
  } catch (err) {
    return sendError(res, req, err);
  }

  const saveRes = gatewayConfig.mergeSaveGatewayConfig({ authToken: pwd });
  if (!saveRes.ok) {
    if (saveRes.locked) {
      return sendError(res, req, new AppError('SETUP_LOCKED_UNREADABLE_CONFIG', { files: '' }, 423));
    }
    return sendError(res, req, new AppError('SETUP_PERSIST_FAILED', {}, 500));
  }

  session.updateAuthToken(pwd);
  rateLimit.recordAuthAttempt(clientIp, true);
  // Pass req so HTTPS requests receive the Secure cookie attribute
  session.setAuthCookie(res, req);
  console.log('[gateway] 已通过初始化向导设置访问口令');
  return sendJson(res, 200, {
    ok: true,
    adminPath: (ctx.runtimeConfig && ctx.runtimeConfig.adminPath) || '/admin'
  });
}

async function handlePublicAuthRoutes(req, res, pathname, ctx) {
  const { runtimeConfig, capabilities } = ctx;

  if (pathname === '/login') {
    if (setupGate.isSetupRequired()) {
      sendRedirect(res, '/setup');
      return true;
    }
    renderTemplate(req, res, 'login', {}, 200, { runtimeConfig, capabilities });
    return true;
  }

  if (pathname === '/__auth/verify' && req.method === 'POST') {
    await handleAuthVerify(req, res, ctx);
    return true;
  }

  if (pathname === '/logout') {
    session.clearAuthCookie(res);
    sendRedirect(res, setupGate.isSetupRequired() ? '/setup' : '/login');
    return true;
  }

  if (pathname === '/setup' && req.method === 'GET') {
    if (!setupGate.isSetupRequired()) {
      sendRedirect(res, '/login');
      return true;
    }
    renderTemplate(req, res, 'setup', {}, 200, { runtimeConfig, capabilities });
    return true;
  }

  if (pathname === '/__auth/setup' && req.method === 'POST') {
    await handleSetupSubmit(req, res, ctx);
    return true;
  }

  return false;
}

module.exports = {
  handleAuthVerify,
  handleSetupSubmit,
  handlePublicAuthRoutes
};
