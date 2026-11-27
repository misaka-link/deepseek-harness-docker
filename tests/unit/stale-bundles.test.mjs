#!/usr/bin/env node
/**
 * Profile 幽灵 bundle 自动清理单元测试与装配脚本集成测试。
 * 用法: node tests/unit/stale-bundles.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
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
} = require(path.join(ROOT, 'scripts/lib/stale-bundles.cjs'));

const GHOST = '@deepseek-ai/dsh-experimental-agent-team-web-profile';
const SIDE = 'dsh-side-plugin';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-bundles-'));

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
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE_DIR: profileDir, DSH_MARKET_PLUGIN_ROOT: path.join(tmpRoot, 'market'), ...extraEnv },
    encoding: 'utf8'
  });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}
const readBundles = (profileDir) => JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles;

try {
  // A. 保守模式
  {
    const profileDir = makeProfileDir('unitA', ['@fake/ok']);
    const pkg = { dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@fake/ok', GHOST, SIDE, '@deepseek-ai/dsh-web-app'] } } };
    const r = pruneStaleBundles(pkg, { profileDir });
    eq(r.pruned, [GHOST], 'A. 仅剔除已知下线幽灵条目');
    eq(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@fake/ok', SIDE, '@deepseek-ai/dsh-web-app'], 'A2. 保留其余条目与顺序');
    ok(KNOWN_REMOVED_BUNDLES.includes(GHOST), 'A3. GHOST 在已知下线清单中');
  }

  // B/C/D. 幂等、受保护核心、模式与 extra 列表
  {
    const profileDir = makeProfileDir('unitBCD', []);
    const pkgB = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', GHOST] } } };
    eq(pruneStaleBundles(pkgB, { profileDir }).pruned, [GHOST], 'B1. 首次剔除');
    eq(pruneStaleBundles(pkgB, { profileDir }).pruned, [], 'B2. 二次幂等');

    const pkgC = { dsh: { profile: { bundles: [...DEFAULT_PROTECTED_BUNDLES] } } };
    eq(pruneStaleBundles(pkgC, { profileDir, installAnchors: [] }).pruned, [], 'C. 受保护核心永不清理');

    ok(pruneMode({}) === 'known' && pruneMode({ DSH_PRUNE_STALE_BUNDLES: 'all' }) === 'all' && pruneMode({ DSH_PRUNE_STALE_BUNDLES: '0' }) === 'off', 'D1. pruneMode 解析');
    eq(extraRemovedNames({ DSH_PRUNE_BUNDLES_EXTRA: 'a, b ,c' }), ['a', 'b', 'c'], 'D2. extraRemovedNames 解析');
  }

  // E. 解析判定（使用临时安装锚点夹具，不依赖宿主机全局安装）
  {
    const fakeAnchorDir = path.join(tmpRoot, 'fake-dsh');
    for (const p of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-agent-team-profile']) {
      const d = path.join(fakeAnchorDir, 'node_modules', p);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: p, version: '0.2.3-alpha.2' }));
    }
    const anchorPkg = path.join(fakeAnchorDir, 'package.json');
    fs.writeFileSync(anchorPkg, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.3-alpha.2' }));
    const profileDir = makeProfileDir('unitE', []);
    ok(isBundleResolvable('@deepseek-ai/dsh-base', profileDir, [anchorPkg]) === true, 'E1. 安装锚点可解析 dsh-base');
    ok(isBundleResolvable('@deepseek-ai/dsh-experimental-agent-team-profile', profileDir, [anchorPkg]) === true, 'E2. 安装锚点可解析新合并包');
    ok(isBundleResolvable(GHOST, profileDir, [anchorPkg]) === false, 'E3. 幽灵包不可解析');
  }

  // F/F2. 保守/激进与配置优先级
  {
    const profileDir = makeProfileDir('unitF', []);
    const pkg1 = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SIDE] } } };
    eq(pruneStaleBundles(pkg1, { profileDir }).pruned, [], 'F1. 默认模式不碰清单外条目');
    const pkg2 = { dependencies: { 'declared-plugin': '^1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', SIDE, 'declared-plugin'] } } };
    const r2 = pruneStaleBundles(pkg2, { profileDir, mode: 'all' });
    eq(r2.pruned, [SIDE], 'F2. 激进模式清理未声明无法解析条目');
    eq(r2.declared, ['declared-plugin'], 'F3. 激进模式保留已声明条目');
    eq(resolvePruneConfig({ DSH_PRUNE_STALE_BUNDLES: 'off', DSH_PRUNE_BUNDLES_EXTRA: 'a' }, { pruneStaleBundles: 'all', pruneBundlesExtra: 'b,c' }), { mode: 'off', extraNames: ['a', 'b', 'c'] }, 'F4. env 优先于持久化且 extra 取并集');
    eq(parseExtraList(' x , y ,'), ['x', 'y'], 'F5. parseExtraList');
  }

  // G/H/I/J/K. install-plugin.mjs 集成
  {
    const envG = makeHome('intG', { bundles: [GHOST, '@deepseek-ai/dsh-experimental-agent-team-profile'] });
    const rG = runInstaller(envG);
    ok(rG.status === 0 && !readBundles(envG.profileDir).includes(GHOST), 'G. 装配默认自动剔除幽灵条目');

    const envH = makeHome('intH', { bundles: [GHOST] });
    const rH = runInstaller(envH, { DSH_PRUNE_STALE_BUNDLES: '0' });
    ok(rH.status === 0 && readBundles(envH.profileDir).includes(GHOST), 'H. DSH_PRUNE_STALE_BUNDLES=0 关闭清理');

    const envI = makeHome('intI', { bundles: [SIDE] });
    const rI = runInstaller(envI);
    ok(rI.status === 0 && readBundles(envI.profileDir).includes(SIDE), 'I. 默认模式保留并发写入条目');

    const envJ = makeHome('intJ', { bundles: [SIDE, GHOST] });
    fs.writeFileSync(path.join(envJ.home, '.dsh/gateway.config.json'), JSON.stringify({ pruneStaleBundles: 'all' }));
    const rJ = runInstaller(envJ);
    ok(rJ.status === 0 && !readBundles(envJ.profileDir).includes(SIDE) && !readBundles(envJ.profileDir).includes(GHOST), 'J. 持久化 pruneStaleBundles=all 生效');
  }

  // L. 静态接线
  {
    const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    ok(readSrc('scripts/install-plugin.mjs').includes('resolvePruneConfig'), 'L1. install-plugin 使用 resolvePruneConfig');
    ok(readSrc('gateway/src/config/runtime-config.js').includes('pruneStaleBundles'), 'L2. runtime-config 支持 pruneStaleBundles');
    ok(readSrc('gateway/src/routes/admin/config.js').includes('pruneBundlesExtra'), 'L3. routes/admin/config.js 读写 pruneBundlesExtra');
    ok(readSrc('gateway/public/ui/js/panels/settings.js').includes('pruneStaleBundles'), 'L4. 设置面板包含 pruneStaleBundles 控件');
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
