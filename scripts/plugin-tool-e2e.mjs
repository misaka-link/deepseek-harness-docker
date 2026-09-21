/**
 * 容器内「插件工具层」端到端测试。
 * 直接加载 dsh-browser-desktop 插件，用 mock ctx 注册工具并真实调用，
 * 覆盖 browser_open / browser_screenshot / browser_control 全链路
 * （插件 -> 网关 /__internal/desktop -> DesktopManager -> 真实 Chromium）。
 *
 * 在容器内运行：node /app/scripts/plugin-tool-e2e.mjs
 */
const mod = await import('/app/plugins/dsh-browser-desktop/index.js');

// 内部接口共享密钥（M14）：网关启动时生成 0600 文件，容器内脚本读取后带上
import fs from 'node:fs';
const INTERNAL_TOKEN_FILE = process.env.DSH_INTERNAL_TOKEN_FILE || '/root/.dsh/.internal-api-token';
const internalHeaders = (extra = {}) => {
  const h = { 'Content-Type': 'application/json', ...extra };
  try {
    const t = fs.readFileSync(INTERNAL_TOKEN_FILE, 'utf8').trim();
    if (t) h['x-dsh-internal-token'] = t;
  } catch {}
  return h;
};

const tools = {};
const mockCtx = {
  tools: { register: (t) => { tools[t.name] = t; } },
  systemPrompt: { section: () => {} },
  settings: {
    register: () => ({ get: () => ({}), watch: () => {} }),
    section: () => undefined
  }
};
mod.apply(mockCtx, {});

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
  console.log('   ✔ ' + msg);
}

console.log('1. browser_open 打开页面');
const open = await tools.browser_open.execute({ url: 'http://127.0.0.1:3080/login' }, { signal: null });
console.log('   tabId =', open.tabId, 'status =', open.status);
assert(open.tabId, 'browser_open 返回了 tabId');

console.log('2. browser_screenshot 截图');
const shot = await tools.browser_screenshot.execute({ savePath: 'doc/plugin-e2e.png' }, { signal: null });
console.log('   path =', shot.path, 'bytes =', shot.bytes);
assert(shot.bytes > 0, 'browser_screenshot 成功产出截图');

console.log('3. 运行中切换分辨率（原死锁场景，经工具链路）');
const open2 = await tools.browser_open.execute({ url: 'http://127.0.0.1:3080/login', resolution: '1280x720' }, { signal: null });
console.log('   tabId =', open2.tabId, 'resolution =', open2.resolution);
assert(open2.resolution === '1280x720', '分辨率已切换为 1280x720（未死锁）');

console.log('4. browser_control tabs');
const tabs = await tools.browser_control.execute({ action: 'tabs' });
assert(tabs.ok && tabs.count >= 1, 'browser_control tabs 返回标签页列表');

console.log('5. browser_control close_all_tabs + stop');
await tools.browser_control.execute({ action: 'close_all_tabs' });
const stopped = await tools.browser_control.execute({ action: 'stop' });
assert(stopped.ok, 'browser_control stop 成功');

console.log('6. Admin「彻底停用浏览器」→ 插件零注册（R1：工具与提示词随之消失）');
const GW = `http://127.0.0.1:${process.env.PROXY_PORT || 3080}/__internal/desktop`;
const masterCall = async (enabled) => {
  const r = await fetch(`${GW}/master`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({ enabled })
  });
  return r.json();
};
const offRes = await masterCall(false);
assert(offRes.ok && offRes.enabled === false, 'Admin 总开关已彻底停用浏览器');
await new Promise(r => setTimeout(r, 1500));

const disabledTools = {};
let disabledPrompt = null;
const disabledCtx = {
  tools: { register: (t) => { disabledTools[t.name] = true; return () => { delete disabledTools[t.name]; }; } },
  systemPrompt: { section: (s) => { disabledPrompt = s.name; return () => { disabledPrompt = null; }; } },
  settings: { register: () => ({ get: () => ({}), watch: () => (() => {}) }), section: () => undefined },
  on: () => {}
};
mod.apply(disabledCtx, {});
await new Promise(r => setTimeout(r, 2500)); // 等首次同步完成
assert(Object.keys(disabledTools).length === 0, 'Admin 停用浏览器后插件不注册任何工具');
assert(disabledPrompt === null, 'Admin 停用浏览器后不注入系统提示词段');

console.log('7. 恢复启用浏览器');
const onRes = await masterCall(true);
assert(onRes.ok && onRes.enabled === true, '浏览器已恢复启用');

console.log('PLUGIN_E2E_OK');
