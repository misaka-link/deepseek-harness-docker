#!/usr/bin/env node
/**
 * 截图保存路径的工作区边界防逃逸单元测试（通过桩 fetch/WebSocket 完全离线执行）。
 * 用法: node tests/unit/screenshot-path-guard.test.mjs
 */
import '../helpers/schemastery-stub.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const PLUGIN = path.join(root, 'plugins/dsh-browser-desktop/index.js');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shot-guard-'));
const WS = path.join(tmpBase, 'workspace');
const ESC_DIR = path.join(tmpBase, 'outside');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(ESC_DIR, { recursive: true });

const CFG = path.join(tmpBase, 'gateway.config.json');
const TOK = path.join(tmpBase, '.internal-api-token');
fs.writeFileSync(CFG, JSON.stringify({ desktop: { enabled: true, enableCdp: true, cdpPort: 9222 }, vncPath: '/vnc' }));
fs.writeFileSync(TOK, 'shot-test-token\n', { mode: 0o600 });
process.env.GATEWAY_CONFIG_FILE = CFG;
process.env.DSH_INTERNAL_TOKEN_FILE = TOK;

const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
const PNG_1X1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/__internal/desktop/start')) return { ok: true, json: async () => ({ ok: true }) };
  if (u.endsWith('/json')) {
    return {
      ok: true,
      json: async () => [{ id: 'P1', type: 'page', title: 'Mock', url: 'https://example.com', webSocketDebuggerUrl: 'ws://mock/P1' }]
    };
  }
  return { ok: true, json: async () => ({}) };
};

class MockShotWS {
  constructor() {
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
  }
  send(raw) {
    const msg = JSON.parse(raw);
    setTimeout(() => {
      if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, result: { data: PNG_1X1_B64 } }) });
    }, 5);
  }
  close() {}
}
globalThis.WebSocket = MockShotWS;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

try {
  const mod = await import(pathToFileURL(PLUGIN).href);
  const tools = {};
  mod.apply({
    tools: { register: (t) => { tools[t.name] = t; return () => delete tools[t.name]; } },
    systemPrompt: { section: () => () => {} },
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
    on: () => {}
  }, {});
  const exec = { signal: null, agent: { session: { header: { cwd: WS } } } };

  const esc1 = path.join(ESC_DIR, 'escape-abs.png');
  const r1 = await tools.browser_screenshot.execute({ savePath: esc1 }, exec);
  ok(!fs.existsSync(esc1) && String(r1.path).startsWith(WS), 'A. 越界绝对路径被拦回工作区内');

  const esc2 = path.join(ESC_DIR, 'escape-dotdot.png');
  const r2 = await tools.browser_screenshot.execute({ savePath: '../outside/escape-dotdot.png' }, exec);
  ok(!fs.existsSync(esc2) && String(r2.path).startsWith(WS), 'B. ../ 越界被拦回工作区内');

  fs.symlinkSync(ESC_DIR, path.join(WS, 'link-out'));
  const esc3 = path.join(ESC_DIR, 'escape-symlink.png');
  const r3 = await tools.browser_screenshot.execute({ savePath: 'link-out/escape-symlink.png' }, exec);
  ok(!fs.existsSync(esc3) && String(r3.path).startsWith(WS), 'C. 符号链接逃逸被识破并拦回工作区');

  const r4 = await tools.browser_screenshot.execute({ savePath: 'shot/ok.png' }, exec);
  ok(fs.existsSync(r4.path) && String(r4.path).startsWith(WS), 'D. 正常工作区内相对路径成功写入');
} finally {
  globalThis.fetch = realFetch;
  if (realWebSocket) globalThis.WebSocket = realWebSocket;
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
