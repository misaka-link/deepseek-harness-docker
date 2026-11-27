'use strict';

/**
 * Admin DSH process lifecycle and log routes:
 *   GET  ${ADMIN_PATH}/api/dsh/logs
 *   POST ${ADMIN_PATH}/api/dsh/start
 *   POST ${ADMIN_PATH}/api/dsh/stop
 *   POST ${ADMIN_PATH}/api/dsh/restart
 *   POST ${ADMIN_PATH}/api/dsh/auto-heal/clear
 */

const { sendJson } = require('../../http/respond');

const routes = [
  {
    method: 'GET',
    path: '/api/dsh/logs',
    handler({ res, query, dshManager }) {
      const count = Math.min(Number(query.get('lines')) || 100, 300);
      return sendJson(res, 200, {
        ok: true,
        running: dshManager.proc !== null && dshManager.proc.exitCode === null,
        ready: dshManager.ready,
        pid: dshManager.proc ? dshManager.proc.pid : null,
        manualStopped: !!dshManager.manualStopped,
        exitInfo: dshManager.lastExitInfo,
        recentLogs: dshManager.getRecentLogs(count)
      });
    }
  },
  {
    method: 'POST',
    path: '/api/dsh/start',
    async handler({ res, dshManager }) {
      if (typeof dshManager.setManualStopped === 'function') dshManager.setManualStopped(false);
      else dshManager.manualStopped = false;
      const r = await dshManager.boot();
      return sendJson(res, r && r.ok ? 200 : 500, r);
    }
  },
  {
    method: 'POST',
    path: '/api/dsh/stop',
    async handler({ res, dshManager }) {
      if (typeof dshManager.setManualStopped === 'function') dshManager.setManualStopped(true);
      else dshManager.manualStopped = true;
      const r = await dshManager.stop();
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/dsh/restart',
    async handler({ res, dshManager }) {
      if (typeof dshManager.setManualStopped === 'function') dshManager.setManualStopped(false);
      else dshManager.manualStopped = false;
      const r = await dshManager.restart();
      return sendJson(res, r && r.ok ? 200 : 500, r);
    }
  },
  {
    method: 'POST',
    path: '/api/dsh/auto-heal/clear',
    handler({ res, dshManager }) {
      dshManager.clearAutoIsolatedEvents();
      return sendJson(res, 200, { ok: true });
    }
  }
];

module.exports = routes;
