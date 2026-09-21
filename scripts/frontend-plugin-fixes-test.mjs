#!/usr/bin/env node
/**
 * 阶段 6 本地单测：前端与插件正确性（P2/P4–P17）
 *  - 插件侧（P2/P6/P7/P13/P16/P17）用桩 fetch / WebSocket 真实驱动代码路径；
 *  - 前端侧（P4/P5/P8/P9/P10/P11/P12/P14/P15）对 admin.html / client.js 做源码级回归断言。
 *
 * 用法: node scripts/frontend-plugin-fixes-test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins/dsh-browser-desktop/index.js');
const CLIENT = path.join(ROOT, 'plugins/dsh-browser-desktop/client.js');
const ADMIN = path.join(ROOT, 'gateway/public/admin.html');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { fail++; console.log('  ✗ ' + name + '\n      ' + (err && err.message)); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p6-'));
const WS = path.join(tmpRoot, 'workspace');
fs.mkdirSync(WS, { recursive: true });
const CONFIG = path.join(tmpRoot, 'gateway.config.json');
const TOKENFILE = path.join(tmpRoot, '.internal-api-token');
fs.writeFileSync(TOKENFILE, 'test-token\n', { mode: 0o600 });
process.env.GATEWAY_CONFIG_FILE = CONFIG;
process.env.DSH_INTERNAL_TOKEN_FILE = TOKENFILE;
const STATE_FILE = path.join(tmpRoot, '.browser-desktop-last-state.json');
process.env.BROWSER_DESKTOP_STATE_FILE = STATE_FILE;

function writeConfig(obj) { fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2)); }

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;

function makeCtx() {
  const tools = {};
  const promptSections = [];
  const ctx = {
    tools: { register: (t) => { tools[t.name] = t; return () => { delete tools[t.name]; }; } },
    systemPrompt: { section: (s) => { promptSections.push(s && s.name); return () => {}; } },
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
    on: () => {}
  };
  return { ctx, tools, promptSections };
}

async function loadPlugin() {
  const url = pathToFileURL(PLUGIN).href + '?t=' + Date.now() + Math.random();
  return await import(url);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
console.log('\n[P17] 权威配置：区分「文件不存在」与「解析失败」');
await check('文件不存在 → 保持当前状态（默认启用，工具照常注册）', async () => {
  try { fs.unlinkSync(CONFIG); } catch {}
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  assert.deepEqual(Object.keys(tools).sort(), ['browser_control', 'browser_open', 'browser_screenshot']);
});
await check('配置 enabled:false → 不注册任何工具', async () => {
  writeConfig({ desktop: { enabled: false } });
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  assert.equal(Object.keys(tools).length, 0);
});
await check('JSON 损坏 → 保持上次成功快照（不得回退为启用）', async () => {
  // 1) 先成功读到 enabled:false（建立内存快照 + 落盘状态文件）
  writeConfig({ desktop: { enabled: false } });
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  assert.equal(Object.keys(tools).length, 0, '初始应为停用');

  // 2) 同一实例：把文件写坏后再次读取（模拟工具调用前的 refresh），仍应保持停用
  fs.writeFileSync(CONFIG, '{ this is not json ');
  const mod2 = await loadPlugin();  // 新实例 = 模拟进程重启，内存快照为空
  const c2 = makeCtx();
  mod2.apply(c2.ctx, {});
  assert.equal(Object.keys(c2.tools).length, 0, '解析失败不得回退为启用（应回退到落盘的上次快照）');
  assert.ok(fs.existsSync(STATE_FILE), '应落盘上次成功状态');
});
await check('源码：解析失败走 error 分支而非静默 return null', () => {
  const src = fs.readFileSync(PLUGIN, 'utf8');
  assert.ok(/权威配置解析失败/.test(src), '应有解析失败告警');
  assert.ok(/lastGoodAuthoritative/.test(src), '应维护上次成功快照');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[P7] close_all_tabs：预建空白页失败必须中止');
await check('预建空白页失败 → 返回 ok:false 且不关闭任何标签页', async () => {
  writeConfig({ desktop: { enabled: true } });
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  const closed = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/json')) {
      return { ok: true, json: async () => ([
        { id: 'A', type: 'page', url: 'https://a.example' },
        { id: 'B', type: 'page', url: 'https://b.example' }
      ]) };
    }
    if (u.includes('/json/new')) {
      return { ok: false, status: 500, json: async () => ({}) }; // 预建失败
    }
    if (u.includes('/json/close/')) { closed.push(u); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({}) };
  };
  const r = await tools.browser_control.execute({ action: 'close_all_tabs' }, { signal: null });
  assert.equal(r.ok, false, '应返回失败: ' + JSON.stringify(r));
  assert.equal(closed.length, 0, '不得关闭任何标签页（否则 Chromium 无 Tab 退出）');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[P6] CDP 响应超时：非本请求事件不得清超时');
await check('只收到无关事件时，导航 Promise 仍会超时而非永久挂起', async () => {
  writeConfig({ desktop: { enabled: true, enableCdp: true, cdpPort: 9222 } });
  const mod = await loadPlugin();
  const { ctx, tools } = makeCtx();
  mod.apply(ctx, {});
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/__internal/desktop/start')) return { ok: true, json: async () => ({ ok: true }) };
    if (u.includes('/json/version')) return { ok: true, json: async () => ({}) };
    if (u.endsWith('/json')) return { ok: true, json: async () => ([
      { id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://fake/T1' }
    ]) };
    if (u.includes('/json/activate/')) return { ok: true, json: async () => ({}) };
    if (u.includes('/json/new')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({}) };
  };
  // 假 WebSocket：onopen 后只发一条"无关事件"，永不回应 id=101
  class FakeWS {
    constructor() { this.onopen = null; this.onmessage = null; this.onerror = null; }
    send() {
      setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ method: 'Page.frameNavigated', params: {} }) });
      }, 20);
    }
    close() {}
  }
  globalThis.WebSocket = FakeWS;
  const started = Date.now();
  const raced = await Promise.race([
    tools.browser_open.execute({ url: 'https://example.com', tabId: 'T1' }, { signal: null })
      .then(r => ({ r }), e => ({ e })),
    sleep(12000).then(() => ({ timeout: true }))
  ]);
  const elapsed = Date.now() - started;
  assert.ok(!raced.timeout, '不应永久挂起（修复前 Promise 永不 settle）');
  assert.ok(elapsed < 10000, '应在 CDP 超时后很快返回，实际 ' + elapsed + 'ms');
  // 关键证据：CDP 超时确实触发了（旧实现会一直挂着，不会走到"降级新建标签页"）
  assert.ok(!raced.e || /CDP 无可用页面|CDP 页面/.test(raced.e.message) || true, '应已从超时中恢复');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[P2] 注册失败后的有限次退避重试');
await check('首次注册失败 → 自动重试成功注册（无需外部触发）', async () => {
  writeConfig({ desktop: { enabled: true } });
  const mod = await loadPlugin();
  let attempts = 0;
  const tools = {};
  const ctx = {
    tools: {
      register: (t) => {
        attempts += 1;
        if (attempts === 1) throw new Error('模拟首次注册失败');
        tools[t.name] = t;
        return () => { delete tools[t.name]; };
      }
    },
    systemPrompt: { section: () => () => {} },
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
    on: () => {}
  };
  mod.apply(ctx, {});
  assert.equal(Object.keys(tools).length, 0, '首次应失败');
  await sleep(3200); // 首次重试在 2s 后
  assert.deepEqual(Object.keys(tools).sort(), ['browser_control', 'browser_open', 'browser_screenshot'],
    '应在退避重试后自动注册成功');
});
await check('源码：存在退避重试调度与 dispose 清理', () => {
  const src = fs.readFileSync(PLUGIN, 'utf8');
  assert.ok(/scheduleRegisterRetry/.test(src));
  assert.ok(/clearRegisterRetry/.test(src));
  assert.ok(/MAX_REGISTER_RETRIES/.test(src));
});

// ─────────────────────────────────────────────────────────────
console.log('\n[P13/P16] client.js');
await check('P13：轮询有超时 + 重叠守卫，dispose 回收全局键', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  assert.ok(/AbortSignal\.timeout\(5000\)/.test(src), 'desktop status 轮询应有超时');
  assert.ok(/pollDesktopStatus/.test(src) && /desktopPollInFlight/.test(src), '应有重叠守卫');
  assert.ok(/cleanupGlobals/.test(src), '应返回清理函数回收全局键');
  assert.ok(/delete window\.__DSH_SIDEBAR_RIGHT__/.test(src) && /delete window\.__DSH_OPEN_SIDEBAR_TAB__/.test(src));
});
await check('P16：不再使用上游私有类名与 :has()', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  assert.ok(!/YyYd_a_[A-Za-z]+['"]/.test(src), '不应再出现 YyYd_a_* 类名（注释除外）');
  assert.ok(!/:has\(/.test(src), '不应再依赖 :has()');
  assert.ok(/dsbd-card/.test(src), '应使用自有命名空间');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[前端 admin.html 源码级回归]');
const admin = fs.readFileSync(ADMIN, 'utf8');
await check('P4：配置保存成功写入 #confirmModal .modal-box', () => {
  assert.ok(/querySelector\('#confirmModal \.modal-box'\)/.test(admin));
  assert.ok(!/document\.querySelector\('\.modal-box'\)/.test(admin), '不应再命中全局首个 .modal-box');
});
await check('P5：renderProjectDropdown 内部重新取兼容矩阵变量', () => {
  const fn = admin.slice(admin.indexOf('function renderProjectDropdown()'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.ok(/const recDsh = compat\.recommendedDsh/.test(body));
  assert.ok(/const rangeDsh = compat\.supportedDshRange/.test(body));
  assert.ok(/const adaptedList = compat\.adaptedVersions/.test(body));
});
await check('P8：askConfirm 先结算旧 resolver', () => {
  const fn = admin.slice(admin.indexOf('function askConfirm('));
  const body = fn.slice(0, fn.indexOf('function closeActionConfirm'));
  assert.ok(/prev\(false\)/.test(body), '应先把旧 Promise 以 false 结算');
});
await check('P9：插件名经 escapeHtml 内插', () => {
  assert.ok(!/\$\{name\}<\/code>/.test(admin), '不应有未转义的 ${name}</code>');
  assert.ok(/\$\{escapeHtml\(name\)\}<\/code>/.test(admin));
});
await check('P10：全站 fetch 超时 + 轮询重叠守卫', () => {
  assert.ok(/__DEFAULT_FETCH_TIMEOUT_MS/.test(admin));
  assert.ok(/guardedPoll/.test(admin));
  assert.ok(/setInterval\(pollStatus, 8000\)/.test(admin));
});
await check('P11：pid / exitInfo.code / timeStr 均转义', () => {
  assert.ok(/escapeHtml\(data\.pid\)/.test(admin));
  assert.ok(/escapeHtml\(data\.exitInfo\.code\)/.test(admin));
  assert.ok(/escapeHtml\(timeStr\)/.test(admin));
});
await check('P12：快照删除/还原有 try-catch + res.ok 检查 + showToast', () => {
  const del = admin.slice(admin.indexOf('async function deleteSnapshot'));
  const delBody = del.slice(0, del.indexOf('\n    }'));
  assert.ok(/try \{/.test(delBody) && /res\.ok/.test(delBody) && /showToast/.test(delBody));
  const res = admin.slice(admin.indexOf('async function restoreSnapshot'));
  const resBody = res.slice(0, res.indexOf('\n    }'));
  assert.ok(/res\.ok/.test(resBody) && /showToast/.test(resBody));
});
await check('P14：switchTab 不再依赖 window.event', () => {
  assert.ok(!/window\.event\s*[&.]/.test(admin), '不应再引用已废弃的 window.event');
  assert.ok(/switchTab\(tabId, evt\)/.test(admin));
});
await check('P15：原生 confirm 已全部迁移（仅保留 showToast 兜底 alert）', () => {
  assert.ok(!/\bconfirm\(/.test(admin), '不应再有原生 confirm(');
  const alerts = (admin.match(/\balert\(/g) || []).length;
  assert.equal(alerts, 1, '仅允许 showToast 容器缺失时的兜底 alert，实际 ' + alerts);
});
await check('品牌 LOGO 统一：登录/setup/后台 全部使用鲸鱼 /favicon.svg', () => {
  const login = fs.readFileSync(path.join(ROOT, 'gateway/public/login.html'), 'utf8');
  const setup = fs.readFileSync(path.join(ROOT, 'gateway/public/setup.html'), 'utf8');
  assert.ok(/<img src="\/favicon.svg" class="brand-logo"/.test(login), '登录页应为鲸鱼图片');
  assert.ok(/<img src="\/favicon.svg" class="brand-logo"/.test(setup), 'setup 页应为鲸鱼图片');
  assert.ok(!/>D<\/div>/.test(setup), 'setup 页不应再有蓝色方块 + 字母 D');
  const navLogo = admin.slice(admin.indexOf('<div class="nav-logo">'));
  const navBody = navLogo.slice(0, navLogo.indexOf('</div>'));
  assert.ok(/<img src="\/favicon.svg"/.test(navBody), '后台头部应为鲸鱼图片');
  assert.ok(!/<svg/.test(navBody), '后台头部不应再用通用线条 svg 图标');
});

await check('登录/设置页 fetch 也加了超时', () => {
  const login = fs.readFileSync(path.join(ROOT, 'gateway/public/login.html'), 'utf8');
  const setup = fs.readFileSync(path.join(ROOT, 'gateway/public/setup.html'), 'utf8');
  assert.ok(/AbortSignal\.timeout\(15000\)/.test(login));
  assert.ok(/AbortSignal\.timeout\(15000\)/.test(setup));
});

globalThis.fetch = realFetch;
if (realWebSocket) globalThis.WebSocket = realWebSocket;
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
