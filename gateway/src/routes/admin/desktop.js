'use strict';

/**
 * Admin container desktop & browser control routes (guarded by desktop capability):
 *   POST ${ADMIN_PATH}/api/desktop/master
 *   POST ${ADMIN_PATH}/api/desktop/config
 *   POST ${ADMIN_PATH}/api/desktop/start
 *   POST ${ADMIN_PATH}/api/desktop/stop
 *   POST ${ADMIN_PATH}/api/desktop/restart
 *   POST ${ADMIN_PATH}/api/desktop/keepalive
 */

const { sanitizeErrorMessage, translateServerMessage } = require('../../i18n/errors');
const { negotiateLocale } = require('../../i18n/negotiate');
const { readJsonBody } = require('../../http/body');
const { sendJson } = require('../../http/respond');
const { applyDesktopConfigPatch, applyDesktopMaster } = require('../desktop-control');

const routes = [
  {
    method: 'POST',
    path: '/api/desktop/master',
    capability: 'desktop',
    async handler({ req, res, desktopManager, pluginManager, dshManager }) {
      const body = await readJsonBody(req);
      const r = await applyDesktopMaster(body && body.enabled !== false, {}, { desktopManager, pluginManager });
      if (body && body.restart === true) {
        console.log('[gateway] 浏览器总开关已切换，正在重启 DSH 以同步 AI 工具菜单...');
        const rr = await dshManager.restart().catch((err) => ({ ok: false, error: sanitizeErrorMessage(err) }));
        r.dshRestarted = Boolean(rr && rr.ok);
        if (!r.dshRestarted) {
          const locale = negotiateLocale(req);
          r.warning = translateServerMessage(locale, 'PLUGIN_RESTART_FAILED', {
            detail: (rr && rr.error) || 'unknown'
          });
        }
      }
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/desktop/config',
    capability: 'desktop',
    async handler({ req, res, desktopManager }) {
      const body = await readJsonBody(req);
      const r = applyDesktopConfigPatch(body, { desktopManager });
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/desktop/start',
    capability: 'desktop',
    async handler({ req, res, desktopManager }) {
      const body = await readJsonBody(req);
      const r = await desktopManager.start(body);
      return sendJson(res, r && r.ok ? 200 : 500, r);
    }
  },
  {
    method: 'POST',
    path: '/api/desktop/stop',
    capability: 'desktop',
    async handler({ res, desktopManager }) {
      const r = await desktopManager.stop();
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/desktop/restart',
    capability: 'desktop',
    async handler({ req, res, desktopManager }) {
      const body = await readJsonBody(req);
      const r = await desktopManager.restart(body);
      return sendJson(res, r && r.ok ? 200 : 500, r);
    }
  },
  {
    method: 'POST',
    path: '/api/desktop/keepalive',
    capability: 'desktop',
    async handler({ req, res, desktopManager }) {
      const body = await readJsonBody(req);
      desktopManager.applyConfig(body);
      desktopManager.touchActivity(body.durationMinutes);
      return sendJson(res, 200, { ok: true, status: desktopManager.getStatus() });
    }
  }
];

module.exports = routes;
