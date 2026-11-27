'use strict';

/**
 * Lightweight table-driven HTTP router with :param extraction,
 * capability checks, and centralized AppError handling.
 */

const { sendError, sendCapabilityUnavailable } = require('./respond');
const { AppError } = require('../i18n/errors');

function compilePattern(pattern) {
  if (!pattern.includes(':')) {
    return { exact: pattern, regex: null, keys: [] };
  }
  const keys = [];
  const escaped = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return {
    exact: null,
    regex: new RegExp('^' + escaped + '$'),
    keys
  };
}

function createRouter(routes = []) {
  const compiled = routes.map((route) => ({
    ...route,
    method: String(route.method || 'GET').toUpperCase(),
    compiled: route.path ? compilePattern(route.path) : null
  }));

  async function dispatch(req, res, subPath, ctx = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    for (const route of compiled) {
      if (route.method !== '*' && route.method !== method) continue;

      let params = null;
      if (route.compiled) {
        if (route.compiled.exact !== null) {
          if (subPath !== route.compiled.exact) continue;
          params = {};
        } else {
          const m = route.compiled.regex.exec(subPath);
          if (!m) continue;
          params = {};
          for (let i = 0; i < route.compiled.keys.length; i++) {
            try {
              params[route.compiled.keys[i]] = decodeURIComponent(m[i + 1]);
            } catch {
              return sendError(res, req, new AppError('REQ_FIELD_INVALID', { field: route.compiled.keys[i] }, 400));
            }
          }
        }
      } else if (typeof route.match === 'function') {
        const resMatch = route.match(subPath, req);
        if (!resMatch) continue;
        params = typeof resMatch === 'object' ? resMatch : {};
      } else {
        continue;
      }

      if (route.capability && ctx.capabilities) {
        const cap = ctx.capabilities[route.capability];
        if (!cap || !cap.supported) {
          return sendCapabilityUnavailable(res, req, route.capability);
        }
      }

      try {
        await route.handler({ ...ctx, req, res, subPath, params });
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, req, err);
        } else if (!res.writableEnded) {
          try {
            res.end();
          } catch {}
        }
      }
      return true;
    }

    return false;
  }

  return { dispatch, routes: compiled };
}

module.exports = { createRouter };
