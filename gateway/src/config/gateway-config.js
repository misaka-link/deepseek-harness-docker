'use strict';

/**
 * Persistent gateway.config.json loader, merge-writer, legacy migration,
 * and fail-closed unreadable configuration detector.
 */

const fs = require('fs');
const path = require('path');
const paths = require('../core/paths');
const { writeFileAtomicSync } = require('../core/atomic-write');

let configState = {
  locked: false,
  reason: null,
  files: []
};

function normalizePruneMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'off';
  if (v === 'all') return 'all';
  return 'known';
}

function normalizePruneExtra(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((s) => String(s).trim()).filter(Boolean))].join(',');
  }
  const list = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(list)].join(',');
}

function normalizeRoutePath(raw, defaultPath) {
  let p = String(raw || defaultPath).trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');
  return p.length === 0 ? defaultPath : p;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Probe whether a file physically exists (via lstatSync) and whether it is readable.
 * Distinguishes ENOENT ("not created yet") from EACCES/EPERM/corruption ("fail-closed").
 */
function probeFile(filePath) {
  try {
    fs.lstatSync(filePath);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { exists: false, readable: false, content: null, code: err.code, error: null };
    }
    return {
      exists: true,
      readable: false,
      content: null,
      code: (err && err.code) || 'STAT_ERROR',
      error: (err && err.message) || String(err)
    };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { exists: true, readable: true, content, code: null, error: null };
  } catch (err) {
    return {
      exists: true,
      readable: false,
      content: null,
      code: (err && err.code) || 'READ_ERROR',
      error: (err && err.message) || String(err)
    };
  }
}

function tryLegacyMigration(targetConfigFile) {
  if (process.env.GATEWAY_CONFIG_FILE) return null;
  if (paths.getDshHome() === '/root') return null;

  const legacyFile = path.join(paths.LEGACY_ROOT_DSH_DIR, 'gateway.config.json');
  if (path.resolve(legacyFile) === path.resolve(targetConfigFile)) return null;

  try {
    const raw = fs.readFileSync(legacyFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;

    try {
      writeFileAtomicSync(
        targetConfigFile,
        JSON.stringify({ configVersion: 1, ...parsed }, null, 2) + '\n',
        { mode: 0o600 }
      );
      console.log('[gateway-config] 已从旧位置只读迁移配置至:', targetConfigFile);
    } catch (writeErr) {
      console.warn('[gateway-config] 迁移配置写入新路径失败（将继续使用读取到的配置）:', writeErr.message);
    }
    return parsed;
  } catch {
    // Legacy /root/.dsh may be inaccessible (0700) under non-root; ignore silently.
    return null;
  }
}

/**
 * Inspect readability of critical persisted files and load gateway.config.json.
 * Sets fail-closed configState.locked=true if gateway.config.json or .session_secret
 * physically exists but cannot be read or parsed.
 */
function loadGatewayConfig() {
  const configFile = paths.getGatewayConfigFile();
  const secretFile = paths.getSessionSecretFile();
  const lockedFiles = [];
  let loaded = {};

  const cfgProbe = probeFile(configFile);
  if (cfgProbe.exists) {
    if (!cfgProbe.readable) {
      lockedFiles.push({
        path: configFile,
        code: cfgProbe.code,
        error: cfgProbe.error
      });
    } else {
      try {
        const parsed = JSON.parse(cfgProbe.content);
        if (!isPlainObject(parsed)) {
          lockedFiles.push({
            path: configFile,
            code: 'INVALID_JSON',
            error: 'Configuration root must be a JSON object'
          });
        } else {
          loaded = parsed;
          console.log('[gateway-config] 成功加载持久化网关配置文件:', configFile);
        }
      } catch (err) {
        lockedFiles.push({
          path: configFile,
          code: 'INVALID_JSON',
          error: (err && err.message) || 'Invalid JSON'
        });
      }
    }
  } else {
    const migrated = tryLegacyMigration(configFile);
    if (migrated) {
      loaded = migrated;
    }
  }

  // Only inspect .session_secret readability when SESSION_SECRET env override is not set
  const hasEnvSecret = Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16);
  if (!hasEnvSecret) {
    const secProbe = probeFile(secretFile);
    if (secProbe.exists && !secProbe.readable) {
      lockedFiles.push({
        path: secretFile,
        code: secProbe.code,
        error: secProbe.error
      });
    }
  }

  if (lockedFiles.length > 0) {
    configState = {
      locked: true,
      reason: lockedFiles.map((f) => `${f.path} (${f.code})`).join('; '),
      files: lockedFiles
    };
    console.error('[gateway-config] 检测到关键配置文件不可读或已损坏，进入 fail-closed 锁定状态:', configState.reason);
  } else {
    configState = {
      locked: false,
      reason: null,
      files: []
    };
  }

  return { config: loaded, configState: getConfigState() };
}

function getConfigState() {
  return {
    locked: configState.locked,
    reason: configState.reason,
    files: configState.files.map((f) => ({ ...f }))
  };
}

/**
 * Merge-write patch into gateway.config.json, preserving all existing and unknown fields
 * (such as trustProxy, publicHost, npmRegistry, custom user keys).
 */
function mergeSaveGatewayConfig(patch = {}, opts = {}) {
  const configFile = paths.getGatewayConfigFile();
  if (configState.locked && !opts.force) {
    return {
      ok: false,
      locked: true,
      error: 'Configuration is locked due to unreadable or corrupted files'
    };
  }

  let existing = {};
  const probe = probeFile(configFile);
  if (probe.exists) {
    if (!probe.readable) {
      configState = {
        locked: true,
        reason: `${configFile} (${probe.code})`,
        files: [{ path: configFile, code: probe.code, error: probe.error }]
      };
      return { ok: false, locked: true, error: probe.error };
    }
    try {
      const parsed = JSON.parse(probe.content);
      if (isPlainObject(parsed)) {
        existing = parsed;
      } else {
        return { ok: false, locked: true, error: 'Existing config is not a JSON object' };
      }
    } catch (err) {
      return { ok: false, locked: true, error: 'Existing config JSON is corrupted: ' + err.message };
    }
  }

  const merged = {
    ...existing,
    ...patch,
    configVersion: 1,
    savedAt: new Date().toISOString()
  };

  if (isPlainObject(existing.desktop) && isPlainObject(patch.desktop)) {
    merged.desktop = {
      ...existing.desktop,
      ...patch.desktop
    };
  }

  try {
    writeFileAtomicSync(configFile, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
    return { ok: true, config: merged };
  } catch (err) {
    console.error('[gateway-config] 保存持久化配置失败:', err.message);
    return { ok: false, error: err.message };
  }
}

function persistDesktopConfig(patch = {}) {
  if (!isPlainObject(patch)) return null;
  const res = mergeSaveGatewayConfig({ desktop: patch });
  if (!res.ok) return null;
  console.log('[gateway-config] 已持久化桌面配置:', JSON.stringify(patch));
  return res.config;
}

function __resetConfigStateForTest() {
  configState = { locked: false, reason: null, files: [] };
}

module.exports = {
  loadGatewayConfig,
  getConfigState,
  mergeSaveGatewayConfig,
  saveGatewayConfig: mergeSaveGatewayConfig,
  persistDesktopConfig,
  probeFile,
  normalizePruneMode,
  normalizePruneExtra,
  normalizeRoutePath,
  __resetConfigStateForTest
};
