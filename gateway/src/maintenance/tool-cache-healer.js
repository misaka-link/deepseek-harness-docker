'use strict';
/**
 * tool-cache-healer.js — 工具缓存（npx / pnpm dlx）运行期周期自愈调度器。
 */

const path = require('node:path');
const npxCache = require('./npx-cache');
const pnpmDlxCache = require('./pnpm-dlx-cache');
const installedTree = require('./installed-tree');

const { healNpxCache, getNpxCacheStatus, invalidateStatusCache } = npxCache;
const { healPnpmDlxCache, resolvePnpmCacheDir } = pnpmDlxCache;

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_QUIET_MS = 120 * 1000;
const FIRST_RUN_DELAY_MS = 20 * 1000;

class ToolCacheHealer {
  constructor(options = {}) {
    this.intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;
    this.quietMs = Number.isFinite(options.quietMs) ? options.quietMs : DEFAULT_QUIET_MS;
    this.logger = options.logger || console;
    this.enabled = options.enabled !== false;
    this.timer = null;
    this.firstTimer = null;
    this.lastRunAt = 0;
    this.totalRepaired = 0;
    this.totalRemoved = 0;
    this.lastResult = null;
    this.lastError = null;
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      this.runOnce();
    }, FIRST_RUN_DELAY_MS);
    if (this.firstTimer.unref) this.firstTimer.unref();

    this.timer = setInterval(() => this.runOnce(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.firstTimer) { clearTimeout(this.firstTimer); this.firstTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  runOnce(opts = {}) {
    const quietMs = Number.isFinite(opts.quietMs) ? opts.quietMs : this.quietMs;
    try {
      const res = healNpxCache({ quietMs, dryRun: Boolean(opts.dryRun) });
      let dlx = null;
      try {
        dlx = healPnpmDlxCache({ quietMs, dryRun: Boolean(opts.dryRun) });
      } catch (e) {
        this.logger.warn('[tool-cache] pnpm dlx 缓存自愈异常（已忽略）:', (e && e.message) || e);
      }
      this.lastRunAt = Date.now();
      this.lastResult = { npx: res, pnpmDlx: dlx };
      this.lastError = null;
      this.totalRepaired += res.repaired + (dlx ? dlx.repaired : 0);
      this.totalRemoved += res.removed + (dlx ? dlx.removed : 0);
      if (dlx && (dlx.repaired > 0 || dlx.removed > 0 || dlx.errors > 0)) {
        this.logger.log('[tool-cache] pnpm dlx 缓存自愈：修复 ' + dlx.repaired + ' 个、清理 ' + dlx.removed + ' 个');
        invalidateStatusCache();
      }
      if (res.repaired > 0 || res.removed > 0 || res.errors > 0) {
        const detail = res.actions
          .filter((a) => a.action === 'repaired' || a.action === 'error')
          .map((a) => {
            const base = path.basename(a.dir);
            if (a.action === 'repaired') {
              return base + '←' + (a.packages || []).map((p) => p.name + '@' + p.version).join(',');
            }
            return base + '←失败:' + a.reason;
          })
          .join(' | ');
        this.logger.log(
          `[tool-cache] npx 缓存自愈：修复 ${res.repaired} 个、清理 ${res.removed} 个` +
          (detail ? '（' + detail + '）' : '')
        );
      }
      return res;
    } catch (e) {
      this.lastError = (e && e.message) || String(e);
      this.logger.warn('[tool-cache] npx 缓存自愈异常（已忽略）:', this.lastError);
      return null;
    }
  }

  getStatus() {
    let status = null;
    try {
      status = getNpxCacheStatus();
    } catch (e) {
      status = { error: (e && e.message) || String(e) };
    }
    return {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      quietMs: this.quietMs,
      running: Boolean(this.timer),
      lastRunAt: this.lastRunAt,
      totalRepaired: this.totalRepaired,
      totalRemoved: this.totalRemoved,
      lastError: this.lastError,
      npxCache: status,
      pnpmDlx: (() => {
        try {
          const r = healPnpmDlxCache({ cacheDir: resolvePnpmCacheDir(), dryRun: true, quietMs: 0 });
          return { cacheDir: r.cacheDir, dirs: r.scanned, healthy: r.healthy, broken: r.repaired };
        } catch (e) {
          return { error: (e && e.message) || String(e) };
        }
      })()
    };
  }
}

module.exports = {
  ToolCacheHealer,
  DEFAULT_INTERVAL_MS,
  DEFAULT_QUIET_MS,
  npxCache,
  pnpmDlxCache,
  installedTree
};
