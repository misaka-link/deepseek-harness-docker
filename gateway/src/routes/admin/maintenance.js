'use strict';

/**
 * Admin maintenance endpoints (tool cache self-healing):
 *   GET  ${ADMIN_PATH}/api/maintenance/npx-cache
 *   POST ${ADMIN_PATH}/api/maintenance/npx-cache/heal
 */

const { AppError } = require('../../i18n/errors');
const { sendJson } = require('../../http/respond');

const routes = [
  {
    method: 'GET',
    path: '/api/maintenance/npx-cache',
    handler({ res, getToolCacheHealer }) {
      const healer = typeof getToolCacheHealer === 'function' ? getToolCacheHealer() : null;
      return sendJson(res, 200, {
        ok: true,
        status: healer ? healer.getStatus() : { enabled: false, running: false }
      });
    }
  },
  {
    method: 'POST',
    path: '/api/maintenance/npx-cache/heal',
    handler({ res, getToolCacheHealer }) {
      const healer = typeof getToolCacheHealer === 'function' ? getToolCacheHealer() : null;
      if (!healer) {
        throw new AppError('MAINTENANCE_UNAVAILABLE', {}, 503);
      }
      const result = healer.runOnce({ quietMs: 120000 });
      return sendJson(res, 200, { ok: true, result });
    }
  }
];

module.exports = routes;
