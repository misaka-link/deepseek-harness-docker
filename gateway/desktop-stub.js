/**
 * gateway/desktop-stub.js —— mini 变体无副作用 NullDesktopManager (Issue #11)
 *
 * 与 desktop-manager.js 同形，供 index.js 在 !CAP.desktop.supported 时加载。
 * 零 child_process.spawn、零 fs.mkdirSync、零 setInterval 定时器。
 */

class DesktopStub {
  constructor() {
    this.running = false;
    this.unhealthy = false;
    this.startedAt = null;
    this.expiresAt = null;
    this.lastActivity = 0;
    this.processes = {
      xvfb: null,
      openbox: null,
      x11vnc: null,
      websockify: null,
      chromium: null
    };
    this.config = {
      display: ':99',
      enabled: false,
      width: 0,
      height: 0,
      depth: 24,
      idleTimeoutMinutes: 0,
      enableCdp: false,
      cdpPort: 0,
      enableSidebarTab: false,
      screenshotQuality: 'high',
      screenshotDir: '',
      userDataDir: '',
      logsDir: ''
    };
  }

  touchActivity(durationMinutes) {
    // mini 变体无桌面进程，活动探测空转
  }

  checkIdleWatchdog() {
    // mini 变体无需空闲检测看门狗
  }

  async start(options = {}) {
    return {
      ok: false,
      skipped: true,
      error: '当前为 mini 镜像，不含容器桌面与浏览器能力',
      running: false
    };
  }

  async stop() {
    return {
      ok: true,
      stopped: true,
      running: false
    };
  }

  async restart(options = {}) {
    return {
      ok: false,
      skipped: true,
      error: '当前为 mini 镜像，不含容器桌面与浏览器能力',
      running: false
    };
  }

  getStatus() {
    return {
      supported: false,
      enabled: false,
      running: false,
      healthy: false,
      unhealthy: false,
      startedAt: null,
      uptimeSeconds: 0,
      expiresAt: null,
      remainingMinutes: null,
      width: this.config.width,
      height: this.config.height,
      enableCdp: false,
      cdpPort: 0,
      idleTimeoutMinutes: 0,
      enableSidebarTab: false,
      screenshotQuality: this.config.screenshotQuality,
      screenshotDir: this.config.screenshotDir,
      idleSeconds: 0,
      reason: '当前为 mini 镜像：未预装 Chromium 与 X11/noVNC 桌面栈'
    };
  }

  updateConfig(patch = {}) {
    // mini 镜像下桌面配置始终为禁用状态
    return { ...this.config, enabled: false };
  }

  isEnabled() {
    return false;
  }

  setEnabled(enabled) {
    return false;
  }

  applyConfig(patch = {}) {
    // mini 镜像不接受任何运行时桌面配置生效
    return {};
  }

  async shutdown() {
    return;
  }
}

const instance = new DesktopStub();
module.exports = instance;
