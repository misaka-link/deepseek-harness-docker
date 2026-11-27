'use strict';

/**
 * Admin status and i18n catalog endpoints:
 *   GET ${ADMIN_PATH}/api/status
 *   GET ${ADMIN_PATH}/api/ui/i18n-catalog
 */

const session = require('../../auth/session');
const { negotiateLocale } = require('../../i18n/negotiate');
const { getErrorCatalog } = require('../../i18n/errors');
const { sendJson } = require('../../http/respond');

const routes = [
  {
    method: 'GET',
    path: '/api/status',
    handler({ res, runtimeConfig, capabilities, versionService, dshManager, desktopManager }) {
      const npmRegistry =
        (dshManager && typeof dshManager.getNpmRegistry === 'function' ? dshManager.getNpmRegistry() : '') ||
        runtimeConfig.npmRegistry ||
        '';

      return sendJson(res, 200, {
        project: {
          version: versionService.getLocalProjectVersion(),
          versionSources: typeof versionService.describeProjectVersion === 'function'
            ? versionService.describeProjectVersion().sources
            : undefined
        },
        dsh: dshManager.getStatus(),
        desktop: desktopManager.getStatus(),
        paths: {
          admin: runtimeConfig.adminPath,
          vnc: capabilities.vnc.supported ? runtimeConfig.vncPathHref : null,
          proxyPort: runtimeConfig.proxyPort
        },
        capabilities,
        authEnabled: session.isAuthEnabled(),
        authToken: session.isAuthEnabled() && session.getAuthToken() ? '******' : '',
        hasAuthToken: Boolean(session.getAuthToken()),
        autoHealPlugins: dshManager.autoHealEnabled,
        autoHealMaxPerBoot: dshManager.maxAutoHealPerBoot,
        pruneStaleBundles: runtimeConfig.pruneStaleBundles,
        pruneBundlesExtra: runtimeConfig.pruneBundlesExtra,
        npmRegistry,
        autoIsolatedEvents: typeof dshManager.getAutoIsolatedEvents === 'function'
          ? dshManager.getAutoIsolatedEvents()
          : []
      });
    }
  },
  {
    method: 'GET',
    path: '/api/ui/i18n-catalog',
    handler({ req, res }) {
      const locale = negotiateLocale(req);
      return sendJson(res, 200, {
        ok: true,
        ...getErrorCatalog(locale)
      });
    }
  }
];

module.exports = routes;
