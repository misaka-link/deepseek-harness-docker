'use strict';

/**
 * DeepSeek account helper endpoints:
 *   GET/POST /account/callback          (manual OAuth callback relay)
 *   GET      /__api/account/client-version
 *   GET      /__api/account/status
 */

const fs = require('fs');
const path = require('path');
const paths = require('../core/paths');
const session = require('../auth/session');
const { AppError, translateServerMessage } = require('../i18n/errors');
const { negotiateLocale } = require('../i18n/negotiate');
const { readRawBody } = require('../http/body');
const { sendJson, sendError, sendRedirect } = require('../http/respond');
const { renderTemplate } = require('../http/pages');

const ACCOUNT_CALLBACK_PATH = '/account/callback';

function normalizeAccountCallbackLink(link) {
  const raw = String(link || '').trim();
  if (!raw) return { ok: false, reason: 'empty_url' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_protocol' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials_not_allowed' };
  }
  if (url.pathname !== '/oauth/callback') {
    return { ok: false, reason: 'invalid_path' };
  }
  if (!url.searchParams.get('code') || !url.searchParams.get('state')) {
    return { ok: false, reason: 'missing_code_or_state' };
  }
  return { ok: true, query: url.search };
}

async function handleAccountManualCallback(req, res, ctx) {
  const locale = negotiateLocale(req);
  let body = '';
  try {
    body = await readRawBody(req, { maxBytes: 8192 });
  } catch (err) {
    return sendError(res, req, err);
  }

  let link = '';
  try {
    if (String(req.headers['content-type'] || '').includes('application/json')) {
      const parsed = JSON.parse(body || '{}');
      link = (parsed && parsed.link) || '';
    } else {
      link = new URLSearchParams(body).get('link') || '';
    }
  } catch {
    return sendError(res, req, new AppError('REQ_INVALID_JSON', {}, 400));
  }

  const v = normalizeAccountCallbackLink(link);
  if (!v.ok) {
    return sendError(res, req, new AppError('ACCOUNT_CALLBACK_INVALID', { reason: v.reason }, 400));
  }

  const dshPort = (ctx.runtimeConfig && ctx.runtimeConfig.dshPort) || 3079;
  try {
    const resp = await fetch('http://127.0.0.1:' + dshPort + '/oauth/callback' + v.query, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });
    await resp.arrayBuffer().catch(() => {});
    const ok = resp.status >= 200 && resp.status < 400;
    return sendJson(res, ok ? 200 : 502, {
      ok,
      status: resp.status,
      ...(ok ? {} : { errorCode: 'ACCOUNT_CALLBACK_REJECTED', params: {} }),
      message: translateServerMessage(locale, ok ? 'ACCOUNT_CALLBACK_SUCCESS' : 'ACCOUNT_CALLBACK_REJECTED')
    });
  } catch {
    return sendError(res, req, new AppError('ACCOUNT_CALLBACK_FORWARD_FAILED', { status: 502 }, 502));
  }
}

async function handleAccountCallbackRoute(req, res, ctx) {
  if (!session.checkRequestAuth(req)) {
    if (req.method === 'GET') {
      return sendRedirect(res, '/login?redirect=' + encodeURIComponent(req.url || ACCOUNT_CALLBACK_PATH));
    }
    return sendError(res, req, new AppError('AUTH_REQUIRED', {}, 401));
  }

  if (req.method === 'GET') {
    return renderTemplate(req, res, 'account-callback', {}, 200, {
      runtimeConfig: ctx.runtimeConfig,
      capabilities: ctx.capabilities
    });
  }
  if (req.method === 'POST') {
    return handleAccountManualCallback(req, res, ctx);
  }
  return sendError(res, req, new AppError('NOT_FOUND', {}, 404, 'NOT_FOUND'));
}

function handleAccountClientVersion(req, res) {
  const candidates = [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/app/node_modules/@deepseek-ai/dsh/package.json'
  ];
  let version = null;
  for (const p of candidates) {
    try {
      version = JSON.parse(fs.readFileSync(p, 'utf8')).version || null;
    } catch {}
    if (version) break;
  }
  return sendJson(res, 200, { version });
}

function handleAccountStatus(req, res) {
  const candidates = [
    path.join(paths.getDshDir(), '.credentials.yaml'),
    process.env.DSH_HOME ? path.join(process.env.DSH_HOME, '.credentials.yaml') : null,
    path.join(paths.LEGACY_ROOT_DSH_DIR, '.credentials.yaml'),
    '/home/node/.dsh/.credentials.yaml'
  ].filter(Boolean);

  const uniqueCandidates = [...new Set(candidates)];
  let signedIn = false;
  let reason = null;
  for (const file of uniqueCandidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      signedIn = /(^|\n)\s*deepseek-account-platform\/default:/.test(text);
      reason = null;
      break;
    } catch (err) {
      reason = (err && err.code) || (err && err.message) || 'READ_ERROR';
    }
  }
  return sendJson(res, 200, { signedIn, reason });
}

module.exports = {
  ACCOUNT_CALLBACK_PATH,
  normalizeAccountCallbackLink,
  handleAccountCallbackRoute,
  handleAccountClientVersion,
  handleAccountStatus
};
