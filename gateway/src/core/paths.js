'use strict';

/**
 * Single source of truth for gateway filesystem paths.
 * Every getter dynamically reads process.env so tests that mutate env vars work cleanly.
 */

const path = require('path');

const LEGACY_ROOT_DSH_DIR = '/root/.dsh';
const LEGACY_ROOT_SNAPSHOTS_DIR = '/root/.dsh-snapshots';

function getDshHome() {
  return process.env.DSH_HOME || '/root';
}

function getDshDir() {
  if (process.env.DSH_DIR) return process.env.DSH_DIR;
  const home = getDshHome();
  return path.basename(home) === '.dsh' ? home : path.join(home, '.dsh');
}

function getSnapshotsDir() {
  return (
    process.env.DSH_SNAPSHOTS_DIR ||
    process.env.DSH_SNAPSHOT_DIR ||
    path.join(getDshHome(), '.dsh-snapshots')
  );
}

function getVersionsDir() {
  return process.env.DSH_VERSIONS_DIR || path.join(getSnapshotsDir(), 'versions');
}

function getGatewayConfigFile() {
  return process.env.GATEWAY_CONFIG_FILE || path.join(getDshDir(), 'gateway.config.json');
}

function getSessionSecretFile() {
  return process.env.SESSION_SECRET_FILE || path.join(getDshDir(), '.session_secret');
}

function getInternalTokenFile() {
  return (
    process.env.INTERNAL_TOKEN_FILE ||
    process.env.DSH_INTERNAL_TOKEN_FILE ||
    path.join(getDshDir(), '.internal-api-token')
  );
}

function getPluginsStateFile() {
  return path.join(getDshDir(), 'plugins-state.json');
}

function getDshWebLogFile() {
  return process.env.DSH_WEB_LOG || path.join(getDshDir(), 'logs', 'dsh-web.log');
}

function getWorkspaceDir() {
  return process.env.DSH_WORKSPACE || '/workspace';
}

module.exports = {
  getDshHome,
  getDshDir,
  getSnapshotsDir,
  getVersionsDir,
  getGatewayConfigFile,
  getSessionSecretFile,
  getInternalTokenFile,
  getPluginsStateFile,
  getDshWebLogFile,
  getWorkspaceDir,
  LEGACY_ROOT_DSH_DIR,
  LEGACY_ROOT_SNAPSHOTS_DIR
};
