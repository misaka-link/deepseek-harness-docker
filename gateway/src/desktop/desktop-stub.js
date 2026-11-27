'use strict';
/**
 * desktop-stub.js — mini 变体无副作用 NullDesktopManager。
 *
 * 与 desktop-manager.js 接口同形：零子进程派生、零目录创建、零定时器。
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

  touchActivity() {}

  checkIdleWatchdog() {}

  async start() {
    return {
      ok: false,
      skipped: true,
      code: 'CAPABILITY_UNAVAILABLE',
      errorCode: 'CAPABILITY_UNAVAILABLE',
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

  async restart() {
    return {
      ok: false,
      skipped: true,
      code: 'CAPABILITY_UNAVAILABLE',
      errorCode: 'CAPABILITY_UNAVAILABLE',
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

  updateConfig() {
    return { ...this.config, enabled: false };
  }

  isEnabled() {
    return false;
  }

  setEnabled() {
    return false;
  }

  applyConfig() {
    return {};
  }

  async shutdown() {}
}

const instance = new DesktopStub();
instance.DesktopStub = DesktopStub;
module.exports = instance;
