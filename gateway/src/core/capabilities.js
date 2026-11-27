'use strict';

/**
 * Runtime image variant capability truth source (env-only, zero side effects).
 * Exports frozen CAPABILITIES object plus computeCapabilities(env) helper for tests.
 */

function parseCapabilitiesEnv(envVal) {
  const overrides = {};
  if (!envVal || typeof envVal !== 'string') return overrides;
  const pairs = envVal.split(/[,;\s]+/);
  for (const pair of pairs) {
    if (!pair) continue;
    const [k, v] = pair.split('=').map((s) => s.trim().toLowerCase());
    if (!k) continue;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off' || v === 'disable' || v === 'disabled') {
      overrides[k] = false;
    } else if (v === '1' || v === 'true' || v === 'yes' || v === 'on' || v === 'enable' || v === 'enabled' || v === undefined) {
      overrides[k] = true;
    }
  }
  return overrides;
}

const KNOWN_VARIANTS = new Set(['standard', 'market', 'full', 'mini']);

function parseBoolEnv(val) {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim().toLowerCase();
  if (!s) return undefined;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return undefined;
}

function computeCapabilities(env = process.env) {
  const sourceEnv = env || {};
  const rawVariant = String(sourceEnv.DSH_VARIANT || 'standard').trim().toLowerCase();
  const variant = KNOWN_VARIANTS.has(rawVariant) ? rawVariant : 'standard';
  const isMini = variant === 'mini';

  let desktopSupported = !isMini;
  const installGoEnv = parseBoolEnv(sourceEnv.DSH_INSTALL_GO);
  let golangSupported = installGoEnv !== undefined ? installGoEnv : (variant === 'full');
  let vncSupported = !isMini;

  const capOverrides = parseCapabilitiesEnv(sourceEnv.DSH_CAPABILITIES);
  if (typeof capOverrides.desktop === 'boolean') {
    desktopSupported = capOverrides.desktop;
  }
  if (typeof capOverrides.golang === 'boolean') {
    golangSupported = capOverrides.golang;
  }
  if (typeof capOverrides.vnc === 'boolean') {
    vncSupported = capOverrides.vnc;
  } else {
    vncSupported = vncSupported && desktopSupported;
  }

  const desktopEnabled = desktopSupported && sourceEnv.DSH_DESKTOP_ENABLED !== '0';

  const vncPathRaw = String(sourceEnv.VNC_PATH || '/vnc').trim() || '/vnc';
  const vncPathNorm = vncPathRaw.endsWith('/') ? vncPathRaw : vncPathRaw + '/';

  const caps = {
    variant,
    desktop: {
      supported: desktopSupported,
      enabled: desktopEnabled,
      ...(!desktopSupported
        ? {
            reason: isMini
              ? '当前为 mini 镜像：未预装 Chromium 与 X11/noVNC 桌面栈'
              : '当前环境已停用 Chromium 与 X11/noVNC 桌面能力'
          }
        : {})
    },
    browser: {
      containerBrowser: desktopSupported,
      pluginSupported: desktopSupported,
      sidebarBrowserSupported: true
    },
    golang: {
      supported: golangSupported
    },
    vnc: {
      supported: vncSupported,
      path: vncSupported ? vncPathNorm : null
    }
  };

  Object.freeze(caps.desktop);
  Object.freeze(caps.browser);
  Object.freeze(caps.golang);
  Object.freeze(caps.vnc);

  return caps;
}

const CAPABILITIES = computeCapabilities(process.env);
Object.defineProperty(CAPABILITIES, 'computeCapabilities', {
  value: computeCapabilities,
  enumerable: false,
  writable: false,
  configurable: false
});
Object.defineProperty(CAPABILITIES, 'CAPABILITIES', {
  value: CAPABILITIES,
  enumerable: false,
  writable: false,
  configurable: false
});
Object.freeze(CAPABILITIES);

module.exports = CAPABILITIES;
