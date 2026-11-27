'use strict';

/**
 * VNC / noVNC HTTP route handler (${VNC_PATH}, ${VNC_PATH}/*, /vnc, /vnc/*).
 * Fixes custom VNC_PATH prefix slicing and provides localized 404/503/starting pages.
 */

const { AppError } = require('../i18n/errors');
const { sendError, sendRedirect, isHtmlNavigation } = require('../http/respond');
const {
  renderCapabilityGonePage,
  renderDesktopDisabledPage,
  renderDesktopStartingPage
} = require('../http/pages');
const { stripVncPrefix } = require('../proxy/vnc-proxy');
const { isBrowserPluginDisabled } = require('./desktop-control');

function isVncHttpPath(pathname, vncPath = '/vnc') {
  return (
    pathname === vncPath ||
    pathname.startsWith(vncPath + '/') ||
    pathname === '/vnc' ||
    pathname.startsWith('/vnc/')
  );
}

function handleVncHttp(req, res, pathname, parsedUrl, ctx) {
  const { runtimeConfig, capabilities, desktopManager, pluginManager, vncProxy } = ctx;
  const vncPath = runtimeConfig.vncPath;

  if (!capabilities.desktop.supported) {
    if (isHtmlNavigation(req)) {
      return renderCapabilityGonePage(req, res, runtimeConfig);
    }
    return sendError(
      res,
      req,
      new AppError('CAPABILITY_UNAVAILABLE', { capability: 'vnc' }, 404, 'NOT_FOUND')
    );
  }

  if (!desktopManager.isEnabled() || isBrowserPluginDisabled(pluginManager)) {
    return renderDesktopDisabledPage(req, res, runtimeConfig);
  }

  if (!desktopManager.getStatus().running) {
    desktopManager.start().catch(() => {});
    if (isHtmlNavigation(req)) {
      return renderDesktopStartingPage(req, res, runtimeConfig);
    }
  } else {
    desktopManager.touchActivity();
  }

  const versionedVncPath = `/novnc-${runtimeConfig.novncRevision}/vnc.html`;
  const websockifyPath = `${vncPath}/websockify`;

  // Root entry -> redirect to versioned noVNC entry with absolute websockify path
  if (pathname === vncPath || pathname === vncPath + '/' || pathname === '/vnc' || pathname === '/vnc/') {
    return sendRedirect(
      res,
      `${vncPath}${versionedVncPath}?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=${websockifyPath}`
    );
  }

  // Legacy unversioned vnc.html -> redirect to versioned entry
  if (pathname === `${vncPath}/vnc.html` || pathname === '/vnc/vnc.html') {
    const search = parsedUrl.search || `?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=${websockifyPath}`;
    return sendRedirect(res, `${vncPath}${versionedVncPath}${search}`);
  }

  // Strip whichever prefix actually matched (custom VNC_PATH or /vnc)
  req.url = stripVncPrefix(req.url, vncPath);
  return vncProxy.web(req, res);
}

module.exports = {
  isVncHttpPath,
  handleVncHttp
};
