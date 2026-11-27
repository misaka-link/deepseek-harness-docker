#!/usr/bin/env node
/**
 * 装配脚本语义面回归测试：尊重外部写者（DSH 原生插件管理器）状态，不复活已停用/已卸载插件，
 * 且清理历史遗留 dsh-deepseek-remote-login 符号链接而不重新创建。
 * 用法: node tests/unit/manifest-reconcile.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const SCRIPT = path.join(ROOT, 'scripts/install-plugin.mjs');
const MARKET = ['dshmarket', '@hytime/dsh-thinking-effort'];

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-reconcile-'));
const marketRoot = path.join(tmpRoot, 'market-root');
for (const p of MARKET) {
  fs.mkdirSync(path.join(marketRoot, p), { recursive: true });
  fs.writeFileSync(path.join(marketRoot, p, 'package.json'), JSON.stringify({ name: p, version: '1.0.0' }, null, 2) + '\n');
}

function makeHome(name, { deps = [], depsMap = null, bundles = [], state = null } = {}) {
  const home = path.join(tmpRoot, name);
  const profileDir = path.join(home, '.dsh/profiles/web');
  fs.mkdirSync(profileDir, { recursive: true });
  const dependencies = depsMap
    ? { ...depsMap }
    : Object.fromEntries(deps.map((d) => [d, 'link:' + path.join(marketRoot, d)]));
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...bundles] } }
  }, null, 2) + '\n');
  if (state) {
    fs.writeFileSync(path.join(home, '.dsh/plugins-state.json'), JSON.stringify(state, null, 2) + '\n');
  }
  return { home, profileDir };
}

function runInstaller({ home, profileDir }, { customMarketRoot = marketRoot, extraEnv = {} } = {}) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE_DIR: profileDir,
      DSH_MARKET_PLUGIN_ROOT: customMarketRoot,
      ...extraEnv
    },
    encoding: 'utf8'
  });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

const readPkg = (profileDir) => JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
const readBundles = (profileDir) => readPkg(profileDir).dsh.profile.bundles;
const readState = (home) => {
  const p = path.join(home, '.dsh/plugins-state.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

try {
  console.log('\n=== A. 全新数据卷 → 预装插件自动装配 ===');
  {
    const env = makeHome('fresh');
    const r = runInstaller(env);
    const b = readBundles(env.profileDir);
    const st = readState(env.home);
    ok(r.status === 0, '退出码 0');
    ok(MARKET.every((n) => b.includes(n)), '预装市场插件已装配');
    ok(Boolean(st && Array.isArray(st.known) && MARKET.every((n) => st.known.includes(n))), 'plugins-state.json 记录 known 清单');
    ok(!fs.existsSync(path.join(env.profileDir, 'node_modules/@dsh-custom/dsh-deepseek-remote-login')), '不再创建旧版 dsh-deepseek-remote-login 软链');
  }

  console.log('\n=== B. 外部停用 → 不得复活 ===');
  {
    const env = makeHome('extDisabled', {
      deps: ['dshmarket', ...MARKET.slice(1)],
      bundles: [],
      state: { disabled: [], uninstalled: [], known: ['dshmarket', ...MARKET.slice(1)] }
    });
    const r = runInstaller(env);
    const b = readBundles(env.profileDir);
    const st = readState(env.home);
    ok(r.status === 0, '退出码 0');
    ok(!b.includes('dshmarket'), 'dshmarket 未复活');
    ok(st.disabled.includes('dshmarket'), '同步外部停用到 plugins-state.json');
  }

  console.log('\n=== C. 外部卸载 → 不得复活 ===');
  {
    const env = makeHome('extUninstalled', {
      deps: [],
      bundles: [],
      state: { disabled: [], uninstalled: [], known: ['dshmarket'] }
    });
    const r = runInstaller(env);
    const b = readBundles(env.profileDir);
    const st = readState(env.home);
    ok(r.status === 0, '退出码 0');
    ok(!b.includes('dshmarket'), 'dshmarket 未复活');
    ok(st.uninstalled.includes('dshmarket'), '同步外部卸载到 plugins-state.json');
  }

  console.log('\n=== D. 外部重新启用 → 清除停用/卸载标记 ===');
  {
    const env = makeHome('extEnabled', {
      deps: ['dshmarket'],
      bundles: ['dshmarket'],
      state: { disabled: ['dshmarket'], uninstalled: ['dshmarket'], known: ['dshmarket'] }
    });
    const r = runInstaller(env);
    const st = readState(env.home);
    ok(r.status === 0, '退出码 0');
    ok(!st.disabled.includes('dshmarket') && !st.uninstalled.includes('dshmarket'), '标记已清除');
  }

  console.log('\n=== E. Admin 侧停用 → 保持停用 ===');
  {
    const env = makeHome('oursDisabled', {
      deps: ['dshmarket'],
      bundles: [],
      state: { disabled: ['dshmarket'], uninstalled: [], known: ['dshmarket'] }
    });
    const r = runInstaller(env);
    const b = readBundles(env.profileDir);
    const st = readState(env.home);
    ok(r.status === 0 && !b.includes('dshmarket') && st.disabled.includes('dshmarket'), 'Admin 停用状态保持');
  }

  console.log('\n=== F. 全新装配写入 semver 范围 ^1.0.0（非 link:）并保留 @dsh-custom/* 为 link: ===');
  {
    const env = makeHome('freshSemver');
    const r = runInstaller(env);
    const pkg = readPkg(env.profileDir);
    ok(r.status === 0, '退出码 0');
    for (const p of MARKET) {
      ok(pkg.dependencies[p] === '^1.0.0', `${p} 依赖声明为 ^1.0.0 (实际: ${pkg.dependencies[p]})`);
      ok(!String(pkg.dependencies[p]).startsWith('link:'), `${p} 不再写入 link: 依赖`);
      const lnk = path.join(env.profileDir, 'node_modules', p);
      ok(fs.lstatSync(lnk).isSymbolicLink(), `${p} node_modules 入口为软链`);
      ok(fs.realpathSync(lnk) === fs.realpathSync(path.join(marketRoot, p)), `${p} 软链指向 marketRoot/${p}`);
    }
    ok(
      pkg.dependencies['@dsh-custom/dsh-container-helper'] === 'link:/app/plugins/dsh-container-helper',
      '内置 @dsh-custom/dsh-container-helper 保持 link:/app/plugins/...'
    );
    ok(
      pkg.dependencies['@dsh-custom/dsh-browser-desktop'] === 'link:/app/plugins/dsh-browser-desktop',
      '内置 @dsh-custom/dsh-browser-desktop 保持 link:/app/plugins/...'
    );
  }

  console.log('\n=== G. 存量数据卷 link: 依赖自动迁移为 ^1.0.0 ===');
  {
    const env = makeHome('legacyMigrate', {
      depsMap: {
        dshmarket: 'link:' + path.join(marketRoot, 'dshmarket'),
        '@hytime/dsh-thinking-effort': 'link:/usr/local/lib/node_modules/@hytime/dsh-thinking-effort'
      },
      bundles: [...MARKET],
      state: { disabled: [], uninstalled: [], known: [...MARKET] }
    });
    const r = runInstaller(env);
    const pkg = readPkg(env.profileDir);
    ok(r.status === 0, '退出码 0');
    ok(pkg.dependencies.dshmarket === '^1.0.0', `dshmarket 旧 link: 已迁移为 ^1.0.0 (实际: ${pkg.dependencies.dshmarket})`);
    ok(
      pkg.dependencies['@hytime/dsh-thinking-effort'] === '^1.0.0',
      `@hytime/dsh-thinking-effort 旧 /usr/local link: 已迁移为 ^1.0.0 (实际: ${pkg.dependencies['@hytime/dsh-thinking-effort']})`
    );
    ok(
      fs.realpathSync(path.join(env.profileDir, 'node_modules/dshmarket')) === fs.realpathSync(path.join(marketRoot, 'dshmarket')),
      '迁移后软链正确指向 marketRoot/dshmarket'
    );
  }

  console.log('\n=== H. 用户在线更新（.pnpm 独立安装）与自定义源重启保留 + 标准镜像场景 ===');
  {
    // H1: pnpm 在线升级到 1.85.0，marketRoot 仍为 1.0.0 -> 重启必须保留 1.85.0
    const env = makeHome('onlineUpdated', {
      depsMap: { dshmarket: '1.85.0' },
      bundles: ['dshmarket'],
      state: { disabled: [], uninstalled: [], known: ['dshmarket'] }
    });
    const pnpmPkgDir = path.join(env.profileDir, 'node_modules/.pnpm/dshmarket@1.85.0/node_modules/dshmarket');
    fs.mkdirSync(pnpmPkgDir, { recursive: true });
    fs.writeFileSync(path.join(pnpmPkgDir, 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.85.0' }, null, 2) + '\n');
    const nmLink = path.join(env.profileDir, 'node_modules/dshmarket');
    fs.symlinkSync(pnpmPkgDir, nmLink);

    const r = runInstaller(env);
    const pkg = readPkg(env.profileDir);
    ok(r.status === 0, 'H1 退出码 0');
    ok(fs.realpathSync(nmLink) === fs.realpathSync(pnpmPkgDir), 'H1 保留 .pnpm 1.85.0 软链目标，未回退到 marketRoot');
    ok(pkg.dependencies.dshmarket === '1.85.0', `H1 保留用户依赖声明 1.85.0 (实际: ${pkg.dependencies.dshmarket})`);
    ok(pkg.dsh.profile.bundles.includes('dshmarket'), 'H1 bundles 保持启用');

    // H2: 用户自定义非 registry 源（github:）即使版本更低也不被覆盖
    const envCustom = makeHome('customSource', {
      depsMap: { dshmarket: 'github:someone/dshmarket-fork' },
      bundles: ['dshmarket'],
      state: { disabled: [], uninstalled: [], known: ['dshmarket'] }
    });
    const customDir = path.join(envCustom.profileDir, 'node_modules/.pnpm/dshmarket@0.5.0/node_modules/dshmarket');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'package.json'), JSON.stringify({ name: 'dshmarket', version: '0.5.0' }, null, 2) + '\n');
    const customNmLink = path.join(envCustom.profileDir, 'node_modules/dshmarket');
    fs.symlinkSync(customDir, customNmLink);

    const rCustom = runInstaller(envCustom);
    const pkgCustom = readPkg(envCustom.profileDir);
    ok(rCustom.status === 0, 'H2 自定义源退出码 0');
    ok(fs.realpathSync(customNmLink) === fs.realpathSync(customDir), 'H2 自定义源软链目标未被覆盖');
    ok(pkgCustom.dependencies.dshmarket === 'github:someone/dshmarket-fork', 'H2 自定义 github: 依赖声明未被覆盖');

    // H3: 切换到标准镜像（marketRoot 无预装插件）：独立 .pnpm 安装应保留，悬空软链应清理
    const emptyMarketRoot = path.join(tmpRoot, 'empty-market-root');
    fs.mkdirSync(emptyMarketRoot, { recursive: true });

    const rStdKeep = runInstaller(env, { customMarketRoot: emptyMarketRoot });
    const pkgStdKeep = readPkg(env.profileDir);
    ok(rStdKeep.status === 0, 'H3a 标准镜像保留独立安装退出码 0');
    ok(pkgStdKeep.dependencies.dshmarket === '1.85.0', 'H3a 标准镜像保留 profile 内独立安装的 dshmarket 依赖');
    ok(pkgStdKeep.dsh.profile.bundles.includes('dshmarket'), 'H3a 标准镜像保留独立安装插件的 bundle');

    const envDangling = makeHome('stdDangling', {
      depsMap: { dshmarket: '^1.0.0' },
      bundles: ['dshmarket'],
      state: { disabled: [], uninstalled: [], known: ['dshmarket'] }
    });
    const danglingLink = path.join(envDangling.profileDir, 'node_modules/dshmarket');
    fs.mkdirSync(path.dirname(danglingLink), { recursive: true });
    fs.symlinkSync(path.join(emptyMarketRoot, 'dshmarket'), danglingLink);

    const rStdClean = runInstaller(envDangling, { customMarketRoot: emptyMarketRoot });
    const pkgStdClean = readPkg(envDangling.profileDir);
    let danglingStillExists = false;
    try { fs.lstatSync(danglingLink); danglingStillExists = true; } catch {}
    ok(rStdClean.status === 0, 'H3b 标准镜像清理悬空软链退出码 0');
    ok(!danglingStillExists, 'H3b 悬空软链已清理');
    ok(!pkgStdClean.dependencies.dshmarket && !pkgStdClean.dsh.profile.bundles.includes('dshmarket'), 'H3b 悬空插件依赖与 bundle 已清理');
  }

  console.log('\n=== I. 镜像升级（marketRoot 版本高于已安装外部版本）→ 自动升级至新版预装 ===');
  {
    const marketRootV2 = path.join(tmpRoot, 'market-root-v2');
    for (const p of MARKET) {
      fs.mkdirSync(path.join(marketRootV2, p), { recursive: true });
      const ver = p === 'dshmarket' ? '2.0.0' : '1.0.0';
      fs.writeFileSync(path.join(marketRootV2, p, 'package.json'), JSON.stringify({ name: p, version: ver }, null, 2) + '\n');
    }

    const env = makeHome('imageUpgrade', {
      depsMap: { dshmarket: '1.85.0' },
      bundles: ['dshmarket'],
      state: { disabled: [], uninstalled: [], known: ['dshmarket'] }
    });
    const oldPnpmDir = path.join(env.profileDir, 'node_modules/.pnpm/dshmarket@1.85.0/node_modules/dshmarket');
    fs.mkdirSync(oldPnpmDir, { recursive: true });
    fs.writeFileSync(path.join(oldPnpmDir, 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.85.0' }, null, 2) + '\n');
    const nmLink = path.join(env.profileDir, 'node_modules/dshmarket');
    fs.symlinkSync(oldPnpmDir, nmLink);

    const r = runInstaller(env, { customMarketRoot: marketRootV2 });
    const pkg = readPkg(env.profileDir);
    ok(r.status === 0, '退出码 0');
    ok(
      fs.realpathSync(nmLink) === fs.realpathSync(path.join(marketRootV2, 'dshmarket')),
      '镜像新版 2.0.0 > 1.85.0 时软链自动升级指向新版 marketRoot'
    );
    ok(pkg.dependencies.dshmarket === '^2.0.0', `依赖声明自动升级为 ^2.0.0 (实际: ${pkg.dependencies.dshmarket})`);
  }

  console.log('\n=== J. plugin-manager.js#installPlugin 写入 ^1.0.0（非 link:）并尊重 DSH_MARKET_PLUGIN_ROOT ===');
  {
    const env = makeHome('pmInstall', {
      depsMap: {},
      bundles: [],
      state: { disabled: [], uninstalled: ['dshmarket', '@hytime/dsh-thinking-effort'], known: ['dshmarket', '@hytime/dsh-thinking-effort'] }
    });

    const prevDshHome = process.env.DSH_HOME;
    const prevDshDir = process.env.DSH_DIR;
    const prevMarketRoot = process.env.DSH_MARKET_PLUGIN_ROOT;
    try {
      process.env.DSH_HOME = env.home;
      delete process.env.DSH_DIR;
      process.env.DSH_MARKET_PLUGIN_ROOT = marketRoot;

      const pluginManager = require(path.join(ROOT, 'gateway/src/plugins/plugin-manager.js'));

      const beforeList = pluginManager.getPlugins();
      const uninstalledEntry = beforeList.plugins.find((x) => x.name === 'dshmarket');
      ok(
        Boolean(uninstalledEntry && uninstalledEntry.isUninstalled && uninstalledEntry.version === '1.0.0'),
        `getPlugins 从 DSH_MARKET_PLUGIN_ROOT 读取已卸载插件版本 1.0.0 (实际: ${uninstalledEntry?.version})`
      );

      await pluginManager.installPlugin('dshmarket');
      await pluginManager.installPlugin('@hytime/dsh-thinking-effort');

      const pkg = readPkg(env.profileDir);
      ok(pkg.dependencies.dshmarket === '^1.0.0', `installPlugin('dshmarket') 写入 ^1.0.0 (实际: ${pkg.dependencies.dshmarket})`);
      ok(!String(pkg.dependencies.dshmarket).startsWith('link:'), 'installPlugin 不再为市场插件写入 link:');
      ok(
        pkg.dependencies['@hytime/dsh-thinking-effort'] === '^1.0.0',
        `installPlugin('@hytime/dsh-thinking-effort') 写入 ^1.0.0 (实际: ${pkg.dependencies['@hytime/dsh-thinking-effort']})`
      );
      ok(
        fs.realpathSync(path.join(env.profileDir, 'node_modules/dshmarket')) === fs.realpathSync(path.join(marketRoot, 'dshmarket')),
        'installPlugin 建立 node_modules/dshmarket 软链指向 DSH_MARKET_PLUGIN_ROOT'
      );
      ok(
        pkg.dsh.profile.bundles.includes('dshmarket') && pkg.dsh.profile.bundles.includes('@hytime/dsh-thinking-effort'),
        'installPlugin 恢复 bundles 启用'
      );
    } finally {
      if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome;
      if (prevDshDir === undefined) delete process.env.DSH_DIR; else process.env.DSH_DIR = prevDshDir;
      if (prevMarketRoot === undefined) delete process.env.DSH_MARKET_PLUGIN_ROOT; else process.env.DSH_MARKET_PLUGIN_ROOT = prevMarketRoot;
    }
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
