/**
 * 工具缓存自愈调度器（Issue #18）。
 *
 * 为什么需要「运行期」自愈，而不只是启动时修一次：
 *   npx 的缓存是在容器**运行过程中**被写坏的（DSH 启动 MCP 时调用 npx，慢网下被超时打断）。
 *   如果只在启动时修，那么本次运行期间坏掉的缓存会一直坏到用户重启容器为止 ——
 *   这正是 Issue #18 里「坏了一个月」的直接原因（DSH 每 32s 重试，每次都撞同一堵墙）。
 *
 * 安全边界：
 *   · 只在缓存目录静默一段时间（默认 120s）后才动手，避免打断正在进行的下载；
 *   · 存在新鲜 concurrency.lock 时一律跳过（见 gateway/npx-cache.js）；
 *   · 任何异常都不抛出、不影响网关主流程；
 *   · 无修复时保持完全静默，避免刷日志。
 *
 * @module tool-cache-healer
 */

const { healNpxCache, getNpxCacheStatus, invalidateStatusCache } = require('./npx-cache');
// Issue #18 同款：pnpm dlx（pnpx/pnx）同样是「装完才写清单」，实测缺清单后报
// ERR_PNPM_CLI_DLX_READ_MANIFEST 且不自愈，故一并纳入同一调度器。
const { healPnpmDlxCache } = require('./pnpm-dlx-cache');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_QUIET_MS = 120 * 1000;
/** 首次执行稍作延迟，避开启动高峰（DSH 启动、插件安装都在抢 IO） */
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

  /**
   * 执行一次自愈。
   * @param {{quietMs?: number, dryRun?: boolean}} [opts]
   */
  runOnce(opts = {}) {
    const quietMs = Number.isFinite(opts.quietMs) ? opts.quietMs : this.quietMs;
    try {
      const res = healNpxCache({ quietMs, dryRun: Boolean(opts.dryRun) });
      // 同一轮里顺带自愈 pnpm dlx 缓存（两类缓存互不影响，任一失败不阻断另一类）
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
        this.logger.log(
          '[tool-cache] pnpm dlx 缓存自愈：修复 ' + dlx.repaired + ' 个、清理 ' + dlx.removed + ' 个'
        );
        invalidateStatusCache();
      }
      if (res.repaired > 0 || res.removed > 0 || res.errors > 0) {
        const detail = res.actions
          .filter((a) => a.action === 'repaired' || a.action === 'error')
          .map((a) => {
            const base = require('path').basename(a.dir);
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
      this.logger.warn('[tool-cache] npx 缓存自愈异常（已忽略，不影响主流程）:', this.lastError);
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
          const { resolvePnpmCacheDir } = require('./pnpm-dlx-cache');
          const r = healPnpmDlxCache({ cacheDir: resolvePnpmCacheDir(), dryRun: true, quietMs: 0 });
          return { cacheDir: r.cacheDir, dirs: r.scanned, healthy: r.healthy, broken: r.repaired };
        } catch (e) {
          return { error: (e && e.message) || String(e) };
        }
      })()
    };
  }
}

module.exports = { ToolCacheHealer, DEFAULT_INTERVAL_MS, DEFAULT_QUIET_MS };
