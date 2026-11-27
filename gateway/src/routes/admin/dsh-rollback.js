'use strict';

/**
 * Admin DSH in-place rollback slot management and SSE restore:
 *   GET    ${ADMIN_PATH}/api/dsh/rollback
 *   DELETE ${ADMIN_PATH}/api/dsh/rollback
 *   POST   ${ADMIN_PATH}/api/dsh/rollback/restore
 */

const { AppError } = require('../../i18n/errors');
const { sendJson } = require('../../http/respond');
const { openSse } = require('../../http/sse');

const routes = [
  {
    method: 'GET',
    path: '/api/dsh/rollback',
    handler({ res, dshManager }) {
      const rb = dshManager.getRollbackPoint();
      return sendJson(res, 200, {
        ok: true,
        exists: rb.exists,
        rollback: rb.exists ? rb : null,
        ...rb
      });
    }
  },
  {
    method: 'DELETE',
    path: '/api/dsh/rollback',
    handler({ res, dshManager }) {
      if (dshManager.installing) {
        throw new AppError('ROLLBACK_BUSY', {}, 409);
      }
      const current = dshManager.getRollbackPoint();
      if (!current.exists) {
        throw new AppError('ROLLBACK_NOT_FOUND', {}, 404);
      }
      const r = dshManager.deleteRollbackPoint();
      if (!r.ok) {
        if (r.error && r.error.includes('进行中')) {
          throw new AppError('ROLLBACK_BUSY', {}, 409);
        }
        if (r.error && r.error.includes('不存在')) {
          throw new AppError('ROLLBACK_NOT_FOUND', {}, 404);
        }
        return sendJson(res, 500, r);
      }
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/dsh/rollback/restore',
    async handler({ req, res, versionService, dshManager }) {
      if (dshManager.installing) {
        throw new AppError('DSH_BUSY_INSTALLING', {}, 409);
      }
      const current = dshManager.getRollbackPoint();
      if (!current.exists) {
        throw new AppError('ROLLBACK_NOT_FOUND', {}, 404);
      }
      if (!current.abiMatches) {
        throw new AppError(
          'ROLLBACK_ABI_MISMATCH',
          { expected: String(process.versions.modules || ''), actual: String(current.nodeAbi || 'unknown') },
          400
        );
      }
      if (current.version && versionService && typeof versionService.evaluateTargetVersion === 'function') {
        const evalRes = versionService.evaluateTargetVersion(current.version);
        if (evalRes && evalRes.level === 'danger') {
          if (evalRes.kind === 'engine-unsupported') {
            throw new AppError(
              'DSH_ENGINE_UNSUPPORTED',
              { version: current.version, floor: (evalRes.params && evalRes.params.floor) || '0.2.3-alpha.2' },
              400
            );
          }
          throw new AppError('DSH_VERSION_BREAKING', { version: current.version }, 400);
        }
      }

      const sse = openSse(res, req);
      sse.log('sse.rollback.starting', { version: current.version || 'unknown' });

      const r = await dshManager.restoreRollbackPoint(
        (prog) => sse.progress(prog),
        (line) => sse.log(line)
      );

      sse.done(r);
    }
  }
];

module.exports = routes;
