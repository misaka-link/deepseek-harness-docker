'use strict';

/**
 * Unauthenticated health probe endpoint: GET /healthz.
 */

const session = require('../auth/session');
const setupGate = require('../auth/setup-gate');
const { resolveProjectVersion } = require('../core/project-version');
const { sendJson } = require('../http/respond');

function handleHealthz(req, res, ctx) {
  const {
    runtimeConfig,
    capabilities,
    desktopManager,
    dshManager,
    getWatchdogStatusSafe,
    getConfigState
  } = ctx;

  const ds = desktopManager.getStatus();
  const dsh = dshManager.getStatus();
  const cfgState = typeof getConfigState === 'function' ? getConfigState() : { locked: false, reason: null };

  const payload = {
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    projectVersion: resolveProjectVersion(),
    port: runtimeConfig.proxyPort,
    locked: Boolean(cfgState && cfgState.locked),
    authEnabled: session.isAuthEnabled(),
    setupRequired: !cfgState.locked && setupGate.isSetupRequired(),
    configSource: runtimeConfig.configSource,
    adminPath: runtimeConfig.adminPath,
    vncPath: runtimeConfig.vncPath,
    dsh: { running: !!dsh.running, ready: !!dsh.ready },
    desktop: { enabled: !!ds.enabled, running: !!ds.running },
    watchdog: typeof getWatchdogStatusSafe === 'function'
      ? getWatchdogStatusSafe()
      : { enabled: false, running: false },
    proxyTimeoutMs: runtimeConfig.proxyTimeoutMs,
    variant: capabilities.variant,
    capabilities: {
      desktop: capabilities.desktop.supported,
      golang: capabilities.golang.supported,
      vnc: capabilities.vnc.supported
    }
  };

  if (dsh && dsh.patches) {
    payload.patches = dsh.patches;
  } else if (dsh && dsh.needleResidue !== undefined && dsh.needleResidue !== null) {
    payload.patches = { needleResidue: dsh.needleResidue };
  }

  return sendJson(res, 200, payload);
}

module.exports = { handleHealthz };
