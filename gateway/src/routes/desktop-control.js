'use strict';

/**
 * Shared desktop master-switch and configuration helpers used by Admin API,
 * internal loopback plugin API, VNC route, and bootstrap.
 */

const gatewayConfig = require('../config/gateway-config');
const { AppError } = require('../i18n/errors');

const BROWSER_DESKTOP_PLUGIN = '@dsh-custom/dsh-browser-desktop';

function isBrowserDesktopPluginName(name) {
  if (typeof name !== 'string') return false;
  return (
    name === BROWSER_DESKTOP_PLUGIN ||
    name === 'dsh-browser-desktop' ||
    name.includes('dsh-browser-desktop')
  );
}

function isBrowserPluginDisabled(pluginManager) {
  try {
    const list = (pluginManager && pluginManager.getPlugins().plugins) || [];
    const p = list.find((x) => x.name === BROWSER_DESKTOP_PLUGIN);
    return Boolean(p && p.enabled === false);
  } catch {
    return false;
  }
}

function normalizeDesktopConfigPatch(input = {}) {
  const patch = {};
  if (!input || typeof input !== 'object') return patch;
  const w = Number(input.width);
  const h = Number(input.height);
  if (w > 0) patch.width = w;
  if (h > 0) patch.height = h;
  if (typeof input.idleTimeoutMinutes === 'number' && Number.isFinite(input.idleTimeoutMinutes)) {
    patch.idleTimeoutMinutes = input.idleTimeoutMinutes;
  }
  if (typeof input.enableCdp === 'boolean') patch.enableCdp = input.enableCdp;
  const cdp = Number(input.cdpPort);
  if (cdp > 0) patch.cdpPort = cdp;
  if (typeof input.enableSidebarTab === 'boolean') patch.enableSidebarTab = input.enableSidebarTab;
  if (typeof input.screenshotQuality === 'string' && ['high', 'medium', 'low'].includes(input.screenshotQuality)) {
    patch.screenshotQuality = input.screenshotQuality;
  }
  if (typeof input.screenshotDir === 'string') patch.screenshotDir = input.screenshotDir.trim();
  return patch;
}

function applyDesktopConfigPatch(input, { desktopManager }) {
  const patch = normalizeDesktopConfigPatch(input);
  if (!Object.keys(patch).length) {
    throw new AppError('CONFIG_NOTHING_TO_APPLY', {}, 400);
  }
  if (!gatewayConfig.persistDesktopConfig(patch)) {
    throw new AppError('DESKTOP_PERSIST_FAILED', {}, 500);
  }
  const changed = desktopManager.applyConfig(patch);
  return { ok: true, changed, desktop: desktopManager.getStatus() };
}

async function applyDesktopMaster(enabled, opts, { desktopManager, pluginManager }) {
  const next = enabled !== false;
  const startNow = !opts || opts.startNow !== false;

  if (next && isBrowserPluginDisabled(pluginManager)) {
    throw new AppError('DESKTOP_PLUGIN_DISABLED', {}, 409);
  }
  if (!gatewayConfig.persistDesktopConfig({ enabled: next })) {
    throw new AppError('DESKTOP_PERSIST_FAILED', {}, 500);
  }
  desktopManager.setEnabled(next);
  let r = { ok: true, skipped: true };
  if (next && startNow) r = await desktopManager.start();
  else if (!next) r = await desktopManager.stop();
  return { ok: true, enabled: next, result: r, desktop: desktopManager.getStatus() };
}

module.exports = {
  BROWSER_DESKTOP_PLUGIN,
  isBrowserDesktopPluginName,
  isBrowserPluginDisabled,
  normalizeDesktopConfigPatch,
  applyDesktopConfigPatch,
  applyDesktopMaster
};
