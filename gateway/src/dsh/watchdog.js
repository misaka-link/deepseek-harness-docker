'use strict';

/**
 * DshCoreWatchdog —— DSH 核心「运行时卡死」健康看门狗。
 *
 * 周期性探活 DSH 核心 HTTP 端口；连续 N 次失败判定为事件循环卡死并触发受限滑动窗口重启；
 * 处于手动停止 / 未就绪 / 停止中 / 安装或还原中 / 进程已退出时自动跳过。
 */

function boolEnv(name, dflt) {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === '') return dflt;
  return !/^(0|false|off|no)$/i.test(String(v).trim());
}

function numEnv(name, dflt, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  let v = Number.isFinite(n) ? n : dflt;
  if (typeof min === 'number' && v < min) v = min;
  if (typeof max === 'number' && v > max) v = max;
  return v;
}

const DEFAULT_CONFIG = Object.freeze({
  enabled: boolEnv('DSH_WATCHDOG_ENABLED', true),
  intervalMs: numEnv('DSH_WATCHDOG_INTERVAL_MS', 15000, 2000, 3600000),
  probeTimeoutMs: numEnv('DSH_WATCHDOG_TIMEOUT_MS', 4000, 500, 60000),
  failThreshold: numEnv('DSH_WATCHDOG_FAIL_THRESHOLD', 3, 1, 100),
  maxRestarts: numEnv('DSH_WATCHDOG_MAX_RESTARTS', 3, 1, 100),
  restartWindowMs: numEnv('DSH_WATCHDOG_RESTART_WINDOW_MS', 30 * 60 * 1000, 60000, 24 * 3600 * 1000),
  probeHost: process.env.DSH_WATCHDOG_PROBE_HOST || '127.0.0.1',
  probePath: process.env.DSH_WATCHDOG_PROBE_PATH || '/'
});

class DshCoreWatchdog {
  constructor(options = {}) {
    this.dshManager = options.dshManager;
    if (!this.dshManager) throw new Error('[watchdog] 需要 dshManager');
    this.config = Object.assign({}, DEFAULT_CONFIG, options.config || {});
    this.port = Number(options.port || process.env.DSH_PORT || 3079);

    this.fetchImpl = options.fetch || ((...args) => fetch(...args));
    this.setIntervalFn = options.setInterval || setInterval;
    this.clearIntervalFn = options.clearInterval || clearInterval;
    this.now = options.now || (() => Date.now());
    this.logger = options.logger || console;

    this._timer = null;
    this._running = false;
    this._paused = false;
    this._pausedReason = '';
    this._probing = false;
    this._recovering = false;
    this._restartTimestamps = [];
    this._lastStartTime = 0;

    this.state = {
      probeCount: 0,
      lastProbeAt: 0,
      lastProbeStatus: null,
      lastProbeOkAt: 0,
      lastProbeLatencyMs: null,
      lastProbeHttpStatus: null,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      lastError: '',
      restartCountInWindow: 0,
      lastRestartAt: 0,
      lastRestartResult: null,
      recoverCount: 0,
      suspended: false,
      suspendedReason: ''
    };
  }

  start() {
    if (!this.config.enabled) {
      this.logger.log && this.logger.log('[watchdog] 已禁用（DSH_WATCHDOG_ENABLED=0）');
      return;
    }
    if (this._running) return;
    this._running = true;
    this.logger.log &&
      this.logger.log(
        '[watchdog] 启动：interval=' + this.config.intervalMs + 'ms timeout=' + this.config.probeTimeoutMs +
        'ms threshold=' + this.config.failThreshold + ' maxRestarts=' + this.config.maxRestarts +
        '/' + Math.round(this.config.restartWindowMs / 1000) + 's'
      );
    this._timer = this.setIntervalFn(() => {
      this.runOnce().catch((e) => this.logger.warn && this.logger.warn('[watchdog] tick 异常:', (e && e.message) || e));
    }, this.config.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) {
      try { this.clearIntervalFn(this._timer); } catch {}
      this._timer = null;
    }
    this._running = false;
  }

  pause(reason = '') { this._paused = true; this._pausedReason = reason || 'paused'; }
  resume() { this._paused = false; this._pausedReason = ''; }

  async runOnce() {
    if (!this._running || this._paused || this._probing || this._recovering) return null;

    let st;
    try { st = this.dshManager.getStatus ? this.dshManager.getStatus() : {}; } catch { st = {}; }

    const currentStartTime = Number(st.startTime) || 0;
    if (this._lastStartTime && currentStartTime && currentStartTime !== this._lastStartTime) {
      this.state.consecutiveFailures = 0;
      this.state.lastError = '';
    }
    if (currentStartTime) this._lastStartTime = currentStartTime;

    if (st.manualStopped) return this._skip('manualStopped');
    if (st.installing || this.dshManager.installing) return this._skip('installing');
    if (st.stopping || this.dshManager.stopping) return this._skip('stopping');
    if (!st.running) return this._skip('not-running');
    if (!st.ready) return this._skip('not-ready');

    this._probing = true;
    const url = 'http://' + this.config.probeHost + ':' + this.port + this.config.probePath;
    const t0 = this.now();
    try {
      const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
        ? AbortSignal.timeout(this.config.probeTimeoutMs)
        : undefined;
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Host: this.config.probeHost + ':' + this.port },
        redirect: 'manual',
        signal
      });
      const latency = this.now() - t0;
      this._recordSuccess(latency, res && res.status);
      try { if (res && res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
      return true;
    } catch (e) {
      const latency = this.now() - t0;
      this._recordFailure(e, latency);
      return false;
    } finally {
      this._probing = false;
    }
  }

  _skip(reason) {
    this.state.lastProbeStatus = 'skip';
    this.state.lastSkipReason = reason;
    this.state.consecutiveFailures = 0;
    this.state.lastError = '';
    return null;
  }

  _recordSuccess(latency, httpStatus) {
    const now = this.now();
    this.state.probeCount++;
    this.state.lastProbeAt = now;
    this.state.lastProbeStatus = 'ok';
    this.state.lastProbeOkAt = now;
    this.state.lastProbeLatencyMs = latency;
    this.state.lastProbeHttpStatus = typeof httpStatus === 'number' ? httpStatus : null;
    if (this.state.consecutiveFailures > 0) {
      this.logger.log && this.logger.log('[watchdog] 探活已恢复（此前连续失败 ' + this.state.consecutiveFailures + ' 次）');
    }
    this.state.consecutiveFailures = 0;
    this.state.lastError = '';
    if (this.state.suspended) {
      this.state.suspended = false;
      this.state.suspendedReason = '';
      this._restartTimestamps = [];
      this.state.restartCountInWindow = 0;
    }
  }

  _recordFailure(err, latency) {
    const now = this.now();
    this.state.probeCount++;
    this.state.lastProbeAt = now;
    this.state.lastProbeStatus = 'fail';
    this.state.lastProbeLatencyMs = latency;
    this.state.consecutiveFailures++;
    this.state.lastFailureAt = now;
    const name = err && err.name ? err.name + ': ' : '';
    this.state.lastError = name + ((err && err.message) || String(err) || 'probe_failed');
    this.logger.warn &&
      this.logger.warn('[watchdog] 核心探活失败 (' + this.state.consecutiveFailures + '/' + this.config.failThreshold + '): ' + this.state.lastError);

    if (this.state.consecutiveFailures >= this.config.failThreshold && !this._recovering && !this.state.suspended) {
      this._triggerRecovery(this.state.lastError).catch((e) => {
        this.logger.error && this.logger.error('[watchdog] recovery 异常:', (e && e.message) || e);
      });
    }
  }

  async _triggerRecovery(reason) {
    if (this._recovering) return;

    let st = {};
    try { st = this.dshManager.getStatus ? this.dshManager.getStatus() : {}; } catch {}
    if (
      this.dshManager.manualStopped || st.manualStopped ||
      this.dshManager.installing || st.installing ||
      this.dshManager.stopping || st.stopping ||
      !st.running || !st.ready
    ) {
      this.logger.log && this.logger.log('[watchdog] 取消自动恢复：核心处于生命周期操作或未运行状态（' + (reason || '') + '）');
      return;
    }

    const now = this.now();
    this._restartTimestamps = this._restartTimestamps.filter((t) => now - t < this.config.restartWindowMs);
    if (this._restartTimestamps.length >= this.config.maxRestarts) {
      if (!this.state.suspended) {
        this.state.suspended = true;
        this.state.suspendedReason =
          '窗口(' + Math.round(this.config.restartWindowMs / 1000) + 's)内已自动重启 ' + this._restartTimestamps.length +
          ' 次，暂停自动恢复以保护系统；请检查插件/配置或手动重启。';
        this.logger.error && this.logger.error('[watchdog] ' + this.state.suspendedReason);
      }
      return;
    }

    this._recovering = true;
    try {
      this._restartTimestamps.push(now);
      this.state.restartCountInWindow = this._restartTimestamps.length;
      this.state.lastRestartAt = now;
      this.logger.warn &&
        this.logger.warn(
          '[watchdog] 检测到 DSH 核心连续 ' + this.state.consecutiveFailures + ' 次探活失败（' + reason +
          '），自动重启核心（窗口内第 ' + this._restartTimestamps.length + '/' + this.config.maxRestarts + ' 次）...'
        );
      const r = await this.dshManager.restart();
      const ok = !!(r && r.ok);
      this.state.lastRestartResult = ok ? 'ok' : ((r && r.error) || 'unknown');
      if (ok) {
        this.state.consecutiveFailures = 0;
        this.state.recoverCount++;
        this.state.lastProbeStatus = 'restart-ok';
        this.logger.log && this.logger.log('[watchdog] 核心已自动重启并恢复');
      } else {
        this.logger.error && this.logger.error('[watchdog] 自动重启失败: ' + this.state.lastRestartResult);
      }
    } catch (e) {
      this.state.lastRestartResult = (e && e.message) || String(e);
      this.logger.error && this.logger.error('[watchdog] 自动重启异常: ' + this.state.lastRestartResult);
    } finally {
      this._recovering = false;
    }
  }

  getStatus() {
    const now = this.now();
    const activeRestarts = this._restartTimestamps.filter((t) => now >= t && now - t < this.config.restartWindowMs).length;
    return Object.assign({
      enabled: this.config.enabled,
      running: this._running,
      paused: this._paused,
      pausedReason: this._pausedReason,
      recovering: this._recovering,
      port: this.port,
      intervalMs: this.config.intervalMs,
      probeTimeoutMs: this.config.probeTimeoutMs,
      failThreshold: this.config.failThreshold,
      maxRestarts: this.config.maxRestarts,
      restartWindowMs: this.config.restartWindowMs
    }, this.state, { restartCountInWindow: activeRestarts });
  }
}

module.exports = { DshCoreWatchdog, DEFAULT_CONFIG };
