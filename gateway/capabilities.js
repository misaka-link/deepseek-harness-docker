/**
 * gateway/capabilities.js —— 变体运行期能力真源 (Issue #11)
 *
 * 单一真源（无 fs / 无进程副作用，仅读 ENV）
 * 冻结契约供前端 (admin.html)、网关 (index.js) 与健康检查 (/healthz) 共享。
 */

function parseCapabilitiesEnv(envVal) {
  const overrides = {};
  if (!envVal || typeof envVal !== 'string') return overrides;
  const pairs = envVal.split(/[,;\s]+/);
  for (const pair of pairs) {
    if (!pair) continue;
    const [k, v] = pair.split('=').map(s => s.trim().toLowerCase());
    if (k) {
      if (v === '0' || v === 'false' || v === 'no' || v === 'off' || v === 'disable' || v === 'disabled') {
        overrides[k] = false;
      } else if (v === '1' || v === 'true' || v === 'yes' || v === 'on' || v === 'enable' || v === 'enabled' || v === undefined) {
        overrides[k] = true;
      }
    }
  }
  return overrides;
}

const rawVariant = String(process.env.DSH_VARIANT || 'full').trim().toLowerCase();
const isMini = rawVariant === 'mini';
const variant = isMini ? 'mini' : 'full';

// 基础变体推导
let desktopSupported = !isMini;
let golangSupported = !isMini;
let vncSupported = !isMini;

// 可选支持 DSH_CAPABILITIES=desktop=0,golang=0 环境变量强制覆盖（用于 CI 或特种部署）
const capOverrides = parseCapabilitiesEnv(process.env.DSH_CAPABILITIES);
if (typeof capOverrides.desktop === 'boolean') {
  desktopSupported = capOverrides.desktop;
}
if (typeof capOverrides.golang === 'boolean') {
  golangSupported = capOverrides.golang;
}
if (typeof capOverrides.vnc === 'boolean') {
  vncSupported = capOverrides.vnc;
} else {
  // noVNC 依赖容器桌面与 X11 栈，桌面不支持时 VNC 必不支持
  vncSupported = vncSupported && desktopSupported;
}

const desktopEnabled = desktopSupported && process.env.DSH_DESKTOP_ENABLED !== '0';

const vncPathRaw = (process.env.VNC_PATH || '/vnc').trim();
const vncPathNorm = vncPathRaw.endsWith('/') ? vncPathRaw : vncPathRaw + '/';

const capabilities = {
  variant,
  desktop: {
    supported: desktopSupported,
    enabled: desktopEnabled,
    ...(!desktopSupported ? { reason: isMini ? '当前为 mini 镜像：未预装 Chromium 与 X11/noVNC 桌面栈' : '当前环境已停用 Chromium 与 X11/noVNC 桌面能力' } : {})
  },
  browser: {
    containerBrowser: desktopSupported,      // 容器内自动化浏览器（AI 工具）
    pluginSupported: desktopSupported,       // 是否允许安装/启用 dsh-browser-desktop
    sidebarBrowserSupported: true           // 客户端侧边栏浏览器，与容器无关（始终支持）
  },
  golang: {
    supported: golangSupported
  },
  vnc: {
    supported: vncSupported,
    path: vncSupported ? vncPathNorm : null
  }
};

Object.freeze(capabilities.desktop);
Object.freeze(capabilities.browser);
Object.freeze(capabilities.golang);
Object.freeze(capabilities.vnc);
Object.freeze(capabilities);

module.exports = capabilities;
