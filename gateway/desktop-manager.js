const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class DesktopManager {
  constructor() {
    this.running = false;
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
      width: Number(process.env.DSH_DESKTOP_WIDTH) || 1440,
      height: Number(process.env.DSH_DESKTOP_HEIGHT) || 900,
      depth: Number(process.env.DSH_DESKTOP_DEPTH) || 24,
      idleTimeoutMinutes: Number(process.env.DSH_IDLE_TIMEOUT_MINUTES) || 30, // 0 = disabled
      enableCdp: process.env.DSH_ENABLE_CDP !== '0',
      cdpPort: Number(process.env.DSH_CDP_PORT) || 9222,
      userDataDir: process.env.CHROME_USER_DATA_DIR || '/root/.config/chromium',
      logsDir: '/tmp/dsh-desktop'
    };

    fs.mkdirSync(this.config.logsDir, { recursive: true });
    fs.mkdirSync(this.config.userDataDir, { recursive: true });

    // Start background idle watchdog
    this.watchdogTimer = setInterval(() => this.checkIdleWatchdog(), 15000);
    this.watchdogTimer.unref();
  }

  touchActivity(durationMinutes) {
    this.lastActivity = Date.now();
    if (typeof durationMinutes === 'number' && durationMinutes > 0) {
      this.expiresAt = Date.now() + durationMinutes * 60 * 1000;
      console.log(`[desktop-manager] 浏览器工作时长设置为 ${durationMinutes} 分钟，预计到期: ${new Date(this.expiresAt).toLocaleTimeString()}`);
    }
  }

  checkIdleWatchdog() {
    if (!this.running) return;
    const now = Date.now();

    // 1. Check AI-specified duration expiration
    if (this.expiresAt && now >= this.expiresAt) {
      console.log('[desktop-manager] 浏览器工作时长已到期，自动停止以节约资源');
      this.stop();
      return;
    }

    // 2. Check idle timeout
    if (this.config.idleTimeoutMinutes > 0) {
      const idleMs = now - this.lastActivity;
      if (idleMs >= this.config.idleTimeoutMinutes * 60 * 1000) {
        console.log(`[desktop-manager] 浏览器已空闲超过 ${this.config.idleTimeoutMinutes} 分钟，自动休眠`);
        this.stop();
      }
    }
  }

  async start(options = {}) {
    if (this.running) {
      this.touchActivity(options.durationMinutes);
      return { ok: true, alreadyRunning: true, status: this.getStatus() };
    }

    const width = Number(options.width) || this.config.width;
    const height = Number(options.height) || this.config.height;
    const durationMinutes = options.durationMinutes;

    console.log(`[desktop-manager] 启动虚拟桌面 (分辨率: ${width}x${height}, CDP: ${this.config.enableCdp ? this.config.cdpPort : '关闭'})...`);

    // Clean chromium lock files
    try {
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonCookie'), { force: true });
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonLock'), { force: true });
      fs.rmSync(path.join(this.config.userDataDir, 'SingletonSocket'), { force: true });
    } catch {}

    // 1. Start Xvfb (using synchronous fd for reliable stdio)
    const xvfbFd = fs.openSync(path.join(this.config.logsDir, 'xvfb.log'), 'a');
    this.processes.xvfb = spawn('Xvfb', [
      this.config.display,
      '-screen', '0', `${width}x${height}x${this.config.depth}`,
      '-ac', '-nolisten', 'tcp'
    ], { stdio: ['ignore', xvfbFd, xvfbFd] });

    // Wait for X display to become ready
    let displayReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      const check = spawn('xdpyinfo', ['-display', this.config.display], { stdio: 'ignore' });
      const code = await new Promise(r => check.on('close', r));
      if (code === 0) {
        displayReady = true;
        break;
      }
    }

    if (!displayReady) {
      console.error('[desktop-manager] Xvfb 显示服务启动失败或超时');
      this.stop();
      return { ok: false, error: 'Xvfb 虚拟显示服务启动失败' };
    }

    const env = { ...process.env, DISPLAY: this.config.display };

    // 2. Start Openbox
    const obFd = fs.openSync(path.join(this.config.logsDir, 'openbox.log'), 'a');
    this.processes.openbox = spawn('openbox', [], { env, stdio: ['ignore', obFd, obFd] });

    // 3. Start x11vnc
    const vncFd = fs.openSync(path.join(this.config.logsDir, 'x11vnc.log'), 'a');
    this.processes.x11vnc = spawn('x11vnc', [
      '-display', this.config.display,
      '-forever', '-shared', '-repeat', '-noxdamage',
      '-rfbport', '5900', '-localhost', '-nopw'
    ], { env, stdio: ['ignore', vncFd, vncFd] });

    // 4. Start websockify (noVNC web at /usr/share/novnc)
    const wsFd = fs.openSync(path.join(this.config.logsDir, 'novnc.log'), 'a');
    this.processes.websockify = spawn('websockify', [
      '--web=/usr/share/novnc',
      '127.0.0.1:6080',
      '127.0.0.1:5900'
    ], { stdio: ['ignore', wsFd, wsFd] });

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

    const chromeFd = fs.openSync(path.join(this.config.logsDir, 'chromium.log'), 'a');
    this.processes.chromium = spawn('chromium-docker', chromeArgs, {
      env,
      stdio: ['ignore', chromeFd, chromeFd]
    });

    this.running = true;
    this.startedAt = Date.now();
    this.touchActivity(durationMinutes);

    console.log('[desktop-manager] 虚拟桌面与 Chromium 启动成功');
    return { ok: true, status: this.getStatus() };
  }

  stop() {
    if (!this.running) return { ok: true, alreadyStopped: true };

    console.log('[desktop-manager] 正在停止浏览器与桌面所有进程...');
    for (const [name, proc] of Object.entries(this.processes)) {
      if (proc) {
        try { proc.kill('SIGTERM'); } catch {}
        this.processes[name] = null;
      }
    }

    // Force cleanup any remaining X11 / Chromium children
    try {
      spawn('pkill', ['-f', 'Xvfb :99']).on('error', () => {});
      spawn('pkill', ['-f', 'chromium']).on('error', () => {});
      spawn('pkill', ['-f', 'x11vnc']).on('error', () => {});
      spawn('pkill', ['-f', 'websockify']).on('error', () => {});
    } catch {}

    this.running = false;
    this.startedAt = null;
    this.expiresAt = null;
    return { ok: true, status: this.getStatus() };
  }

  async restart(options = {}) {
    this.stop();
    await new Promise(r => setTimeout(r, 1000));
    return this.start(options);
  }

  getStatus() {
    const now = Date.now();
    let remainingMinutes = null;
    if (this.expiresAt && this.expiresAt > now) {
      remainingMinutes = Math.max(0, Math.ceil((this.expiresAt - now) / 60000));
    }

    return {
      running: this.running,
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt ? Math.floor((now - this.startedAt) / 1000) : 0,
      expiresAt: this.expiresAt,
      remainingMinutes,
      width: this.config.width,
      height: this.config.height,
      enableCdp: this.config.enableCdp,
      cdpPort: this.config.cdpPort,
      idleTimeoutMinutes: this.config.idleTimeoutMinutes,
      idleSeconds: this.running ? Math.floor((now - this.lastActivity) / 1000) : 0
    };
  }

  updateConfig(patch = {}) {
    if (typeof patch.width === 'number') this.config.width = patch.width;
    if (typeof patch.height === 'number') this.config.height = patch.height;
    if (typeof patch.idleTimeoutMinutes === 'number') this.config.idleTimeoutMinutes = patch.idleTimeoutMinutes;
    if (typeof patch.enableCdp === 'boolean') this.config.enableCdp = patch.enableCdp;
    if (typeof patch.cdpPort === 'number') this.config.cdpPort = patch.cdpPort;
    return this.config;
  }
}

const instance = new DesktopManager();
module.exports = instance;
