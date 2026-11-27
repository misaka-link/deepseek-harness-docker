'use strict';

/**
 * Unified HTTP JSON, error, HTML, and redirect response helpers.
 */

const { negotiateLocale } = require('../i18n/negotiate');
const { AppError, translateServerMessage, safeLogError } = require('../i18n/errors');

function sendJson(res, status, data, extraHeaders = {}) {
  if (!res || res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    });
  }
  res.end(JSON.stringify(data));
}

function resolveDomainErrorStatus(err) {
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return err.status;
  }
  const code = String(err.errorCode || '');
  if (err.code === 'BUSY' || code.endsWith('_BUSY')) return 409;
  if (err.code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND')) return 404;
  if (code === 'CAPABILITY_UNAVAILABLE' || code.endsWith('_PROTECTED')) return 403;
  return 400;
}

function sendError(res, req, err) {
  if (!res || res.writableEnded) return;
  const locale = negotiateLocale(req);

  if (err instanceof AppError || (err && typeof err.errorCode === 'string' && err.errorCode.length > 0)) {
    const localized = translateServerMessage(locale, err.errorCode, err.params);
    const payload = {
      ok: false,
      errorCode: err.errorCode,
      params: err.params || {},
      error: localized
    };
    const legacyCode = err.legacyCode || (typeof err.code === 'string' ? err.code : null);
    if (legacyCode) {
      payload.code = legacyCode;
    }
    return sendJson(res, resolveDomainErrorStatus(err), payload);
  }

  const { ref } = safeLogError(err, 'http');
  const localized = translateServerMessage(locale, 'INTERNAL_ERROR', { ref });
  return sendJson(res, 500, {
    ok: false,
    errorCode: 'INTERNAL_ERROR',
    params: { ref },
    error: localized
  });
}

function sendCapabilityUnavailable(res, req, capability = 'desktop') {
  return sendError(
    res,
    req,
    new AppError('CAPABILITY_UNAVAILABLE', { capability }, 403, 'CAPABILITY_UNAVAILABLE')
  );
}

function sendHtml(res, status, html, extraHeaders = {}) {
  if (!res || res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      ...extraHeaders
    });
  }
  res.end(html);
}

function sendRedirect(res, location, status = 302, extraHeaders = {}) {
  if (!res || res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(status, {
      Location: location,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      ...extraHeaders
    });
  }
  res.end();
}

function isHtmlNavigation(req) {
  return Boolean(req && req.method === 'GET' && String((req.headers && req.headers.accept) || '').includes('text/html'));
}

module.exports = {
  sendJson,
  sendError,
  sendCapabilityUnavailable,
  sendHtml,
  sendRedirect,
  isHtmlNavigation
};
