'use strict';

/**
 * Admin snapshot backup, inspect, restore, import, delete, and download routes:
 *   GET  ${ADMIN_PATH}/api/snapshots
 *   GET  ${ADMIN_PATH}/api/snapshots/job
 *   POST ${ADMIN_PATH}/api/snapshots/create
 *   GET  ${ADMIN_PATH}/api/snapshots/inspect
 *   POST ${ADMIN_PATH}/api/snapshots/restore
 *   POST ${ADMIN_PATH}/api/snapshots/import
 *   POST ${ADMIN_PATH}/api/snapshots/delete
 *   GET  ${ADMIN_PATH}/api/snapshots/download
 */

const fs = require('fs');
const path = require('path');
const { AppError, sanitizeErrorMessage } = require('../../i18n/errors');
const { readJsonBody } = require('../../http/body');
const { sendJson } = require('../../http/respond');

const routes = [
  {
    method: 'GET',
    path: '/api/snapshots',
    handler({ res, backupService }) {
      return sendJson(res, 200, backupService.listBackups());
    }
  },
  {
    method: 'GET',
    path: '/api/snapshots/job',
    handler({ res, backupService }) {
      return sendJson(res, 200, { ok: true, job: backupService.getBackupJob() });
    }
  },
  {
    method: 'POST',
    path: '/api/snapshots/create',
    async handler({ req, res, query, backupService }) {
      const body = await readJsonBody(req);
      const isSync = Boolean((body && body.sync === true) || query.get('sync') === '1');
      if (isSync) {
        try {
          const r = await backupService.createBackup(body.name, body.type || body.backupType);
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof AppError) throw err;
          const msg = sanitizeErrorMessage(err);
          if (/正在执行|请稍候再试|BUSY/i.test(msg)) {
            throw new AppError('SNAPSHOT_BUSY', {}, 409, 'BUSY');
          }
          throw err;
        }
      }

      const r = backupService.startBackupJob(body.name, body.type || body.backupType);
      if (!r.ok && r.code === 'BUSY') {
        return sendJson(res, 409, {
          errorCode: 'SNAPSHOT_BUSY',
          params: {},
          ...r
        });
      }
      if (!r.ok) {
        return sendJson(res, 500, r);
      }
      return sendJson(res, 202, r);
    }
  },
  {
    method: 'GET',
    path: '/api/snapshots/inspect',
    async handler({ res, query, backupService }) {
      const file = query.get('file') || '';
      if (!file) {
        throw new AppError('REQ_FIELD_REQUIRED', { field: 'file' }, 400);
      }
      const r = await backupService.inspectSnapshot(file);
      if (!r.ok) {
        return sendJson(res, 404, {
          errorCode: r.errorCode || 'SNAPSHOT_NOT_FOUND',
          params: r.params || { file },
          ...r
        });
      }
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/snapshots/restore',
    async handler({ req, res, backupService, dshManager }) {
      const body = await readJsonBody(req);
      const mode = (body && body.mode) || 'full';
      if (mode !== 'full' && mode !== 'config-only') {
        throw new AppError('SNAPSHOT_INVALID_MODE', { mode }, 400);
      }
      const r = await backupService.restoreBackup(body.filename, dshManager, { mode });
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/snapshots/import',
    async handler({ req, res, query, backupService }) {
      const filename = query.get('filename') || req.headers['x-filename'] || 'imported-snapshot.tar.gz';
      const r = await backupService.importBackupStream(req, filename);
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/snapshots/delete',
    async handler({ req, res, backupService }) {
      const body = await readJsonBody(req);
      const r = backupService.deleteBackup(body.filename);
      return sendJson(res, r && r.ok ? 200 : 500, r);
    }
  },
  {
    method: 'GET',
    path: '/api/snapshots/download',
    handler({ res, query, backupService }) {
      const file = query.get('file') || '';
      const filePath = backupService.getBackupPath(file);
      if (!filePath) {
        throw new AppError('SNAPSHOT_NOT_FOUND', { file }, 404, 'NOT_FOUND');
      }
      const safeName = path.basename(filePath).replace(/["\r\n]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${safeName}"`
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      stream.pipe(res);
    }
  }
];

module.exports = routes;
