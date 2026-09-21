const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

    this.config = {
      display: process.env.DISPLAY || ':99',
      // 管理后台「彻底开关」总开关：默认由环境变量决定，可被管理后台持久化覆盖
      enabled: process.env.DSH_DESKTOP_ENABLED !== '0',
      width: Number(process.env.DSH_DESKTOP_WIDTH) || 1920,
      height: Number(process.env.DSH_DESKTOP_HEIGHT) || 1080,
      depth: Number(process.env.DSH_DESKTOP_DEPTH) || 24,
      idleTimeoutMinutes: Number(process.env.DSH_IDLE_TIMEOUT_MINUTES) || 30, // 0 = disabled
      enableCdp: process.env.DSH_ENABLE_CDP !== '0',
      cdpPort: Number(process.env.DSH_CDP_PORT) || 9222,
      enableSidebarTab: process.env.DSH_ENABLE_SIDEBAR_TAB === '1' || false,
      // 截图工具默认参数（由 Admin「浏览器与桌面控制」页配置，插件经 status 读取）
      screenshotQuality: process.env.DSH_SCREENSHOT_QUALITY || 'high',
      screenshotDir: process.env.DSH_SCREENSHOT_DIR || '',
      userDataDir: process.env.CHROME_USER_DATA_DIR || '/root/.config/chromium',
      logsDir: '/tmp/dsh-desktop'
    };

    fs.mkdirSync(this.config.logsDir, { recursive: true });
    fs.mkdirSync(this.config.userDataDir, { recursive: true });

    // Start background idle watchdog
    this.watchdogTimer = setInterval(() => this.checkIdleWatchdog(), 15000);
    this.watchdogTimer.unref();
    // 生命周期操作串行队列：start/stop/restart 依次执行，杜绝相互 await 造成的自等待死锁
    this._opChain = Promise.resolve();
  }

  touchActivity(durationMinutes) {
    this.lastActivity = Date.now();
    if (typeof durationMinutes === 'number' && durationMinutes > 0) {
      this.expiresAt = Date.now() + durationMinutes * 60 * 1000;
      console.log(`[desktop-manager] 浏览器工作时长设置为 ${durationMinutes} 分钟，预计到期: ${new Date(this.expiresAt).toLocaleTimeString()}`);
    } else if (durationMinutes === 0) {
      // 显式传 0 = 取消工作时长限制（原实现会保留旧的 expiresAt，导致"取消"后仍被自动停）
      this.expiresAt = null;
      console.log('[desktop-manager] 已取消浏览器工作时长限制（不再自动到期停止）');
    }
  }

  checkIdleWatchdog() {
    if (!this.running) return;
    const now = Date.now();

    // 1. Check AI-specified duration expiration
    if (this.expiresAt && now >= this.expiresAt) {
      console.log('[desktop-manager] 浏览器工作时长已到期，自动停止以节约资源');
      this.stop().catch((e) => console.warn('[desktop-manager] 到期自动停止失败:', e.message));
      return;
    }

    // 2. Check idle timeout
    if (this.config.idleTimeoutMinutes > 0) {
      const idleMs = now - this.lastActivity;
      if (idleMs >= this.config.idleTimeoutMinutes * 60 * 1000) {
        console.log(`[desktop-manager] 浏览器已空闲超过 ${this.config.idleTimeoutMinutes} 分钟，自动休眠`);
        this.stop().catch((e) => console.warn('[desktop-manager] 空闲自动休眠失败:', e.message));
      }
    }
  }

  // ── 生命周期串行化 ──────────────────────────────────────────
  // 将生命周期操作串行化：前序操作无论成功失败都不阻塞后续操作
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
    // 管理后台「彻底停用」时拒绝一切启动请求（覆盖 AI 工具、VNC 自动唤醒、bootstrap 自举等所有入口）
    if (this.config.enabled === false) {
      console.log('[desktop-manager] 容器浏览器已被管理后台彻底停用，拒绝启动请求');
      return { ok: false, disabled: true, error: '容器浏览器已在管理后台被彻底停用', status: this.getStatus() };
    }

    // 启动请求可携带运行时配置（分辨率 / CDP 开关与端口），统一收敛到单一权威配置
    const reqWidth = options.width ? Number(options.width) : null;
    const reqHeight = options.height ? Number(options.height) : null;
    const reqCdp = typeof options.enableCdp === 'boolean' ? options.enableCdp : null;
    const reqCdpPort = Number(options.cdpPort) ? Number(options.cdpPort) : null;

    if (this.running) {
      // 运行中：先校验真实健康度，避免“标志为真但进程已死”导致启动被短路
      const healthy = await this.isHealthy();
      if (healthy) {
        const resChanged = (reqWidth && reqWidth !== this.config.width) ||
                           (reqHeight && reqHeight !== this.config.height);
        const cdpChanged = (reqCdp !== null && reqCdp !== this.config.enableCdp) ||
                           (reqCdpPort !== null && reqCdpPort !== this.config.cdpPort);
        if (resChanged || cdpChanged) {
          console.log(`[desktop-manager] 收到运行时配置变更 (分辨率/CDP)，重新应用...`);
          // 直接调用内部方法，绝不通过公共 start/stop/restart，避免队列自等待死锁
          await this._stopInternal();
          return this._startInternal(options);
        }
        if (typeof options.idleTimeoutMinutes === 'number') {
          this.config.idleTimeoutMinutes = options.idleTimeoutMinutes;
        }
        this.touchActivity(options.durationMinutes);
        return { ok: true, alreadyRunning: true, status: this.getStatus() };
      }
      console.warn('[desktop-manager] 检测到桌面进程不健康（关键进程已退出），执行自愈重启...');
      await this._stopInternal();
    }

    // 应用本次启动携带的运行时配置
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

    // 启动前清理：回收陈旧 X 显示占用、清理 X 锁、等待端口释放，避免快速重启竞争
    await this._prepareEnvironment();

    // Clean chromium lock files
    try {
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonCookie'), { force: true });
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonLock'), { force: true });
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonSocket'), { force: true });
    } catch {}

    // 1. Start Xvfb
    this._spawnTracked('xvfb', 'Xvfb', [
      this.config.display,
      '-screen', '0', `${width}x${height}x${this.config.depth}`,
      '-ac', '-nolisten', 'tcp'
    ], { logFile: 'xvfb.log' });

    // Wait for X display to become ready
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
      return { ok: false, error: 'Xvfb 虚拟显示服务启动失败' };
    }

    const env = { ...process.env, DISPLAY: this.config.display };

    // 2. Start Openbox
    this._spawnTracked('openbox', 'openbox', [], { env, logFile: 'openbox.log' });

    // 3. Start x11vnc
    this._spawnTracked('x11vnc', 'x11vnc', [
      '-display', this.config.display,
      '-forever', '-shared', '-repeat', '-noxdamage',
      '-rfbport', '5900', '-localhost', '-nopw'
    ], { env, logFile: 'x11vnc.log' });

    // 4. Start websockify (noVNC web at /usr/share/novnc)
    const vncPort = Number(process.env.VNC_PORT) || 6080;
    this._spawnTracked('websockify', 'websockify', [
      '--web=/usr/share/novnc',
      `127.0.0.1:${vncPort}`,
      '127.0.0.1:5900'
    ], { logFile: 'novnc.log' });

    // 5. Start Chromium
    const chromeArgs = [
      `--user-data-dir=${this.config.userDataDir}`,
      '--window-position=0,0',
      `--window-size=${width},${height}`,
      'about:blank'
    ];
    if (this.config.enableCdp) {
      chromeArgs.push(
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${this.config.cdpPort}`
      );
    }
    this._spawnTracked('chromium', 'chromium-docker', chromeArgs, { env, logFile: 'chromium.log' });

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
    // 先复位状态，避免子进程退出回调把正常停止误判为异常崩溃
    this.running = false;
    this.unhealthy = false;

    await this.killTrackedProcesses();
    await this.forceCleanupSystemProcesses();

    this.startedAt = null;
    this.expiresAt = null;

    // 等待显示真正释放，避免紧接着的启动撞上未退场的旧 X server
    await this._waitDisplayGone(3000);
    return { ok: true, status: this.getStatus() };
  }

  // ── 进程托管 ────────────────────────────────────────────────
  _spawnTracked(name, cmd, args, { env, logFile } = {}) {
    let fd = null;
    let stdio = 'ignore';
    if (logFile) {
      fd = fs.openSync(path.join(this.config.logsDir, logFile), 'a');
      stdio = ['ignore', fd, fd];
    }
    // detached: 独立进程组，便于一次性回收 Chromium 全部子进程
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
      console.error(`[desktop-manager] 关键进程 ${name} 异常退出，桌面标记为不健康，将在下次启动时自愈`);
    }
  }

  _onChildError(name, err) {
    console.error(`[desktop-manager] 子进程 ${name} 启动错误: ${err.message}`);
    if (this.processes[name]) this.processes[name] = null;
    if (this.running && (name === 'xvfb' || name === 'chromium')) this.unhealthy = true;
  }

  // 回收本管理器派生并记录的进程句柄（先 SIGTERM 优雅退出，超时再 SIGKILL）
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
          if (proc.pid) process.kill(-proc.pid, sig); // 整组回收
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

  // 兜底清理可能残留的系统级进程 (防止端口/显示被孤儿进程占用)
  async forceCleanupSystemProcesses() {
    // 轻微项：不再用过于宽泛的 `pkill -f chromium`（会误杀容器内其它用途的 Chromium，
    // 例如管理后台截图脚本启动的无头实例），只匹配本桌面自己的进程特征。
    const patterns = [
      `Xvfb ${this.config.display}`,
      `--user-data-dir=${this.config.userDataDir}`, // Chromium（仅本桌面的用户数据目录）
      'x11vnc',
      'websockify'
    ];
    await Promise.all(patterns.map(p => this._pkill(p)));
  }

  _pkill(pattern) {
    return new Promise((resolve) => {
      let p;
      try { p = spawn('pkill', ['-f', pattern]); } catch { return resolve(); }
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }

  // ── 健康探测与资源等待 ──────────────────────────────────────
  async isHealthy() {
    if (!this.running || this.unhealthy) return false;
    const xvfb = this.processes.xvfb;
    if (!xvfb || xvfb.exitCode !== null) return false;
    if (!(await this._displayAlive())) return false;
    const chrome = this.processes.chromium;
    if (!chrome || chrome.exitCode !== null) return false;
    // 说明：此处不校验 CDP 端口就绪。CDP 在 Chromium 刚拉起时可能尚未监听，
    // 若纳入健康判定会导致刚启动就被误判为“不健康”而整桌重启、丢失已开标签页。
    // CDP 可达性由调用方（插件 browser_open/screenshot）在需要时自行探测。
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
    // 清理可能残留的 X 锁文件 (否则 Xvfb 会因 "Server is already active" 拒绝启动)
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
    return this.config;
  }

  // 管理后台「彻底开关」专用：仅这里可以翻转总开关（插件热更新不可更改）
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

  // 应用运行时配置补丁（keepalive 等热更新入口），返回本次实际发生变化的字段
  applyConfig(patch = {}) {
    // 总开关由管理后台专有：插件 keepalive 不得翻转
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
    // 分辨率 / CDP 相关变更需要重启桌面才能真正生效
    const restartKeys = ['width', 'height', 'enableCdp', 'cdpPort'];
    if (this.running && Object.keys(changed).some(k => restartKeys.includes(k))) {
      console.log('[desktop-manager] 运行时配置变更需重启桌面以生效，正在异步重启...');
      this.restart({ width: this.config.width, height: this.config.height })
        .catch(err => console.error('[desktop-manager] 配置变更重启失败:', err.message));
    }
    return changed;
  }
}

const instance = new DesktopManager();
module.exports = instance;
