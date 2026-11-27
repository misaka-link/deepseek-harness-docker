'use strict';
/**
 * desktop-manager.js — 容器 Xvfb / Openbox / x11vnc / noVNC / Chromium 桌面生命周期管理器。
 *
 * 语言同步统一经由 ../prefs/dsh-prefs 的 resolveDesktopLang() / mapLocale() 读取。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const paths = require('../core/paths');
const { resolveDesktopLang, mapLocale } = require('../prefs/dsh-prefs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DesktopManager {
  constructor() {
    this.running = false;
    this.unhealthy = false;
    this.startedAt = null;
    this.expiresAt = null;
    this.lastActivity = Date.now();
    this.processes = {
      xvfb: null,
      openbox: null,
      x11vnc: null,
      websockify: null,
      chromium: null
    };

    const defaultChromeDir = path.join(paths.getDshHome(), '.config', 'chromium');
    this.config = {
      display: process.env.DISPLAY || ':99',
      enabled: process.env.DSH_DESKTOP_ENABLED !== '0',
      width: Number(process.env.DSH_DESKTOP_WIDTH) || 1920,
      height: Number(process.env.DSH_DESKTOP_HEIGHT) || 1080,
      depth: Number(process.env.DSH_DESKTOP_DEPTH) || 24,
      idleTimeoutMinutes: Number(process.env.DSH_IDLE_TIMEOUT_MINUTES) || 30,
      enableCdp: process.env.DSH_ENABLE_CDP !== '0',
      cdpPort: Number(process.env.DSH_CDP_PORT) || 9222,
      enableSidebarTab: process.env.DSH_ENABLE_SIDEBAR_TAB === '1' || false,
      screenshotQuality: process.env.DSH_SCREENSHOT_QUALITY || 'high',
      screenshotDir: process.env.DSH_SCREENSHOT_DIR || '',
      userDataDir: process.env.CHROME_USER_DATA_DIR || defaultChromeDir,
      lang: '',
      logsDir: '/tmp/dsh-desktop'
    };

    try { fs.mkdirSync(this.config.logsDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(this.config.userDataDir, { recursive: true }); } catch {}

    this.watchdogTimer = setInterval(() => this.checkIdleWatchdog(), 15000);
    this.watchdogTimer.unref();
    this._opChain = Promise.resolve();
  }

  touchActivity(durationMinutes) {
    this.lastActivity = Date.now();
    if (typeof durationMinutes === 'number' && durationMinutes > 0) {
      this.expiresAt = Date.now() + durationMinutes * 60 * 1000;
      console.log(`[desktop-manager] 浏览器工作时长设置为 ${durationMinutes} 分钟，预计到期: ${new Date(this.expiresAt).toLocaleTimeString()}`);
    } else if (durationMinutes === 0) {
      this.expiresAt = null;
      console.log('[desktop-manager] 已取消浏览器工作时长限制');
    }
  }

  checkIdleWatchdog() {
    if (!this.running) return;
    if (!this._langSyncInFlight) {
      const desired = resolveDesktopLang();
      if (desired && desired !== this.config.lang) {
        this._langSyncInFlight = true;
        console.log(`[desktop-manager] 检测到 DSH 语言变化 (${this.config.lang || 'unset'} -> ${desired})，重启桌面以同步 UI 语言...`);
        const remainingMs = this.expiresAt ? this.expiresAt - Date.now() : 0;
        const durationMinutes = remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 60000)) : undefined;
        this.restart({ lang: desired, durationMinutes })
          .catch((e) => console.warn('[desktop-manager] 语言同步重启失败:', e.message))
          .finally(() => { this._langSyncInFlight = false; });
        return;
      }
    }

    const now = Date.now();
    if (this.expiresAt && now >= this.expiresAt) {
      console.log('[desktop-manager] 浏览器工作时长已到期，自动停止以节约资源');
      this.stop().catch((e) => console.warn('[desktop-manager] 到期自动停止失败:', e.message));
      return;
    }

    if (this.config.idleTimeoutMinutes > 0) {
      const idleMs = now - this.lastActivity;
      if (idleMs >= this.config.idleTimeoutMinutes * 60 * 1000) {
        console.log(`[desktop-manager] 浏览器已空闲超过 ${this.config.idleTimeoutMinutes} 分钟，自动休眠`);
        this.stop().catch((e) => console.warn('[desktop-manager] 空闲自动休眠失败:', e.message));
      }
    }
  }

  _enqueue(task) {
    const run = this._opChain.then(task, task);
    this._opChain = run.then(() => {}, () => {});
    return run;
  }

  start(options = {}) {
    return this._enqueue(() => this._startInternal(options));
  }

  stop() {
    return this._enqueue(() => this._stopInternal());
  }

  restart(options = {}) {
    return this._enqueue(async () => {
      await this._stopInternal();
      await sleep(300);
      return this._startInternal(options);
    });
  }

  async _startInternal(options = {}) {
    if (this.config.enabled === false) {
      console.log('[desktop-manager] 容器浏览器已被管理后台彻底停用，拒绝启动请求');
      return {
        ok: false,
        disabled: true,
        errorCode: 'DESKTOP_DISABLED',
        error: '容器浏览器已在管理后台被彻底停用',
        status: this.getStatus()
      };
    }

    const reqWidth = options.width ? Number(options.width) : null;
    const reqHeight = options.height ? Number(options.height) : null;
    const reqCdp = typeof options.enableCdp === 'boolean' ? options.enableCdp : null;
    const reqCdpPort = Number(options.cdpPort) ? Number(options.cdpPort) : null;
    const desiredLang = mapLocale(options.lang) || resolveDesktopLang();

    if (this.running) {
      const healthy = await this.isHealthy();
      if (healthy) {
        const resChanged = (reqWidth && reqWidth !== this.config.width)
          || (reqHeight && reqHeight !== this.config.height);
        const cdpChanged = (reqCdp !== null && reqCdp !== this.config.enableCdp)
          || (reqCdpPort !== null && reqCdpPort !== this.config.cdpPort);
        const langChanged = desiredLang !== this.config.lang;
        if (resChanged || cdpChanged || langChanged) {
          console.log('[desktop-manager] 收到运行时配置变更 (分辨率/CDP/语言)，重新应用...');
          await this._stopInternal();
          return this._startInternal(options);
        }
        if (typeof options.idleTimeoutMinutes === 'number') {
          this.config.idleTimeoutMinutes = options.idleTimeoutMinutes;
        }
        this.touchActivity(options.durationMinutes);
        return { ok: true, alreadyRunning: true, status: this.getStatus() };
      }
      console.warn('[desktop-manager] 检测到桌面进程不健康，执行自愈重启...');
      await this._stopInternal();
    }

    this.updateConfig({
      ...(reqWidth ? { width: reqWidth } : {}),
      ...(reqHeight ? { height: reqHeight } : {}),
      ...(reqCdp !== null ? { enableCdp: reqCdp } : {}),
      ...(reqCdpPort !== null ? { cdpPort: reqCdpPort } : {})
    });

    const width = reqWidth || this.config.width;
    const height = reqHeight || this.config.height;
    this.config.width = width;
    this.config.height = height;
    if (typeof options.idleTimeoutMinutes === 'number') {
      this.config.idleTimeoutMinutes = options.idleTimeoutMinutes;
    }
    const durationMinutes = options.durationMinutes;

    console.log(`[desktop-manager] 启动虚拟桌面 (分辨率: ${width}x${height}, CDP: ${this.config.enableCdp ? this.config.cdpPort : '关闭'})...`);

    try { fs.mkdirSync(this.config.logsDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(this.config.userDataDir, { recursive: true }); } catch {}

    await this._prepareEnvironment();

    try {
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonCookie'), { force: true });
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonLock'), { force: true });
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonSocket'), { force: true });
    } catch {}

    this._spawnTracked('xvfb', 'Xvfb', [
      this.config.display,
      '-screen', '0', `${width}x${height}x${this.config.depth}`,
      '-ac', '-nolisten', 'tcp'
    ], { logFile: 'xvfb.log' });

    let displayReady = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const xvfb = this.processes.xvfb;
      if (!xvfb || xvfb.exitCode !== null) {
        console.error('[desktop-manager] Xvfb 进程提前退出');
        break;
      }
      if (await this._displayAlive()) {
        displayReady = true;
        break;
      }
    }

    if (!displayReady) {
      console.error('[desktop-manager] Xvfb 显示服务启动失败或超时');
      await this._stopInternal();
      return { ok: false, errorCode: 'DESKTOP_START_FAILED', error: 'Xvfb 虚拟显示服务启动失败' };
    }

    const env = { ...process.env, DISPLAY: this.config.display };

    this._spawnTracked('openbox', 'openbox', [], { env, logFile: 'openbox.log' });
    this._spawnTracked('x11vnc', 'x11vnc', [
      '-display', this.config.display,
      '-forever', '-shared', '-repeat', '-noxdamage',
      '-rfbport', '5900', '-localhost', '-nopw'
    ], { env, logFile: 'x11vnc.log' });

    const vncPort = Number(process.env.VNC_PORT) || 6080;
    this._spawnTracked('websockify', 'websockify', [
      '--web=/usr/share/novnc',
      `127.0.0.1:${vncPort}`,
      '127.0.0.1:5900'
    ], { logFile: 'novnc.log' });

    this.config.lang = desiredLang;
    const chromeArgs = [
      `--user-data-dir=${this.config.userDataDir}`,
      '--window-position=0,0',
      `--window-size=${width},${height}`
    ];
    if (this.config.lang) chromeArgs.push(`--lang=${this.config.lang}`);
    chromeArgs.push('about:blank');
    if (this.config.enableCdp) {
      chromeArgs.push(
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${this.config.cdpPort}`
      );
    }

    const chromeEnv = { ...env };
    if (this.config.lang) {
      const posix = this.config.lang.replace(/-/g, '_');
      chromeEnv.LANGUAGE = `${posix}:${this.config.lang.split('-')[0]}`;
    }
    this._spawnTracked('chromium', 'chromium-docker', chromeArgs, { env: chromeEnv, logFile: 'chromium.log' });

    this.running = true;
    this.unhealthy = false;
    this.startedAt = Date.now();
    this.touchActivity(durationMinutes);

    console.log('[desktop-manager] 虚拟桌面与 Chromium 启动成功');
    return { ok: true, status: this.getStatus() };
  }

  async _stopInternal() {
    const hasTracked = Object.values(this.processes).some(Boolean);
    if (!this.running && !hasTracked) {
      return { ok: true, alreadyStopped: true };
    }

    console.log('[desktop-manager] 正在停止浏览器与桌面所有进程...');
    this.running = false;
    this.unhealthy = false;

    await this.killTrackedProcesses();
    await this.forceCleanupSystemProcesses();

    this.startedAt = null;
    this.expiresAt = null;

    await this._waitDisplayGone(3000);
    return { ok: true, status: this.getStatus() };
  }

  _spawnTracked(name, cmd, args, { env, logFile } = {}) {
    let fd = null;
    let stdio = 'ignore';
    if (logFile) {
      fd = fs.openSync(path.join(this.config.logsDir, logFile), 'a');
      stdio = ['ignore', fd, fd];
    }
    const proc = spawn(cmd, args, { env, stdio, detached: true });
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    proc.on('exit', (code, signal) => this._onChildExit(name, code, signal));
    proc.on('error', (err) => this._onChildError(name, err));
    this.processes[name] = proc;
    return proc;
  }

  _onChildExit(name, code, signal) {
    const wasRunning = this.running;
    console.warn(`[desktop-manager] 子进程 ${name} 已退出 (code=${code}, signal=${signal})`);
    if (this.processes[name]) this.processes[name] = null;
    if (!wasRunning) return;
    if (name === 'xvfb' || name === 'chromium') {
      this.unhealthy = true;
      console.error(`[desktop-manager] 关键进程 ${name} 异常退出，桌面标记为不健康`);
    }
  }

  _onChildError(name, err) {
    console.error(`[desktop-manager] 子进程 ${name} 启动错误: ${err.message}`);
    if (this.processes[name]) this.processes[name] = null;
    if (this.running && (name === 'xvfb' || name === 'chromium')) this.unhealthy = true;
  }

  async killTrackedProcesses() {
    const entries = Object.entries(this.processes).filter(([, p]) => p);
    await Promise.all(entries.map(([name, proc]) => this._terminate(name, proc)));
    for (const [name] of entries) this.processes[name] = null;
  }

  _terminate(name, proc) {
    return new Promise((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      proc.once('exit', done);

      const signal = (sig) => {
        try {
          if (proc.pid) process.kill(-proc.pid, sig);
          else proc.kill(sig);
        } catch {
          try { proc.kill(sig); } catch {}
        }
      };

      signal('SIGTERM');
      const t1 = setTimeout(() => { signal('SIGKILL'); setTimeout(done, 300); }, 2500);
      const t2 = setTimeout(done, 4500);
      if (t1.unref) t1.unref();
      if (t2.unref) t2.unref();
    });
  }

  async forceCleanupSystemProcesses() {
    const patterns = [
      `Xvfb ${this.config.display}`,
      `--user-data-dir=${this.config.userDataDir}`,
      'x11vnc',
      'websockify'
    ];
    await Promise.all(patterns.map((p) => this._pkill(p)));
  }

  _pkill(pattern) {
    return new Promise((resolve) => {
      let p;
      try { p = spawn('pkill', ['-f', pattern]); } catch { return resolve(); }
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }

  async isHealthy() {
    if (!this.running || this.unhealthy) return false;
    const xvfb = this.processes.xvfb;
    if (!xvfb || xvfb.exitCode !== null) return false;
    if (!(await this._displayAlive())) return false;
    const chrome = this.processes.chromium;
    if (!chrome || chrome.exitCode !== null) return false;
    return true;
  }

  _displayAlive() {
    return new Promise((resolve) => {
      let p;
      try { p = spawn('xdpyinfo', ['-display', this.config.display], { stdio: 'ignore' }); }
      catch { return resolve(false); }
      p.on('close', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
    });
  }

  async _waitDisplayGone(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!(await this._displayAlive())) return true;
      await sleep(250);
    }
    return !(await this._displayAlive());
  }

  _displayNumber() {
    return String(this.config.display).replace(/^:/, '').split('.')[0];
  }

  _xLockPath() {
    return `/tmp/.X${this._displayNumber()}-lock`;
  }

  async _ensureCleanDisplay() {
    if (await this._displayAlive()) {
      console.warn(`[desktop-manager] 检测到显示 ${this.config.display} 被陈旧进程占用，正在清理...`);
      await this._pkill(`Xvfb ${this.config.display}`);
      await this._waitDisplayGone(5000);
    }
    try { fs.rmSync(this._xLockPath(), { force: true }); } catch {}
  }

  _managedPorts() {
    const ports = [5900, Number(process.env.VNC_PORT) || 6080];
    if (this.config.enableCdp) ports.push(this.config.cdpPort);
    return ports;
  }

  _portFree(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      try { srv.listen(port, '127.0.0.1'); } catch { resolve(false); }
    });
  }

  async _waitPortsFree(ports, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      const busy = [];
      for (const p of ports) {
        if (!(await this._portFree(p))) busy.push(p);
      }
      if (!busy.length) return true;
      if (Date.now() >= deadline) {
        console.warn(`[desktop-manager] 端口仍被占用: ${busy.join(', ')}`);
        return false;
      }
      await sleep(300);
    }
  }

  async _prepareEnvironment() {
    await this._ensureCleanDisplay();
    await this._waitPortsFree(this._managedPorts(), 6000);
  }

  getStatus() {
    const now = Date.now();
    let remainingMinutes = null;
    if (this.expiresAt && this.expiresAt > now) {
      remainingMinutes = Math.max(0, Math.ceil((this.expiresAt - now) / 60000));
    }

    const alive = this.running && !this.unhealthy;
    return {
      supported: true,
      enabled: this.isEnabled(),
      running: alive,
      healthy: alive,
      unhealthy: this.unhealthy,
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt ? Math.floor((now - this.startedAt) / 1000) : 0,
      expiresAt: this.expiresAt,
      remainingMinutes,
      width: this.config.width,
      height: this.config.height,
      enableCdp: this.config.enableCdp,
      cdpPort: this.config.cdpPort,
      idleTimeoutMinutes: this.config.idleTimeoutMinutes,
      enableSidebarTab: !!this.config.enableSidebarTab,
      screenshotQuality: this.config.screenshotQuality,
      screenshotDir: this.config.screenshotDir,
      lang: this.config.lang,
      idleSeconds: this.running ? Math.floor((now - this.lastActivity) / 1000) : 0
    };
  }

  updateConfig(patch = {}) {
    if (typeof patch.enabled === 'boolean') this.config.enabled = patch.enabled;
    if (typeof patch.width === 'number') this.config.width = patch.width;
    if (typeof patch.height === 'number') this.config.height = patch.height;
    if (typeof patch.idleTimeoutMinutes === 'number') this.config.idleTimeoutMinutes = patch.idleTimeoutMinutes;
    if (typeof patch.enableCdp === 'boolean') this.config.enableCdp = patch.enableCdp;
    if (typeof patch.cdpPort === 'number') this.config.cdpPort = patch.cdpPort;
    if (typeof patch.enableSidebarTab === 'boolean') this.config.enableSidebarTab = patch.enableSidebarTab;
    if (typeof patch.screenshotQuality === 'string') this.config.screenshotQuality = patch.screenshotQuality;
    if (typeof patch.screenshotDir === 'string') this.config.screenshotDir = patch.screenshotDir;
    if (typeof patch.lang === 'string' && mapLocale(patch.lang)) this.config.lang = mapLocale(patch.lang);
    return this.config;
  }

  isEnabled() {
    return this.config.enabled !== false;
  }

  setEnabled(enabled) {
    const next = enabled !== false;
    if (this.config.enabled === next) return this.config.enabled;
    this.config.enabled = next;
    console.log(`[desktop-manager] 容器浏览器总开关已${next ? '启用' : '彻底停用'}`);
    return this.config.enabled;
  }

  applyConfig(patch = {}) {
    const safe = { ...patch };
    delete safe.enabled;
    const keys = ['width', 'height', 'idleTimeoutMinutes', 'enableCdp', 'cdpPort', 'enableSidebarTab', 'screenshotQuality', 'screenshotDir'];
    const before = {};
    for (const k of keys) before[k] = this.config[k];
    this.updateConfig(safe);
    const changed = {};
    for (const k of keys) {
      if (before[k] !== this.config[k]) changed[k] = this.config[k];
    }
    if (Object.keys(changed).length) {
      console.log('[desktop-manager] 运行时配置已更新:', JSON.stringify(changed));
    }
    const restartKeys = ['width', 'height', 'enableCdp', 'cdpPort'];
    if (this.running && Object.keys(changed).some((k) => restartKeys.includes(k))) {
      console.log('[desktop-manager] 运行时配置变更需重启桌面以生效，正在异步重启...');
      this.restart({ width: this.config.width, height: this.config.height })
        .catch((err) => console.error('[desktop-manager] 配置变更重启失败:', err.message));
    }
    return changed;
  }
}

const instance = new DesktopManager();
instance.DesktopManager = DesktopManager;
module.exports = instance;
