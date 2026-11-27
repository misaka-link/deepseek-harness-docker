#!/usr/bin/env node
/**
 * dsh-browser-desktop 「权威配置」单元测试。
 * 用法: node tests/unit/plugin-enabled.test.mjs
 */
import '../helpers/schemastery-stub.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cfg-'));
const CFG = path.join(TMP, 'gateway.config.json');
process.env.GATEWAY_CONFIG_FILE = CFG;
process.env.PROXY_PORT = '9';
const writeCfg = (desktop) => fs.writeFileSync(CFG, JSON.stringify({ desktop, vncPath: '/vnc' }, null, 2));

const PLUGIN = pathToFileURL(path.join(root, 'plugins/dsh-browser-desktop/index.js')).href;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; throw new Error('断言失败: ' + msg); }
}

function makeCtx() {
  const state = { tools: new Map(), prompt: new Map(), disposeHandlers: [], settingsRegisterCalls: 0, legacySection: undefined };
  const ctx = {
    tools: { register: (def) => { state.tools.set(def.name, def); return () => state.tools.delete(def.name); } },
    systemPrompt: { section: (s) => { state.prompt.set(s.name, s); return () => state.prompt.delete(s.name); } },
    settings: {
      register: () => { state.settingsRegisterCalls++; return { get: () => ({}), watch: () => (() => {}) }; },
      section: () => state.legacySection
    },
    on: (event, cb) => { if (event === 'dispose') state.disposeHandlers.push(cb); }
  };
  return { ctx, state };
}

const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mark-'));
try {
  const mod = await import(PLUGIN);
  writeCfg({ enabled: true, width: 1920, height: 1080, enableCdp: true, cdpPort: 9222, idleTimeoutMinutes: 30, screenshotQuality: 'high', screenshotDir: '', enableSidebarTab: false });

  const A = makeCtx();
  mod.apply(A.ctx, {});
  ok(A.state.tools.size === 3 && A.state.prompt.has('tool:browser_tools') && A.state.settingsRegisterCalls === 0, 'A. 启用态注册 3 工具 + 提示词且不注册幽灵命名空间');

  writeCfg({ enabled: false });
  const err = await A.state.tools.get('browser_open').execute({ url: 'https://example.com' }, {}).then(() => null, (e) => e);
  ok(err && /停用/.test(err.message) && A.state.tools.size === 0, 'B. 停用后立即拒绝调用并注销工具');

  writeCfg({ enabled: true });
  const C = makeCtx();
  mod.apply(C.ctx, {});
  ok(C.state.tools.size === 3 && C.state.prompt.has('tool:browser_tools'), 'C. 重新启用后恢复');

  writeCfg({ enabled: false });
  const D = makeCtx();
  mod.apply(D.ctx, {});
  ok(D.state.tools.size === 0 && !D.state.prompt.has('tool:browser_tools'), 'D. 启动时停用态零注册');

  fs.rmSync(CFG);
  const E = makeCtx();
  mod.apply(E.ctx, {});
  ok(E.state.tools.size === 3, 'E. 配置文件缺失按默认启用');

  E.state.disposeHandlers.forEach((h) => h());
  ok(E.state.tools.size === 0 && !E.state.prompt.has('tool:browser_tools'), 'F. dispose 清理完成');

  process.env.BROWSER_DESKTOP_LEGACY_MARKER = path.join(markDir, 'm1');
  process.env.BROWSER_DESKTOP_LEGACY_MARKER_FALLBACK = path.join(markDir, 'm2');
  writeCfg({ enabled: true });
  let sectionCalls = 0;
  const G = makeCtx();
  G.ctx.settings.section = () => { sectionCalls++; return undefined; };
  mod.apply(G.ctx, {});
  await new Promise((r) => setTimeout(r, 50));
  ok(G.state.settingsRegisterCalls === 0 && sectionCalls === 1 && fs.existsSync(process.env.BROWSER_DESKTOP_LEGACY_MARKER), 'G. 旧值迁移只读原始 section 并落幂等标记');
} finally {
  fs.rmSync(markDir, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
