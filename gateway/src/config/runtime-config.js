'use strict';

/**
 * Effective runtime gateway configuration derived from environment variables,
 * persisted gateway.config.json, and image CAPABILITIES.
 * Explicit environment variables take precedence over persisted values.
 */

const CAPABILITIES = require('../core/capabilities');
const {
  normalizePruneMode,
  normalizePruneExtra,
  normalizeRoutePath
} = require('./gateway-config');

function warnConfigConflict(label, envValue, persistedValue) {
  if (envValue === undefined || envValue === '' || persistedValue === undefined) return;
  if (String(envValue) !== String(persistedValue)) {
    console.warn(
      `[runtime-config] 配置冲突: ${label} 环境变量(${envValue}) 与持久化配置(${persistedValue}) 不一致，以环境变量为准`
    );
  }
}

function resolveProxyTimeoutMs(env = process.env) {
  const raw = env.DSH_PROXY_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === '') return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
}

function buildRuntimeConfig(persisted = {}, env = process.env, capabilities = CAPABILITIES) {
  const cfg = persisted && typeof persisted === 'object' ? persisted : {};

  const envPublicHost = env.PUBLIC_HOST !== undefined ? String(env.PUBLIC_HOST).trim() : '';
  const envTrustProxyRaw = env.TRUST_PROXY !== undefined ? String(env.TRUST_PROXY).trim().toLowerCase() : '';
  const hasExplicitTrustProxyEnv =
    envTrustProxyRaw === '1' ||
    envTrustProxyRaw === 'true' ||
    envTrustProxyRaw === '0' ||
    envTrustProxyRaw === 'false';

  warnConfigConflict('PROXY_PORT', env.PROXY_PORT, cfg.proxyPort);
  warnConfigConflict('ADMIN_PATH', env.ADMIN_PATH, cfg.adminPath);
  warnConfigConflict('VNC_PATH', env.VNC_PATH, cfg.vncPath);
  warnConfigConflict('PUBLIC_HOST', envPublicHost, cfg.publicHost);
  if (hasExplicitTrustProxyEnv) {
    warnConfigConflict('TRUST_PROXY', envTrustProxyRaw === '1' || envTrustProxyRaw === 'true', cfg.trustProxy);
  }

  const authTokenSource = (env.AUTH_TOKEN || env.ACCESS_CODE || '').trim()
    ? 'env'
    : (cfg.authToken !== undefined ? 'persisted' : 'default');

  const proxyPortSource = env.PROXY_PORT ? 'env' : (cfg.proxyPort ? 'persisted' : 'default');
  const proxyPort = Number(env.PROXY_PORT || cfg.proxyPort) || 3080;
  if (env === process.env) {
    process.env.PROXY_PORT = String(proxyPort);
  }

  const dshPort = Number(env.DSH_PORT) || 3079;
  const vncPort = Number(env.VNC_PORT) || 6080;

  const adminPathSource = env.ADMIN_PATH ? 'env' : (cfg.adminPath ? 'persisted' : 'default');
  const vncPathSource = env.VNC_PATH ? 'env' : (cfg.vncPath ? 'persisted' : 'default');
  const adminPath = normalizeRoutePath(env.ADMIN_PATH || cfg.adminPath, '/admin');
  const vncPath = normalizeRoutePath(env.VNC_PATH || cfg.vncPath, '/vnc');
  const vncPathHref = vncPath + '/';

  const publicHostSource = envPublicHost ? 'env' : (cfg.publicHost ? 'persisted' : 'default');
  const publicHosts = String(envPublicHost || cfg.publicHost || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const trustProxySource = hasExplicitTrustProxyEnv
    ? 'env'
    : (cfg.trustProxy !== undefined ? 'persisted' : 'default');
  const trustProxy = hasExplicitTrustProxyEnv
    ? (envTrustProxyRaw === '1' || envTrustProxyRaw === 'true')
    : (cfg.trustProxy === true || cfg.trustProxy === '1' || cfg.trustProxy === 'true');

  const autoHealPlugins = cfg.autoHealPlugins !== false;
  const autoHealMaxPerBoot = Math.max(1, Math.min(50, Number(cfg.autoHealMaxPerBoot) || 5));
  const pruneStaleBundles = normalizePruneMode(cfg.pruneStaleBundles);
  const pruneBundlesExtra = normalizePruneExtra(cfg.pruneBundlesExtra);
  const npmRegistry = String(cfg.npmRegistry || env.DSH_NPM_REGISTRY || '').trim();
  const novncRevision = String(env.NOVNC_ASSET_REVISION || '1.6.0').trim() || '1.6.0';
  const proxyTimeoutMs = resolveProxyTimeoutMs(env);

  const desktopConfig = capabilities.desktop.supported ? (cfg.desktop || null) : null;

  return {
    proxyPort,
    proxyPortSource,
    dshPort,
    vncPort,
    dshTarget: 'http://127.0.0.1:' + dshPort,
    vncTarget: 'http://127.0.0.1:' + vncPort,
    adminPath,
    adminPathSource,
    vncPath,
    vncPathSource,
    vncPathHref,
    authTokenSource,
    publicHosts,
    publicHostSource,
    trustProxy,
    trustProxySource,
    proxyTimeoutMs,
    autoHealPlugins,
    autoHealMaxPerBoot,
    pruneStaleBundles,
    pruneBundlesExtra,
    npmRegistry,
    novncRevision,
    desktopConfig,
    configSource: {
      port: proxyPortSource,
      adminPath: adminPathSource,
      vncPath: vncPathSource,
      authToken: authTokenSource
    }
  };
}

module.exports = {
  buildRuntimeConfig,
  resolveProxyTimeoutMs
};
