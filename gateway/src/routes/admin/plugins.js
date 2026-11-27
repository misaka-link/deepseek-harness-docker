'use strict';

/**
 * Admin plugin listing, toggle, install, and uninstall routes:
 *   GET  ${ADMIN_PATH}/api/plugins
 *   POST ${ADMIN_PATH}/api/plugins/toggle
 *   POST ${ADMIN_PATH}/api/plugins/uninstall
 *   POST ${ADMIN_PATH}/api/plugins/install
 */

const { AppError, sanitizeErrorMessage, translateServerMessage } = require('../../i18n/errors');
const { negotiateLocale } = require('../../i18n/negotiate');
const { readJsonBody } = require('../../http/body');
const { sendJson, sendCapabilityUnavailable } = require('../../http/respond');
const {
  BROWSER_DESKTOP_PLUGIN,
  isBrowserDesktopPluginName,
  applyDesktopMaster
} = require('../desktop-control');

const routes = [
  {
    method: 'GET',
    path: '/api/plugins',
    handler({ res, pluginManager }) {
      return sendJson(res, 200, pluginManager.getPlugins());
    }
  },
  {
    method: 'POST',
    path: '/api/plugins/toggle',
    async handler({ req, res, capabilities, pluginManager, desktopManager, dshManager }) {
      const body = await readJsonBody(req);
      if (!body || !body.name || typeof body.name !== 'string' || !body.name.trim()) {
        throw new AppError('PLUGIN_NAME_REQUIRED', {}, 400);
      }
      const name = body.name.trim();
      const enabled = body.enabled !== false;

      if (!capabilities.browser.pluginSupported && isBrowserDesktopPluginName(name) && enabled) {
        return sendCapabilityUnavailable(res, req, 'browser');
      }

      const r = await pluginManager.togglePlugin(name, enabled);

      let desktopMirrored = null;
      if (name === BROWSER_DESKTOP_PLUGIN && capabilities.desktop.supported) {
        try {
          const m = await applyDesktopMaster(enabled, { startNow: false }, { desktopManager, pluginManager });
          desktopMirrored = m.ok === true;
        } catch {
          desktopMirrored = false;
        }
      }

      let restarted = false;
      if (body.restart === true) {
        console.log(`[gateway] 插件 ${name} 已${enabled ? '启用' : '禁用'}，正在重启 DSH 以生效...`);
        const rr = await dshManager.restart().catch((err) => ({ ok: false, error: sanitizeErrorMessage(err) }));
        restarted = Boolean(rr && rr.ok);
        if (!restarted) {
          const locale = negotiateLocale(req);
          const detail = (rr && rr.error) || 'unknown';
          return sendJson(res, 500, {
            ...r,
            restarted: false,
            errorCode: 'PLUGIN_RESTART_FAILED',
            params: { detail },
            error: translateServerMessage(locale, 'PLUGIN_RESTART_FAILED', { detail })
          });
        }
      }

      return sendJson(res, 200, { ...r, restarted, desktopMirrored });
    }
  },
  {
    method: 'POST',
    path: '/api/plugins/uninstall',
    async handler({ req, res, pluginManager }) {
      const body = await readJsonBody(req);
      if (!body || !body.name || typeof body.name !== 'string' || !body.name.trim()) {
        throw new AppError('PLUGIN_NAME_REQUIRED', {}, 400);
      }
      const r = await pluginManager.uninstallPlugin(body.name.trim());
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/plugins/install',
    async handler({ req, res, capabilities, pluginManager }) {
      const body = await readJsonBody(req);
      if (!body || !body.name || typeof body.name !== 'string' || !body.name.trim()) {
        throw new AppError('PLUGIN_NAME_REQUIRED', {}, 400);
      }
      const name = body.name.trim();
      if (!capabilities.browser.pluginSupported && isBrowserDesktopPluginName(name)) {
        return sendCapabilityUnavailable(res, req, 'browser');
      }
      const r = await pluginManager.installPlugin(name);
      return sendJson(res, 200, r);
    }
  }
];

module.exports = routes;
