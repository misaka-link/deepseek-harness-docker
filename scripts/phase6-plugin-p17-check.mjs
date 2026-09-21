/**
 * P17 容器内验证：权威配置「不存在 / 停用 / 解析失败」三种情形下工具注册行为。
 * 使用临时配置文件，绝不触碰线上 /root/.dsh/gateway.config.json。
 * 用法（容器内）: node /tmp/phase6-plugin-p17-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p17-'));
const CFG = path.join(tmp, 'gateway.config.json');
const STATE = path.join(tmp, '.browser-desktop-last-state.json');
process.env.GATEWAY_CONFIG_FILE = CFG;
process.env.BROWSER_DESKTOP_STATE_FILE = STATE;
process.env.DSH_INTERNAL_TOKEN_FILE = path.join(tmp, '.tok');
fs.writeFileSync(process.env.DSH_INTERNAL_TOKEN_FILE, 'x\n', { mode: 0o600 });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('   ✔ ' + m); } else { fail++; console.log('   ❌ ' + m); } };

function makeCtx() {
  const registered = {};
  const ctx = {
    tools: { register: (t) => { registered[t.name] = t; return () => { delete registered[t.name]; }; } },
    systemPrompt: { section: () => () => {} },
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }), section: () => undefined },
    on: () => {}
  };
  return { ctx, registered };
}

// 优先使用仓库源：容器内 /app 是构建期烤进去的副本，仓库更新后它可能落后，
// 之前固定 import /app 会对着陈旧副本断言并误报失败（实测 1/4 vs 仓库源 4/4）。
const PLUGIN_ENTRY = [
  process.env.DSH_PLUGIN_ENTRY,
  path.resolve(process.cwd(), 'plugins/dsh-browser-desktop/index.js'),
  '/app/plugins/dsh-browser-desktop/index.js'
].filter(Boolean).find((p) => fs.existsSync(p));

async function freshPlugin() {
  if (!PLUGIN_ENTRY) throw new Error('找不到 dsh-browser-desktop/index.js（可用 DSH_PLUGIN_ENTRY 指定）');
  return await import(PLUGIN_ENTRY + '?t=' + Date.now() + Math.random());
}

// A. 配置不存在 → 保持当前状态（默认启用）
try { fs.unlinkSync(CFG); } catch {}
{
  const mod = await freshPlugin();
  const { ctx, registered } = makeCtx();
  mod.apply(ctx, {});
  ok(Object.keys(registered).length === 3, 'A 配置不存在 → 注册 3 个工具（默认启用）');
}

// B. 显式停用 → 不注册，并落盘"上次成功状态"
fs.writeFileSync(CFG, JSON.stringify({ desktop: { enabled: false } }));
{
  const mod = await freshPlugin();
  const { ctx, registered } = makeCtx();
  mod.apply(ctx, {});
  ok(Object.keys(registered).length === 0, 'B enabled:false → 不注册任何工具');
  ok(fs.existsSync(STATE), 'B 已落盘上次成功状态文件');
}

// C. 配置被写坏 + 进程重启（新实例，内存无快照）→ 必须回退到落盘的停用状态
fs.writeFileSync(CFG, '{ broken json');
{
  const mod = await freshPlugin();
  const { ctx, registered } = makeCtx();
  mod.apply(ctx, {});
  ok(Object.keys(registered).length === 0, 'C JSON 损坏 → 保持停用（不得回退为启用）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`===== P17 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
