/**
 * P6（语义面）回归测试：装配脚本必须尊重"外部写者"（DSH 原生插件管理器）的插件状态。
 *
 * 背景：原生插件管理器启停插件时只改 bundles，不写我们的 plugins-state.json。
 * 旧行为下，容器重启时 install-plugin.mjs 会把"依赖仍在、但已从 bundles 移除"的插件
 * 当成"从未装配"而自动装回去 —— 静默回退用户的停用决定（已在远程实测复现）。
 *
 * 覆盖（驱动真实 scripts/install-plugin.mjs，使用临时 DSH_HOME 与临时 market 根目录）：
 *   A. 全新数据卷：预装插件应被自动装配（开箱即用不被破坏）
 *   B. 外部停用（deps 有 + bundles 无）：不得复活，并写入 plugins-state.json
 *   C. 外部卸载（deps 无 + bundles 无 + known 有）：不得复活，并标记 uninstalled
 *   D. 外部重新启用（deps 有 + bundles 有）：清除我们的 disabled/uninstalled 标记
 *   E. 我们自己的停用（Admin 路径）：仍然保持停用
 *
 * 用法: node scripts/manifest-reconcile-test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(ROOT, 'scripts/install-plugin.mjs');
const BD = '@dsh-custom/dsh-browser-desktop';
const MARKET = ['dshmarket', '@hytime/dsh-thinking-effort'];

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-reconcile-'));
const marketRoot = path.join(tmpRoot, 'market-root');
for (const p of MARKET) {
  fs.mkdirSync(path.join(marketRoot, p), { recursive: true });
  fs.writeFileSync(path.join(marketRoot, p, 'package.json'), JSON.stringify({ name: p, version: '1.0.0' }, null, 2) + '\n');
}
// 内置插件源（与镜像内 /app/plugins/dsh-browser-desktop 对应）
const pluginSource = path.join(tmpRoot, 'app-plugins/dsh-browser-desktop');
fs.mkdirSync(pluginSource, { recursive: true });
fs.writeFileSync(path.join(pluginSource, 'package.json'), JSON.stringify({ name: BD, version: '0.1.1' }, null, 2) + '\n');

function makeHome(name, { deps = [], bundles = [], state = null } = {}) {
  const home = path.join(tmpRoot, name);
  const profileDir = path.join(home, '.dsh/profiles/web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: Object.fromEntries(deps.map((d) => [d, 'link:' + path.join(marketRoot, d)])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...bundles] } }
  }, null, 2) + '\n');
  if (state) {
    fs.writeFileSync(path.join(home, '.dsh/plugins-state.json'), JSON.stringify(state, null, 2) + '\n');
  }
  return { home, profileDir };
}

function runInstaller({ home, profileDir }) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE_DIR: profileDir,
      DSH_MARKET_PLUGIN_ROOT: marketRoot,
      // 让内置插件也走临时源目录：脚本里 customPath 固定为 /app/plugins，
      // 本地不存在时会跳过软链但依然按 bundles 逻辑处理，这里用软链目录兜底
    },
    encoding: 'utf8'
  });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

const readBundles = (profileDir) => JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles;
const readState = (home) => {
  const p = path.join(home, '.dsh/plugins-state.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

// ── A. 全新数据卷：应自动装配预装插件 ──
console.log('\n=== A. 全新数据卷 → 预装插件自动装配 ===');
{
  const env = makeHome('fresh', { deps: [], bundles: [] });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(MARKET.every((n) => b.includes(n)), `预装市场插件已装配（${b.filter((x) => MARKET.includes(x)).join(', ')}）`);
  const st = readState(env.home);
  ok(Boolean(st && Array.isArray(st.known) && MARKET.every((n) => st.known.includes(n))), 'plugins-state.json 记录 known 清单');
}

// ── B. 外部停用：不得复活 ──
console.log('\n=== B. 外部停用（deps 有 + bundles 无）→ 不得复活 ===');
{
  const env = makeHome('extDisabled', {
    deps: ['dshmarket', ...MARKET.slice(1)],
    bundles: [],                       // 已被原生 UI 移出 bundles
    state: { disabled: [], uninstalled: [], known: ['dshmarket', ...MARKET.slice(1)] }
  });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  const st = readState(env.home);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(!b.includes('dshmarket'), 'dshmarket 未被重新装回 bundles（用户停用被尊重）');
  ok(st.disabled.includes('dshmarket'), '已把外部停用同步进 plugins-state.json');
  ok(r.out.includes('停用(外部)'), '日志明确说明识别到外部停用');
}

// ── C. 外部卸载：不得复活 ──
console.log('\n=== C. 外部卸载（deps 无 + bundles 无 + known 有）→ 不得复活 ===');
{
  const env = makeHome('extUninstalled', {
    deps: [],
    bundles: [],
    state: { disabled: [], uninstalled: [], known: ['dshmarket'] }
  });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  const st = readState(env.home);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(!b.includes('dshmarket'), 'dshmarket 未被重新装回 bundles（用户卸载被尊重）');
  ok(st.uninstalled.includes('dshmarket'), '已把外部卸载同步进 plugins-state.json');
}

// ── D. 外部重新启用：清除我们的标记 ──
console.log('\n=== D. 外部重新启用（deps 有 + bundles 有）→ 清除停用标记 ===');
{
  const env = makeHome('extEnabled', {
    deps: ['dshmarket'],
    bundles: ['dshmarket'],
    state: { disabled: ['dshmarket'], uninstalled: ['dshmarket'], known: ['dshmarket'] }
  });
  const r = runInstaller(env);
  const st = readState(env.home);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(!st.disabled.includes('dshmarket'), 'disabled 标记已清除');
  ok(!st.uninstalled.includes('dshmarket'), 'uninstalled 标记已清除');
}

// ── E. 我们自己的停用仍然保持 ──
console.log('\n=== E. Admin 侧停用（deps 有 + bundles 无 + 我们标记 disabled）→ 保持停用 ===');
{
  const env = makeHome('oursDisabled', {
    deps: ['dshmarket'],
    bundles: [],
    state: { disabled: ['dshmarket'], uninstalled: [], known: ['dshmarket'] }
  });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  const st = readState(env.home);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(!b.includes('dshmarket'), 'dshmarket 未被装回');
  ok(st.disabled.includes('dshmarket'), 'disabled 标记保持');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
