'use strict';

/**
 * Admin gateway configuration persistence endpoint:
 *   POST ${ADMIN_PATH}/api/config/save
 *
 * Uses merge-write so existing fields (trustProxy, publicHost, npmRegistry, and unknown keys)
 * are always preserved across saves.
 */

const session = require('../../auth/session');
const setupGate = require('../../auth/setup-gate');
const gatewayConfig = require('../../config/gateway-config');
const { AppError, translateServerMessage } = require('../../i18n/errors');
const { negotiateLocale } = require('../../i18n/negotiate');
const { readJsonBody } = require('../../http/body');
const { sendJson } = require('../../http/respond');

const routes = [
  {
    method: 'POST',
    path: '/api/config/save',
    async handler({ req, res, runtimeConfig, capabilities, desktopManager, dshManager, scheduleRestart }) {
      const body = await readJsonBody(req);

      const newPort = Number(body.proxyPort) || runtimeConfig.proxyPort;
      if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
        throw new AppError('CONFIG_PORT_INVALID', {}, 400);
      }

      const newAdmin = gatewayConfig.normalizeRoutePath(body.adminPath, '/admin');
      const newVnc = gatewayConfig.normalizeRoutePath(body.vncPath, '/vnc');
      if (newAdmin === newVnc) {
        throw new AppError('CONFIG_PATH_CONFLICT', {}, 400);
      }

      let updatedToken = session.getAuthToken();
      if (body.clearAuthToken === true) {
        updatedToken = '';
      } else if (body.authToken !== undefined && body.authToken !== '' && body.authToken !== '******') {
        updatedToken = String(body.authToken).trim();
      }
      if (updatedToken && updatedToken !== session.getAuthToken()) {
        setupGate.validatePasswordStrength(updatedToken);
      }

      const autoHealPlugins = body.autoHealPlugins !== false;
      const autoHealMaxPerBoot = Math.max(1, Math.min(50, Number(body.autoHealMaxPerBoot) || 5));
      dshManager.setAutoHeal(autoHealPlugins, autoHealMaxPerBoot);

      const newPruneMode = gatewayConfig.normalizePruneMode(body.pruneStaleBundles);
      const newPruneExtra = gatewayConfig.normalizePruneExtra(body.pruneBundlesExtra);

      const patch = {
        proxyPort: newPort,
        adminPath: newAdmin,
        vncPath: newVnc,
        authToken: updatedToken,
        autoHealPlugins,
        autoHealMaxPerBoot,
        pruneStaleBundles: newPruneMode,
        pruneBundlesExtra: newPruneExtra
      };

      if (body.trustProxy !== undefined) {
        patch.trustProxy = body.trustProxy === true || body.trustProxy === '1' || body.trustProxy === 'true';
      }
      if (typeof body.publicHost === 'string') {
        patch.publicHost = body.publicHost.trim();
      }
      if (typeof body.npmRegistry === 'string' && body.npmRegistry.trim()) {
        patch.npmRegistry = body.npmRegistry.trim();
      }

      if (capabilities.desktop.supported) {
        const ds = desktopManager.getStatus();
        patch.desktop = {
          enabled: desktopManager.isEnabled(),
          width: ds.width,
          height: ds.height,
          enableCdp: ds.enableCdp,
          cdpPort: ds.cdpPort,
          idleTimeoutMinutes: ds.idleTimeoutMinutes,
          enableSidebarTab: ds.enableSidebarTab,
          screenshotQuality: ds.screenshotQuality,
          screenshotDir: ds.screenshotDir
        };
      }

      // Merge-write preserves trustProxy, publicHost, npmRegistry, and any unknown fields
      const saved = gatewayConfig.mergeSaveGatewayConfig(patch);
      if (!saved.ok) {
        throw new AppError('CONFIG_PERSIST_FAILED', {}, 500);
      }

      runtimeConfig.pruneStaleBundles = newPruneMode;
      runtimeConfig.pruneBundlesExtra = newPruneExtra;

      const logSafeCfg = { ...saved.config, authToken: saved.config.authToken ? '******' : '' };
      console.log('[gateway] 管理后台提交新配置:', logSafeCfg);

      const locale = negotiateLocale(req);
      sendJson(res, 200, {
        ok: true,
        message: translateServerMessage(locale, 'CONFIG_SAVED_RESTARTING'),
        newPort,
        newAdminPath: newAdmin,
        newVncPath: newVnc
      });

      if (typeof scheduleRestart === 'function') {
        scheduleRestart();
      } else {
        setTimeout(async () => {
          console.log('[gateway] 执行重启以应用新网关配置...');
          try {
            await desktopManager.stop();
          } catch {}
          try {
            await dshManager.stop();
          } catch {}
          process.exit(0);
        }, 800);
      }
    }
  }
];

module.exports = routes;
