'use strict';
/**
 * gateway/src/backup/index.js — 快照与备份服务门面（100% 向后兼容所有历史快照）。
 */

const paths = require('../core/paths');
const archiveValidate = require('./archive-validate');
const legacyLinks = require('./legacy-links');
const createJob = require('./create-job');
const restore = require('./restore');
const inspect = require('./inspect');
const snapshotManifest = require('./snapshot-manifest');
const { isBusy, getActiveTask } = require('./state');

const backupService = {
  // 核心服务方法
  createBackup: createJob.createBackup,
  startBackupJob: createJob.startBackupJob,
  getBackupJob: createJob.getBackupJob,
  restoreBackup: restore.restoreBackup,
  importBackupStream: inspect.importBackupStream,
  listBackups: inspect.listBackups,
  inspectSnapshot: inspect.inspectSnapshot,
  deleteBackup: inspect.deleteBackup,
  getBackupPath: inspect.getBackupPath,
  getActiveTask,
  isBusy,

  // MUST-KEEP 校验、修复与扫描函数（供单测与工具直接复用）
  validateArchiveMembers: archiveValidate.validateArchiveMembers,
  classifyArchiveMemberLine: archiveValidate.classifyArchiveMemberLine,
  splitLinkMember: archiveValidate.splitLinkMember,
  assertSafeMemberPath: archiveValidate.assertSafeMemberPath,
  isAllowedAbsoluteLinkTarget: archiveValidate.isAllowedAbsoluteLinkTarget,
  isAllowedSymlinkTarget: archiveValidate.isAllowedSymlinkTarget,
  verifyGzipMagic: archiveValidate.verifyGzipMagic,
  hasPigz: archiveValidate.hasPigz,
  getPigzThreads: archiveValidate.getPigzThreads,
  buildTarEnv: archiveValidate.buildTarEnv,
  runTarAsync: archiveValidate.runTarAsync,
  repairEscapingRelativeLinks: legacyLinks.repairEscapingRelativeLinks,
  relocateLegacyRootTarget: legacyLinks.relocateLegacyRootTarget,
  scanArchiveContents: inspect.scanArchiveContents,
  countCurrentSessions: inspect.countCurrentSessions,
  DATA_ENTRIES: archiveValidate.DATA_ENTRIES,
  ALLOWED_LINK_PREFIXES: archiveValidate.ALLOWED_LINK_PREFIXES,
  LINK_SEPARATORS: archiveValidate.LINK_SEPARATORS,
  snapshotManifest,

  get SNAPSHOTS_DIR() {
    return paths.getSnapshotsDir();
  }
};

module.exports = backupService;
