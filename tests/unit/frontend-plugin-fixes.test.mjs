#!/usr/bin/env node
/**
 * 前端模块化架构与浏览器桌面插件回归测试。
 * 用法: node tests/unit/frontend-plugin-fixes.test.mjs
 */
import '../helpers/schemastery-stub.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN = path.join(ROOT, 'plugins/dsh-browser-desktop/index.js');
const CLIENT = path.join(ROOT, 'plugins/dsh-browser-desktop/client.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { fail++; console.log('  ✗ ' + name + '\n      ' + (err && err.message)); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p6-'));
const CONFIG = path.join(tmpRoot, 'gateway.config.json');
const TOKENFILE = path.join(tmpRoot, '.internal-api-token');
fs.writeFileSync(TOKENFILE, 'test-token\n', { mode: 0o600 });
process.env.GATEWAY_CONFIG_FILE = CONFIG;
process.env.DSH_INTERNAL_TOKEN_FILE = TOKENFILE;
const STATE_FILE = path.join(tmpRoot, '.browser-desktop-last-state.json');
process.env.BROWSER_DESKTOP_STATE_FILE = STATE_FILE;

const writeConfig = (obj) => fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2));
const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtx() {
  const tools = {};
  const ctx = {
    tools: { register: (t) => { tools[t.name] = t; return () => { delete tools[t.name]; }; } },
    systemPrompt: { section: () => () => {} },
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
    on: () => {}
  };
  return { ctx, tools };
}

async function loadPlugin() {
  return import(pathToFileURL(PLUGIN).href + '?t=' + Date.now() + Math.random());
}

function walkJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

try {
  console.log('\n[插件] 权威配置、close_all_tabs、CDP 超时与重试');
  await check('文件不存在 → 默认启用，注册 3 个浏览器工具', async () => {
    try { fs.unlinkSync(CONFIG); } catch {}
    const mod = await loadPlugin();
    const { ctx, tools } = makeCtx();
    mod.apply(ctx, {});
    assert.deepEqual(Object.keys(tools).sort(), ['browser_control', 'browser_open', 'browser_screenshot']);
  });

  await check('配置 enabled:false → 不注册工具', async () => {
    writeConfig({ desktop: { enabled: false } });
    const mod = await loadPlugin();
    const { ctx, tools } = makeCtx();
    mod.apply(ctx, {});
    assert.equal(Object.keys(tools).length, 0);
  });

  await check('JSON 损坏 → 保持上次成功快照（不回退为启用）', async () => {
    writeConfig({ desktop: { enabled: false } });
    const mod = await loadPlugin();
    const { ctx, tools } = makeCtx();
    mod.apply(ctx, {});
    assert.equal(Object.keys(tools).length, 0);

    fs.writeFileSync(CONFIG, '{ invalid json');
    const mod2 = await loadPlugin();
    const c2 = makeCtx();
    mod2.apply(c2.ctx, {});
    assert.equal(Object.keys(c2.tools).length, 0);
    assert.ok(fs.existsSync(STATE_FILE));
  });

  await check('close_all_tabs 预建空白页失败 → 中止且不关闭现有标签页', async () => {
    writeConfig({ desktop: { enabled: true } });
    const mod = await loadPlugin();
    const { ctx, tools } = makeCtx();
    mod.apply(ctx, {});
    const closed = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/json')) return { ok: true, json: async () => [{ id: 'A', type: 'page', url: 'https://a.example' }] };
      if (u.includes('/json/new')) return { ok: false, status: 500, json: async () => ({}) };
      if (u.includes('/json/close/')) { closed.push(u); return { ok: true, json: async () => ({}) }; }
      return { ok: true, json: async () => ({}) };
    };
    const r = await tools.browser_control.execute({ action: 'close_all_tabs' }, { signal: null });
    assert.equal(r.ok, false);
    assert.equal(closed.length, 0);
  });

  await check('CDP 响应超时：无关事件不得清超时', async () => {
    writeConfig({ desktop: { enabled: true, enableCdp: true, cdpPort: 9222 } });
    const mod = await loadPlugin();
    const { ctx, tools } = makeCtx();
    mod.apply(ctx, {});
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/__internal/desktop/start')) return { ok: true, json: async () => ({ ok: true }) };
      if (u.includes('/json/version')) return { ok: true, json: async () => ({}) };
      if (u.endsWith('/json')) return { ok: true, json: async () => [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/T1' }] };
      if (u.includes('/json/activate/')) return { ok: true, json: async () => ({}) };
      if (u.includes('/json/new')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    };
    class FakeWS {
      constructor() { this.onopen = null; this.onmessage = null; this.onerror = null; }
      send() {
        setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
        setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify({ method: 'Page.frameNavigated', params: {} }) }); }, 20);
      }
      close() {}
    }
    globalThis.WebSocket = FakeWS;
    const t0 = Date.now();
    const raced = await Promise.race([
      tools.browser_open.execute({ url: 'https://example.com', tabId: 'T1' }, { signal: null }).then((r) => ({ r }), (e) => ({ e })),
      sleep(12000).then(() => ({ timeout: true }))
    ]);
    assert.ok(!raced.timeout && Date.now() - t0 < 10000);
  });

  await check('注册失败后有限次退避重试成功', async () => {
    writeConfig({ desktop: { enabled: true } });
    const mod = await loadPlugin();
    let attempts = 0;
    const tools = {};
    mod.apply({
      tools: {
        register: (t) => {
          attempts++;
          if (attempts === 1) throw new Error('模拟首次失败');
          tools[t.name] = t;
          return () => { delete tools[t.name]; };
        }
      },
      systemPrompt: { section: () => () => {} },
      settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
      on: () => {}
    }, {});
    assert.equal(Object.keys(tools).length, 0);
    await sleep(3200);
    assert.deepEqual(Object.keys(tools).sort(), ['browser_control', 'browser_open', 'browser_screenshot']);
  });

  await check('plugins/dsh-browser-desktop/client.js 具备超时、重叠守卫、自有样式命名空间与侧栏向导图标', async () => {
    const src = fs.readFileSync(CLIENT, 'utf8');
    assert.ok(/AbortSignal\.timeout\(5000\)/.test(src));
    assert.ok(/pollDesktopStatus/.test(src) && /desktopPollInFlight/.test(src));
    assert.ok(/cleanupGlobals/.test(src));
    assert.ok(!/:has\(/.test(src));
    assert.ok(/dsbd-section-card/.test(src));
    assert.ok(/GuideArtworkContainerDesktop/.test(src));

    // Execute client module factory in isolated mock environment to verify guide icon & id contract
    let capturedFactory = null;
    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    try {
      globalThis.window = {
        __ModuleLoader__: { load: (def) => { capturedFactory = def.factory; } },
        navigator: { language: 'zh-CN' },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {}
      };
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ desktop: { enabled: true, enableSidebarTab: true }, paths: { admin: '/admin', vnc: '/vnc' } })
      });
      const fn = new Function(src);
      fn();
      assert.equal(typeof capturedFactory, 'function');

      const mockReact = {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: (init) => [init, () => {}],
        useEffect: () => {},
        useLayoutEffect: () => {},
        useRef: (init) => ({ current: init })
      };
      const exported = capturedFactory((modName) => {
        if (modName === 'react') return mockReact;
        throw new Error('Unexpected require: ' + modName);
      });

      let registeredTabDef = null;
      const mockScopedCtx = {
        sidebarRight: { openTab: () => {} },
        sidebarRightTabs: { register: (def) => { registeredTabDef = def; return () => {}; } },
        slots: { inject: () => {}, register: () => () => {} }
      };
      exported.apply({
        slots: { inject: () => {}, register: () => () => {} },
        inject: (_deps, cb) => cb(mockScopedCtx)
      });
      await sleep(30);

      assert.ok(registeredTabDef, 'sidebarRightTabs.register 应被调用');
      assert.equal(Array.isArray(registeredTabDef.guide), true);
      assert.equal(registeredTabDef.guide[0].id, 'desktop');
      assert.equal(registeredTabDef.guide[0].title(), '容器浏览器桌面');
      assert.equal(typeof registeredTabDef.guide[0].icon, 'function');

      const svgTree = registeredTabDef.guide[0].icon({ size: 22, className: 'guide-icon' });
      assert.equal(svgTree.type, 'svg');
      assert.equal(svgTree.props.viewBox, '0 0 36 36');
      assert.equal(svgTree.props.width, 22);
      assert.equal(svgTree.props.height, 22);
      assert.equal(svgTree.props.className, 'guide-icon');
      assert.ok(svgTree.children.length >= 4);
    } finally {
      if (prevWindow === undefined) delete globalThis.window;
      else globalThis.window = prevWindow;
      globalThis.fetch = prevFetch;
    }
  });

  console.log('\n[前端 v1.0.0 模块化模板与 JS 回归]');
  const uiJsFiles = walkJs(path.join(ROOT, 'gateway/public/ui/js'));
  const allUiJs = uiJsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  await check('模块化前端 JS 无原生 confirm() 与无 innerHTML', () => {
    assert.ok(!/\bconfirm\s*\(/.test(allUiJs), '不应使用原生 confirm()');
    assert.ok(!/\.innerHTML\b/.test(allUiJs), '不应使用 innerHTML');
  });

  await check('API 客户端具备统一超时控制与结构化错误处理', () => {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'gateway/public/ui/js/lib/api.js'), 'utf8');
    assert.ok(/AbortController|AbortSignal\.timeout|timeout/.test(apiSrc));
    assert.ok(/errorCode/.test(apiSrc));
  });

  await check('登录、初始化、管理后台与锁定模板统一使用 /favicon.svg 品牌标识', () => {
    for (const tpl of ['admin.html', 'login.html', 'setup.html', 'locked.html']) {
      const html = fs.readFileSync(path.join(ROOT, 'gateway/public/templates', tpl), 'utf8');
      assert.ok(html.includes('/favicon.svg'), `${tpl} 应引用 /favicon.svg`);
    }
  });
} finally {
  globalThis.fetch = realFetch;
  if (realWebSocket) globalThis.WebSocket = realWebSocket;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
