/**
 * dsh-browser-desktop 「权威配置」单元测试（无需 X / 无需网关，本地直接运行）。
 *
 * 新模型（按用户方案）：
 *   - 权威配置 = 网关持久化文件 gateway.config.json（不再轮询、不再 HTTP 同步）；
 *   - 插件在【启动时】与【每次工具调用前】同步读该文件；
 *   - 因此：关闭后调用会被立即拒绝；菜单的增/减在【服务重启（重新 apply）】时确定。
 *
 * 用法: node scripts/plugin-enabled-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cfg-'));
const CFG = path.join(TMP, 'gateway.config.json');
process.env.GATEWAY_CONFIG_FILE = CFG;
// 隔离副作用：插件在"停用"时会对网关发一次 stop。把内部网关指向一个必然连不上的端口，
// 使本单测完全"零副作用"（在真实容器里跑也不会把线上桌面停掉）。
process.env.PROXY_PORT = '9';
const writeCfg = (desktop) => fs.writeFileSync(CFG, JSON.stringify({ desktop, vncPath: '/vnc' }, null, 2));

const PLUGIN = new URL('../plugins/dsh-browser-desktop/index.js', import.meta.url).href;

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
    // 新模型：插件【不再注册】DSH 设置命名空间（register 仅用于断言"没被调用"），
    // 旧值迁移只读原始 user section。
    settings: {
      register: () => { state.settingsRegisterCalls++; return { get: () => ({}), watch: () => (() => {}) }; },
      section: () => state.legacySection
    },
    on: (event, cb) => { if (event === 'dispose') state.disposeHandlers.push(cb); }
  };
  return { ctx, state };
}

async function main() {
  const mod = await import(PLUGIN);
  writeCfg({ enabled: true, width: 1920, height: 1080, enableCdp: true, cdpPort: 9222, idleTimeoutMinutes: 30, screenshotQuality: 'high', screenshotDir: '', enableSidebarTab: false });

  console.log('\n=== A. 配置为启用：启动即注册 3 个工具 + 注入提示词（无需任何等待） ===');
  const A = makeCtx();
  mod.apply(A.ctx, {});
  ok(A.state.tools.size === 3, '注册了 3 个浏览器工具');
  ok(A.state.prompt.has('tool:browser_tools'), '注入了系统提示词段');
  ok(A.state.settingsRegisterCalls === 0, '未注册 DSH 设置命名空间（杜绝"改了没用"的幽灵配置）');

  console.log('\n=== B. 管理后台改成停用 → 再调用会被立即拒绝（读本地文件，零网络） ===');
  writeCfg({ enabled: false });
  const err = await A.state.tools.get('browser_open').execute({ url: 'https://example.com' }, {}).then(() => null, e => e);
  ok(err && /停用/.test(err.message), '调用被拒绝且报错清晰: ' + (err && err.message));
  ok(A.state.tools.size === 0, '同时已注销全部工具（该实例不再持有）');

  console.log('\n=== C. 重新启用 + 服务重启（重新 apply）→ 工具恢复 ===');
  writeCfg({ enabled: true });
  const C = makeCtx();
  mod.apply(C.ctx, {});
  ok(C.state.tools.size === 3, '重启后恢复注册 3 个工具');
  ok(C.state.prompt.has('tool:browser_tools'), '提示词段恢复注入');

  console.log('\n=== D. 启动时已是停用态 → 零注册（重启后菜单即准确） ===');
  writeCfg({ enabled: false });
  const D = makeCtx();
  mod.apply(D.ctx, {});
  ok(D.state.tools.size === 0, '不注册任何工具');
  ok(!D.state.prompt.has('tool:browser_tools'), '不注入提示词段');

  console.log('\n=== E. 配置文件缺失/损坏时保持默认（启用），不误伤 ===');
  fs.rmSync(CFG);
  const E = makeCtx();
  mod.apply(E.ctx, {});
  ok(E.state.tools.size === 3, '读不到配置时按默认启用处理');

  console.log('\n=== F. dispose 清理 ===');
  E.state.disposeHandlers.forEach(h => h());
  ok(E.state.tools.size === 0, 'dispose 后工具已注销');
  ok(!E.state.prompt.has('tool:browser_tools'), 'dispose 后提示词段已移除');

  console.log('\n=== G. 幽灵配置清理：迁移只读原始 section，不再注册命名空间 ===');
  const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mark-'));
  process.env.BROWSER_DESKTOP_LEGACY_MARKER = path.join(markDir, 'm1');
  process.env.BROWSER_DESKTOP_LEGACY_MARKER_FALLBACK = path.join(markDir, 'm2');
  writeCfg({ enabled: true });
  let sectionCalls = 0;
  const G = makeCtx();
  G.ctx.settings.section = (ns) => { sectionCalls++; return undefined; };
  mod.apply(G.ctx, {});
  await new Promise(r => setTimeout(r, 50));
  ok(G.state.settingsRegisterCalls === 0, '仍然不注册命名空间');
  ok(sectionCalls === 1, '迁移读取了原始 section(browser-desktop)');
  ok(fs.existsSync(process.env.BROWSER_DESKTOP_LEGACY_MARKER), '无旧值时也会落迁移标记（幂等，只跑一次）');

  fs.rmSync(markDir, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('测试异常:', err.message); process.exit(1); });
