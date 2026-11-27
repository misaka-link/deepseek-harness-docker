'use strict';
/**
 * gateway/src/dsh/index.js — DshManager 门面模块（v1.0.0）。
 *
 * 完整保留供路由、看门狗与快照服务使用的全部属性与方法，
 * 并新增在线切换 npm/pnpm 镜像源 (setNpmRegistry / getNpmRegistry)、
 * 上游 Cookie 失效 (invalidateUpstreamCookie) 与引擎下限硬校验。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const paths = require('../core/paths');
const { compareSemver } = require('../core/semver');
const { isValidVersion } = require('./dsh-version');
const versionService = require('./version-service');
const { getEffectiveCompat } = require('./compat-policy');
const {
  FALLBACK_DSH_VERSION,
  GC_KEEP_DEFAULT,
  getLiveCoreDir,
  getRollbackPreservedDir,
  isReadyVersionDir,
  isMountedPath,
  listStoreEntries,
  formatBytes,
  cleanupStagingOrphans,
  deleteCachedVersion: deleteCachedVersionImpl
} = require('./version-store');
const {
  getRollbackPoint: getRollbackPointImpl,
  deleteRollbackPoint: deleteRollbackPointImpl
} = require('./rollback-slot');
const { detectCrashingPlugin } = require('./crash-detector');
const {
  bootProcess,
  stopProcess,
  waitReady,
  exchangeSessionCookie
} = require('./supervisor');
const {
  installVersion: installVersionImpl,
  restoreRollbackPoint: restoreRollbackPointImpl
} = require('./installer');

class DshManager {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.installing = false;
    this.stopping = false;
    this.installLog = [];
    this.registry = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
    this.launchToken = '';
    this.upstreamCookie = '';
    this.lastGcAt = 0;
    this.restartTimer = null;
    this.lastCrashTime = 0;
    this.manualStopped = false;
    this.startTime = 0;
    this.recentLogs = [];
    this.lastExitInfo = null;
    this.lastKnownVersion = '';
    this.autoHealEnabled = true;
    this.maxAutoHealPerBoot = 5;
    this.autoHealCountInCurrentBoot = 0;
    this.autoIsolatedEvents = [];
    this.lastNeedleScan = null;
    this._opChain = Promise.resolve();
    this.crashWindow = [];

    try { fs.mkdirSync(paths.getSnapshotsDir(), { recursive: true }); } catch {}
    try { fs.mkdirSync(paths.getWorkspaceDir(), { recursive: true }); } catch {}
    try { fs.mkdirSync(paths.getVersionsDir(), { recursive: true }); } catch (e) {
      console.warn(`[dsh-manager] 版本库目录不可用 (${paths.getVersionsDir()}): ${e.message}`);
    }
  }

  get versionsCacheDir() {
    return paths.getVersionsDir();
  }

  get rollbackPreservedDir() {
    return getRollbackPreservedDir();
  }

  _enqueue(task) {
    const run = this._opChain.then(task, task);
    let timer = null;
    const guarded = Promise.race([
      run,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn('[dsh-manager] 生命周期操作超过 180s 未返回，放行后续操作');
          resolve({ ok: false, errorCode: 'OPERATION_TIMEOUT', error: 'operation_timeout' });
        }, 180000);
        if (timer.unref) timer.unref();
      })
    ]);
    const clear = () => { if (timer) clearTimeout(timer); };
    guarded.then(clear, clear);
    this._opChain = guarded.then(() => {}, () => {});
    return guarded;
  }

  setManualStopped(flag) {
    this.manualStopped = Boolean(flag);
  }

  setAutoHeal(enabled, maxPerBoot = 5) {
    this.autoHealEnabled = enabled !== false;
    this.maxAutoHealPerBoot = Math.max(1, Math.min(50, Number(maxPerBoot) || 5));
    console.log(`[dsh-manager] 启动崩溃自愈策略已更新: ${this.autoHealEnabled ? '已开启' : '已关闭'} (单周期上限: ${this.maxAutoHealPerBoot})`);
  }

  getAutoIsolatedEvents() {
    return this.autoIsolatedEvents || [];
  }

  clearAutoIsolatedEvents() {
    this.autoIsolatedEvents = [];
  }

  detectCrashingPlugin(recentLogs = []) {
    return detectCrashingPlugin(recentLogs, this.lastExitInfo);
  }

  getNpmRegistry() {
    return this.registry;
  }

  /**
   * 在线切换 npm / pnpm 镜像源（校验 http(s) URL，并尽力同步到 npm/pnpm 配置）。
   * @param {string} registryUrl
   * @returns {string}
   */
  setNpmRegistry(registryUrl) {
    const raw = String(registryUrl || '').trim();
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      const err = new Error(`无效的镜像源地址: ${raw.slice(0, 120)}`);
      err.errorCode = 'REQ_FIELD_INVALID';
      err.params = { field: 'registry' };
      throw err;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      const err = new Error(`镜像源仅支持 http/https 协议: ${parsed.protocol}`);
      err.errorCode = 'REQ_FIELD_INVALID';
      err.params = { field: 'registry' };
      throw err;
    }
    const normalized = raw.replace(/\/+$/, '');
    this.registry = normalized;

    // 尽力同步到容器内 npm / pnpm 配置（失败不阻断；测试环境可通过 DSH_SKIP_PM_CONFIG_SYNC=1 跳过）
    if (process.env.DSH_SKIP_PM_CONFIG_SYNC !== '1') {
      try { spawnSync('npm', ['config', 'set', 'registry', normalized], { stdio: 'ignore', timeout: 5000 }); } catch {}
      try { spawnSync('pnpm', ['config', 'set', 'registry', normalized], { stdio: 'ignore', timeout: 5000 }); } catch {}
    }

    console.log(`[dsh-manager] 已切换 npm/pnpm 镜像源: ${normalized}`);
    return this.registry;
  }

  /** 向后兼容别名 */
  setRegistry(reg) {
    if (reg && String(reg).trim()) {
      return this.setNpmRegistry(reg);
    }
    return this.registry;
  }

  getStatus() {
    const running = !!this.proc && this.proc.exitCode === null && !this.proc.killed;
    const currentVer = this.getCurrentVersion();
    return {
      version: currentVer,
      running,
      ready: this.ready,
      installing: this.installing,
      stopping: this.stopping,
      manualStopped: !!this.manualStopped,
      pid: running && this.proc ? this.proc.pid : null,
      startTime: this.startTime,
      npmRegistry: this.getNpmRegistry(),
      cachedVersions: this.getCachedVersions(),
      lastExitInfo: this.lastExitInfo,
      recentLogs: this.getRecentLogs(30),
      autoHealEnabled: this.autoHealEnabled,
      autoHealMaxPerBoot: this.maxAutoHealPerBoot,
      autoHealCountInCurrentBoot: this.autoHealCountInCurrentBoot,
      autoIsolatedEvents: this.autoIsolatedEvents,
      needleResidue: this.lastNeedleScan ? this.lastNeedleScan.needleResidue : null
    };
  }

  getRecentLogs(count = 150) {
    if (this.recentLogs && this.recentLogs.length > 0) {
      return this.recentLogs.slice(-count);
    }
    const webLog = paths.getDshWebLogFile();
    try {
      if (fs.existsSync(webLog)) {
        const content = fs.readFileSync(webLog, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        return lines.slice(-count);
      }
    } catch {}
    return [];
  }

  getCachedVersions() {
    const dir = paths.getVersionsDir();
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((name) => {
        if (name.startsWith('.')) return false;
        return isReadyVersionDir(path.join(dir, name));
      });
    } catch {
      return [];
    }
  }

  getAdaptedVersions(meta = null) {
    if (process.env.ADAPTED_DSH_VERSIONS) {
      return process.env.ADAPTED_DSH_VERSIONS.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const liveMeta = meta || versionService.getLiveMeta();
    return getEffectiveCompat(liveMeta).adaptedVersions;
  }

  isAdaptedVersion(ver, meta = null) {
    return this.getAdaptedVersions(meta).includes(ver);
  }

  getCurrentVersion() {
    if (this.lastKnownVersion) {
      return this.lastKnownVersion;
    }

    const candidates = [
      path.join(getLiveCoreDir(), 'package.json'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json'
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
          if (v) {
            this.lastKnownVersion = v;
            return v;
          }
        }
      } catch {}
    }

    try {
      const res = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (res.status === 0 && res.stdout && res.stdout.trim()) {
        const v = res.stdout.trim();
        this.lastKnownVersion = v;
        return v;
      }
    } catch {}

    return this.lastKnownVersion || FALLBACK_DSH_VERSION;
  }

  async fetchAvailableVersions(force = false, meta = null) {
    let distTags = {};
    let versions = [];

    try {
      const regUrl = this.registry.replace(/\/+$/, '') + '/@deepseek-ai/dsh';
      const resp = await fetch(regUrl, { signal: AbortSignal.timeout(6000) });
      if (resp.ok) {
        const pkgData = await resp.json();
        distTags = pkgData['dist-tags'] || {};
        versions = Object.keys(pkgData.versions || {});
      }
    } catch {
      const runNpmAsync = (args) => new Promise((resolve) => {
        const child = spawn('npm', [...args, '--cache=/tmp/.npm-cache'], {
          env: { ...process.env, NPM_CONFIG_REGISTRY: this.registry }
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('close', (code) => {
          if (code === 0 && out.trim()) {
            try { resolve(JSON.parse(out.trim())); } catch { resolve(null); }
          } else {
            resolve(null);
          }
        });
        child.on('error', () => resolve(null));
      });
      distTags = (await runNpmAsync(['view', '@deepseek-ai/dsh', 'dist-tags', '--json'])) || {};
      versions = (await runNpmAsync(['view', '@deepseek-ai/dsh', 'versions', '--json'])) || [];
    }

    const current = this.getCurrentVersion();
    let latest = distTags.alpha || distTags.next || distTags.latest;
    if (Array.isArray(versions) && versions.length > 0) {
      const sorted = [...versions].sort(compareSemver);
      const newestInList = sorted[sorted.length - 1];
      if (!latest || (newestInList && compareSemver(newestInList, latest) > 0)) {
        latest = newestInList;
      }
    }
    if (!latest) latest = FALLBACK_DSH_VERSION;
    const isUpToDate = Boolean(current && latest && compareSemver(current, latest) >= 0);

    return {
      current,
      latest,
      isUpToDate,
      distTags,
      cachedVersions: this.getCachedVersions(),
      adaptedVersions: this.getAdaptedVersions(meta),
      versions: Array.isArray(versions) ? versions.reverse() : [],
      registry: this.registry
    };
  }

  boot(onProbe) {
    return this._enqueue(() => bootProcess(this, onProbe));
  }

  stop() {
    return this._enqueue(() => stopProcess(this));
  }

  async restart(onProbe) {
    return this._enqueue(async () => {
      await stopProcess(this);
      return bootProcess(this, onProbe);
    });
  }

  waitReady(timeoutMs = 60000, onProbeProgress) {
    return waitReady(this, timeoutMs, onProbeProgress);
  }

  exchangeSessionCookie(token = this.launchToken) {
    return exchangeSessionCookie(this, token);
  }

  async ensureValidUpstreamCookie() {
    if (this.upstreamCookie) return this.upstreamCookie;
    return this.exchangeSessionCookie();
  }

  invalidateUpstreamCookie() {
    this.upstreamCookie = '';
  }

  isValidVersion(value) {
    return isValidVersion(value);
  }

  installVersion(version, onProgress, onLog, options = {}) {
    return installVersionImpl(this, version, onProgress, onLog, options);
  }

  getVersionsStoreStats() {
    const versionsDir = paths.getVersionsDir();
    const activeVersion = this.getCurrentVersion();
    const pinnedVersion = FALLBACK_DSH_VERSION;
    let freeBytes = null;
    let totalBytes = null;
    try {
      const st = fs.statfsSync(versionsDir);
      freeBytes = st.bavail * st.bsize;
      totalBytes = st.blocks * st.bsize;
    } catch {}
    const versions = listStoreEntries(versionsDir).map((e) => {
      const compat = versionService.evaluateTargetVersion(e.version);
      return {
        version: e.version,
        ready: e.ready,
        supported: compat.level !== 'danger',
        compatLevel: compat.level,
        compatKind: compat.kind,
        sizeBytes: e.sizeBytes,
        sizeFormatted: formatBytes(e.sizeBytes),
        lastUsedAt: new Date(e.mtimeMs).toISOString(),
        active: e.version === activeVersion,
        pinned: e.version === pinnedVersion,
        imageRevision: (e.marker && e.marker.imageRevision) || null
      };
    }).sort((a, b) => (a.version < b.version ? 1 : -1));

    return {
      ok: true,
      dir: versionsDir,
      persisted: isMountedPath(versionsDir),
      freeBytes,
      totalBytes,
      keepN: GC_KEEP_DEFAULT,
      activeVersion,
      pinnedVersion,
      totalSizeBytes: versions.reduce((s, v) => s + (v.sizeBytes || 0), 0),
      versions
    };
  }

  gcVersions({ keepN = GC_KEEP_DEFAULT, dryRun = false, activeVersion = null } = {}) {
    if (this.installing) {
      return { ok: false, errorCode: 'DSH_BUSY_INSTALLING', error: '版本切换进行中，已拒绝并发清理' };
    }
    const versionsDir = paths.getVersionsDir();
    const entries = listStoreEntries(versionsDir).filter((e) => e.ready);
    const keep = new Set();
    const n = Math.max(1, Number(keepN) || GC_KEEP_DEFAULT);
    for (const e of [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, n)) keep.add(e.version);
    for (const v of [activeVersion || this.getCurrentVersion(), FALLBACK_DSH_VERSION]) {
      if (v) keep.add(v);
    }
    const removed = [];
    for (const e of entries) {
      if (keep.has(e.version)) continue;
      if (dryRun) { removed.push({ version: e.version, bytes: e.sizeBytes, dryRun: true }); continue; }
      try {
        fs.rmSync(e.dir, { recursive: true, force: true });
        removed.push({ version: e.version, bytes: e.sizeBytes });
      } catch (err) {
        console.warn(`[dsh-manager] 版本库清理失败 ${e.version}: ${err.message}`);
      }
    }
    if (!dryRun) cleanupStagingOrphans(versionsDir);
    this.lastGcAt = Date.now();
    return {
      ok: true,
      dir: versionsDir,
      kept: [...keep],
      removed,
      freedBytes: removed.reduce((s, r) => s + (r.bytes || 0), 0),
      dryRun
    };
  }

  cleanupStagingOrphans(maxAgeMs = 3600 * 1000) {
    return cleanupStagingOrphans(paths.getVersionsDir(), maxAgeMs);
  }

  deleteCachedVersion(version) {
    return deleteCachedVersionImpl({
      versionsDir: paths.getVersionsDir(),
      version,
      activeVersion: this.getCurrentVersion(),
      installing: this.installing
    });
  }

  getRollbackPoint() {
    return getRollbackPointImpl(this.installing);
  }

  deleteRollbackPoint() {
    return deleteRollbackPointImpl(this.installing);
  }

  restoreRollbackPoint(onProgress = () => {}, onLog = () => {}) {
    return restoreRollbackPointImpl(this, onProgress, onLog);
  }

  // === 快照委托（懒加载避免循环依赖） ===
  _backupService() {
    return require('../backup');
  }

  ensureDefaultSnapshot() {
    const snapshotsDir = paths.getSnapshotsDir();
    const defaultMarker = path.join(snapshotsDir, '.default_snapshot_created');
    if (fs.existsSync(defaultMarker)) {
      return { ok: true, alreadyExists: true };
    }

    const backupService = this._backupService();
    const existing = backupService.listBackups().snapshots || [];
    const hasDefault = existing.some((s) => s.filename.includes('default') || s.filename.includes('initial'));
    if (hasDefault) {
      try { fs.writeFileSync(defaultMarker, new Date().toISOString()); } catch {}
      return { ok: true, alreadyExists: true };
    }

    console.log('[dsh-manager] 首次启动：异步创建初始默认配置快照...');
    backupService.createBackup('default-initial')
      .then((res) => {
        try { fs.writeFileSync(defaultMarker, new Date().toISOString()); } catch {}
        console.log(`[dsh-manager] 默认初始配置快照创建成功: ${res.snapshot.filename}`);
      })
      .catch((err) => {
        console.warn('[dsh-manager] 创建初始快照跳过:', err.message);
      });

    return { ok: true, pending: true };
  }

  createSnapshot(name = '') {
    return this._backupService().createBackup(name);
  }

  listSnapshots() {
    return this._backupService().listBackups();
  }

  restoreSnapshot(filename, opts) {
    return this._backupService().restoreBackup(filename, this, opts);
  }

  deleteSnapshot(filename) {
    return this._backupService().deleteBackup(filename);
  }

  getSnapshotPath(filename) {
    return this._backupService().getBackupPath(filename);
  }
}

const instance = new DshManager();
instance.DshManager = DshManager;
module.exports = instance;
