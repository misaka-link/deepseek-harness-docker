#!/usr/bin/env node
/**
 * 回归测试：自动清理 profile 中无法解析的「幽灵」bundle 条目。
 *
 * 背景：官方 0.1.7 起把 `@deepseek-ai/dsh-experimental-agent-team-web-profile` 并入
 * `@deepseek-ai/dsh-experimental-agent-team-profile`。升级镜像后 profile 的
 * `dsh.profile.bundles` 残留旧包名，DSH 每次加载都打印 `skipping profile bundle ...`。
 *
 * 覆盖：
 *   单元（直接调用 scripts/stale-bundles.cjs）
 *     A. 保守模式：清理已知下线清单中的幽灵；可解析/清单外条目保留；顺序不变
 *     B. 幂等：再次运行不再剔除
 *     C. 受保护核心 bundle 即使无法解析也不清理
 *     D. 缺失/空 bundles 无操作；pruneMode / extraRemovedNames 语义
 *     E. 解析判定对齐官方：真实安装锚点可解析 @deepseek-ai/dsh-base，幽灵不可解析
 *     F. P6 安全：默认模式不碰清单外的无法解析条目（保护并发写入）；激进模式才清理
 *   集成（驱动真实 scripts/install-plugin.mjs，临时 DSH_HOME）
 *     G. 启动装配默认模式自动剔除幽灵条目并打印日志
 *     H. DSH_PRUNE_STALE_BUNDLES=0 时关闭自动清理
 *     I. 默认模式不误删并发/第三方写入的清单外 bundle（无丢更新）
 *
 * 用法: node scripts/stale-bundles-test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(ROOT, 'scripts/install-plugin.mjs');
const {
  pruneStaleBundles,
  isBundleResolvable,
  pruneMode,
  extraRemovedNames,
  parseExtraList,
  resolvePruneConfig,
  DEFAULT_PROTECTED_BUNDLES,
  KNOWN_REMOVED_BUNDLES
} = require('./stale-bundles.cjs');

const GHOST = '@deepseek-ai/dsh-experimental-agent-team-web-profile';
const SIDE = 'dsh-side-plugin'; // 清单外、无法解析的模拟"并发写入"条目

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-bundles-'));

/** 造 profile 目录，并在其 node_modules 下放置若干"可经 profile 锚点解析"的假包。 */
function makeProfileDir(name, resolvable = []) {
  const profileDir = path.join(tmpRoot, name, '.dsh/profiles/web');
  fs.mkdirSync(profileDir, { recursive: true });
  for (const pkgName of resolvable) {
    const dir = path.join(profileDir, 'node_modules', pkgName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version: '1.0.0' }) + '\n');
  }
  return profileDir;
}

// ── A. 保守模式混合场景 ──
console.log('\n=== A. 保守模式：清理已知下线幽灵、保留其它、顺序不变 ===');
{
  const profileDir = makeProfileDir('unitA', ['@fake/ok']);
  const bundles = ['@deepseek-ai/dsh-base', '@fake/ok', GHOST, SIDE, '@deepseek-ai/dsh-web-app'];
  const pkg = { dependencies: {}, dsh: { profile: { bundles: [...bundles] } } };
  const r = pruneStaleBundles(pkg, { profileDir });
  eq(r.pruned, [GHOST], '仅剔除已知下线的幽灵条目');
  eq(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@fake/ok', SIDE, '@deepseek-ai/dsh-web-app'], '清单外条目与顺序完整保留');
  ok(KNOWN_REMOVED_BUNDLES.includes(GHOST), 'GHOST 在已知下线清单中');
}

// ── B. 幂等 ──
console.log('\n=== B. 幂等：再次运行不再剔除 ===');
{
  const profileDir = makeProfileDir('unitB', []);
  const pkg = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', GHOST] } } };
  const r1 = pruneStaleBundles(pkg, { profileDir });
  const r2 = pruneStaleBundles(pkg, { profileDir });
  eq(r1.pruned, [GHOST], '首次剔除幽灵');
  eq(r2.pruned, [], '第二次无操作（幂等）');
  eq(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base'], '最终 bundles 稳定');
}

// ── C. 受保护核心 bundle ──
console.log('\n=== C. 受保护核心 bundle 即使无法解析也不清理 ===');
{
  const profileDir = makeProfileDir('unitC', []);
  const pkg = { dsh: { profile: { bundles: [...DEFAULT_PROTECTED_BUNDLES] } } };
  const r = pruneStaleBundles(pkg, { profileDir, installAnchors: [] }); // 无锚点 ⇒ 必然"无法解析"
  eq(r.pruned, [], '核心 bundle 未被清理');
  eq(pkg.dsh.profile.bundles, [...DEFAULT_PROTECTED_BUNDLES], '核心 bundle 保留');
}

// ── D. 无操作与配置语义 ──
console.log('\n=== D. 缺失/空 bundles 无操作；pruneMode / extraRemovedNames 语义 ===');
{
  const profileDir = makeProfileDir('unitD', []);
  eq(pruneStaleBundles({ dsh: {} }, { profileDir }).pruned, [], '无 dsh.profile.bundles 时为无操作');
  eq(pruneStaleBundles({ dsh: { profile: { bundles: [] } } }, { profileDir }).pruned, [], '空 bundles 为无操作');
  ok(pruneMode({}) === 'known', '默认保守模式 (known)');
  ok(pruneMode({ DSH_PRUNE_STALE_BUNDLES: 'all' }) === 'all', '=all 激进模式');
  ok(pruneMode({ DSH_PRUNE_STALE_BUNDLES: '0' }) === 'off', '=0 关闭');
  ok(pruneMode({ DSH_PRUNE_STALE_BUNDLES: 'false' }) === 'off', '=false 关闭');
  eq(extraRemovedNames({ DSH_PRUNE_BUNDLES_EXTRA: 'a, b ,c' }), ['a', 'b', 'c'], 'extra 名单解析');
  const pkg = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@fake/extra'] } } };
  eq(pruneStaleBundles(pkg, { profileDir, extraNames: ['@fake/extra'] }).pruned, ['@fake/extra'], 'extra 名单中的条目会被清理');
}

// ── E. 解析判定对齐官方安装锚点 ──
console.log('\n=== E. 解析判定对齐官方（真实 DSH 安装锚点） ===');
{
  const profileDir = makeProfileDir('unitE', []);
  ok(isBundleResolvable('@deepseek-ai/dsh-base', profileDir, undefined) === true, '安装内 bundle @deepseek-ai/dsh-base 可解析');
  ok(isBundleResolvable('@deepseek-ai/dsh-experimental-agent-team-profile', profileDir, undefined) === true, '合并后的 agent-team-profile 可解析');
  ok(isBundleResolvable(GHOST, profileDir, undefined) === false, '幽灵 web-profile 不可解析');
}

// ── F. P6 安全：默认模式不碰清单外条目 ──
console.log('\n=== F. P6 安全：默认保守模式不误删清单外条目；激进模式才清理 ===');
{
  const profileDir = makeProfileDir('unitF', []);
  const pkg = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SIDE] } } };
  const r = pruneStaleBundles(pkg, { profileDir });
  eq(r.pruned, [], '默认模式不清理清单外的无法解析条目');
  ok(pkg.dsh.profile.bundles.includes(SIDE), '清单外条目被保留（保护并发写入）');

  const pkg2 = { dependencies: { 'declared-plugin': '^1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SIDE, 'declared-plugin'] } } };
  const r2 = pruneStaleBundles(pkg2, { profileDir, mode: 'all' });
  eq(r2.pruned, [SIDE], '激进模式清理未声明的无法解析条目');
  eq(r2.declared, ['declared-plugin'], '激进模式保留已声明待安装条目');
}

// ── F2. 策略解析：env > 持久化配置 > 默认 ──
console.log('\n=== F2. resolvePruneConfig：env > 持久化 > 默认，extra 取并集 ===');
{
  eq(resolvePruneConfig({}, {}), { mode: 'known', extraNames: [] }, '默认 known / 无额外清单');
  eq(resolvePruneConfig({ DSH_PRUNE_STALE_BUNDLES: 'all' }, {}).mode, 'all', 'env 生效');
  eq(resolvePruneConfig({}, { pruneStaleBundles: 'all' }).mode, 'all', '持久化生效');
  eq(resolvePruneConfig({ DSH_PRUNE_STALE_BUNDLES: 'off' }, { pruneStaleBundles: 'all' }).mode, 'off', 'env 优先于持久化');
  eq(resolvePruneConfig({}, { pruneStaleBundles: '0' }).mode, 'off', '持久化 0 → off');
  eq(resolvePruneConfig({ DSH_PRUNE_BUNDLES_EXTRA: 'a' }, { pruneBundlesExtra: 'b,c' }).extraNames, ['a', 'b', 'c'], 'extra 清单取并集');
  eq(parseExtraList(' x , y ,'), ['x', 'y'], 'parseExtraList 字符串');
  eq(parseExtraList(['x', ' y ']), ['x', 'y'], 'parseExtraList 数组');
}

// ── 集成：驱动真实 install-plugin.mjs ──
function makeHome(name, { deps = [], bundles = [] } = {}) {
  const home = path.join(tmpRoot, name);
  const profileDir = path.join(home, '.dsh/profiles/web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: Object.fromEntries(deps.map((d) => [d, 'link:' + path.join(tmpRoot, 'market', d)])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...bundles] } }
  }, null, 2) + '\n');
  return { home, profileDir };
}
function runInstaller({ home, profileDir }, extraEnv = {}) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE_DIR: profileDir,
      DSH_MARKET_PLUGIN_ROOT: path.join(tmpRoot, 'market'),
      ...extraEnv
    },
    encoding: 'utf8'
  });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}
const readBundles = (profileDir) => JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles;

console.log('\n=== G. 启动装配：默认模式自动剔除幽灵 bundle 并打印日志 ===');
{
  const env = makeHome('intG', { bundles: [GHOST, '@deepseek-ai/dsh-experimental-agent-team-profile'] });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(!b.includes(GHOST), '幽灵条目已从 bundles 中移除');
  ok(b.includes('@deepseek-ai/dsh-experimental-agent-team-profile'), '合并后的 agent-team-profile 被保留');
  ok(r.out.includes('已自动清理无法解析的 profile bundle 幽灵条目') && r.out.includes(GHOST), '日志明确报告清理动作与包名');
}

console.log('\n=== H. DSH_PRUNE_STALE_BUNDLES=0 关闭自动清理 ===');
{
  const env = makeHome('intH', { bundles: [GHOST] });
  const r = runInstaller(env, { DSH_PRUNE_STALE_BUNDLES: '0' });
  const b = readBundles(env.profileDir);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(b.includes(GHOST), '关闭开关后幽灵条目被保留（不清理）');
  ok(!r.out.includes('已自动清理无法解析的 profile bundle 幽灵条目'), '日志无清理报告');
}

console.log('\n=== I. 默认模式不误删并发/第三方写入的清单外 bundle（无丢更新） ===');
{
  const env = makeHome('intI', { bundles: [SIDE] });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(b.includes(SIDE), '清单外条目 dsh-side-plugin 未被删除');
}

// 写入临时持久化网关配置（模拟管理后台「网关与系统配置」保存）
function writeGatewayConfig(home, cfg) {
  const p = path.join(home, '.dsh/gateway.config.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

console.log('\n=== J. 持久化配置 pruneStaleBundles=all → 装配时清理清单外条目 ===');
{
  const env = makeHome('intJ', { bundles: [SIDE, GHOST] });
  writeGatewayConfig(env.home, { pruneStaleBundles: 'all' });
  const r = runInstaller(env);
  const b = readBundles(env.profileDir);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(!b.includes(SIDE) && !b.includes(GHOST), '激进模式（来自持久化配置）清理了两个无法解析条目');
  ok(r.out.includes('模式: all'), '日志标注生效模式 all');
}

console.log('\n=== K. 持久化 pruneStaleBundles=off → 不清理；env 覆盖持久化 ===');
{
  const env = makeHome('intK', { bundles: [GHOST] });
  writeGatewayConfig(env.home, { pruneStaleBundles: 'off' });
  const r = runInstaller(env);
  ok(r.status === 0, '装配脚本退出码 0');
  ok(readBundles(env.profileDir).includes(GHOST), '持久化 off → 幽灵保留');

  const env2 = makeHome('intK2', { bundles: [GHOST] });
  writeGatewayConfig(env2.home, { pruneStaleBundles: 'off' });
  const r2 = runInstaller(env2, { DSH_PRUNE_STALE_BUNDLES: 'known' });
  ok(r2.status === 0, '装配脚本退出码 0');
  ok(!readBundles(env2.profileDir).includes(GHOST), 'env=known 覆盖持久化 off → 幽灵被清理');
}

console.log('\n=== L. 静态接线：Admin 设置项 / 网关字段 / 装配脚本读取 ===');
{
  const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  ok(readSrc('scripts/install-plugin.mjs').includes('resolvePruneConfig'), 'install-plugin 使用 resolvePruneConfig');
  ok(readSrc('scripts/install-plugin.mjs').includes('gateway.config.json'), 'install-plugin 读取持久化网关配置');
  ok(readSrc('gateway/index.js').includes('pruneStaleBundles'), 'gateway 读写 pruneStaleBundles');
  ok(readSrc('gateway/index.js').includes('pruneBundlesExtra'), 'gateway 读写 pruneBundlesExtra');
  ok(readSrc('gateway/public/admin.html').includes('editPruneStaleBundles'), 'Admin 提供模式下拉');
  ok(readSrc('gateway/public/admin.html').includes('editPruneBundlesExtra'), 'Admin 提供额外清单输入');
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
