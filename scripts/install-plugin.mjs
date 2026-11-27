#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withProfileLock, assertProfileLockHeld } = require('./lib/profile-lock.cjs');
const { removePatchEntries, assertPatchSafe } = require('./lib/patch-yaml.cjs');
const { pruneStaleBundles, resolvePruneConfig } = require('./lib/stale-bundles.cjs');
const { readPluginState, writePluginState, defaultDshDir } = require('./lib/plugin-state.cjs');

const dshDir = defaultDshDir(process.env);
const profileDir = process.env.DSH_PROFILE_DIR || path.join(dshDir, 'profiles/web');
const pkgPath = path.join(profileDir, 'package.json');
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const linkDir = path.join(profileDir, 'node_modules/@dsh-custom');
const targetLink = path.join(linkDir, 'dsh-browser-desktop');
const pluginSource = '/app/plugins/dsh-browser-desktop';
const stateFile = path.join(dshDir, 'plugins-state.json');

const HOME_PRESETS_SENTINEL = '# dsh-container-presets-initialized: v1';

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

async function writeProfile(mutate) {
  return withProfileLock(profileDir, async () => {
    assertProfileLockHeld(profileDir);
    if (!fs.existsSync(pkgPath)) return false;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      console.warn('[install-plugin] 读取 package.json 失败，跳过本次写入:', e.message);
      return false;
    }
    const changed = mutate(pkg);
    if (changed) atomicWrite(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    return changed;
  }, { label: 'install-plugin' });
}

fs.mkdirSync(linkDir, { recursive: true });

function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function removeIfExists(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      fs.rmSync(p, { recursive: true, force: true });
    } else {
      fs.unlinkSync(p);
    }
  } catch {}
}

async function ensureProfilePackage() {
  try {
    await withProfileLock(profileDir, async () => {
      assertProfileLockHeld(profileDir);
      if (fs.existsSync(pkgPath)) return;
      fs.mkdirSync(profileDir, { recursive: true });
      const initial = {
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
      };
      atomicWrite(pkgPath, JSON.stringify(initial, null, 2) + '\n');
      console.log('[install-plugin] 已初始化 Web Profile package.json (全新容器首次启动)');
    }, { label: 'install-plugin:init' });
  } catch (e) {
    console.warn('[install-plugin] 初始化 profile package.json 失败:', e.message);
  }
}

function reconcileManagedState(names) {
  try {
    if (!fs.existsSync(pkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    const bundles = (pkg.dsh?.profile?.bundles) || [];
    const state = readPluginState(stateFile);
    const known = new Set(state.known);
    const disabled = new Set(state.disabled);
    const uninstalled = new Set(state.uninstalled);
    let changed = false;

    for (const n of [...deps, ...bundles]) {
      if (!known.has(n)) { known.add(n); changed = true; }
    }

    const notes = [];
    for (const n of names) {
      const present = deps.includes(n);
      const bundled = bundles.includes(n);
      if (present && bundled) {
        if (disabled.delete(n)) { changed = true; notes.push(`${n}=启用`); }
        if (uninstalled.delete(n)) { changed = true; notes.push(`${n}=重新安装`); }
      } else if (present && !bundled) {
        if (!disabled.has(n)) { disabled.add(n); changed = true; notes.push(`${n}=停用(外部)`); }
        if (uninstalled.delete(n)) changed = true;
      } else if (!present && !bundled && known.has(n)) {
        if (!uninstalled.has(n)) { uninstalled.add(n); changed = true; notes.push(`${n}=卸载(外部)`); }
        if (disabled.delete(n)) changed = true;
      }
    }

    if (changed) {
      writePluginState(stateFile, {
        disabled: [...disabled],
        uninstalled: [...uninstalled],
        known: [...known]
      });
      pluginState.disabled = [...disabled];
      pluginState.uninstalled = [...uninstalled];
      pluginState.known = [...known];
      if (notes.length > 0) {
        console.log(`[install-plugin] 已对齐外部（DSH 原生插件管理器）的插件状态: ${notes.join(', ')}`);
      }
    }
  } catch (e) {
    console.warn('[install-plugin] 对齐外部插件状态失败:', e.message);
  }
}

await ensureProfilePackage();

const pluginState = readPluginState(stateFile);

// 存量数据卷迁移：若尚无 plugins-state.json 但已有 package.json，按现状推断已停用插件
if (!fs.existsSync(stateFile) && fs.existsSync(pkgPath)) {
  try {
    const existingPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = existingPkg.dependencies || {};
    const bnds = existingPkg.dsh?.profile?.bundles || [];
    let updated = false;
    for (const dep of Object.keys(deps)) {
      if (!bnds.includes(dep) && !pluginState.disabled.includes(dep)) {
        pluginState.disabled.push(dep);
        updated = true;
      }
      if (!pluginState.known.includes(dep)) {
        pluginState.known.push(dep);
        updated = true;
      }
    }
    if (updated) {
      writePluginState(stateFile, pluginState);
    }
  } catch {}
}

// 0. 全局依赖补齐：将 DSH 内置的 @deepseek-ai/* 兄弟包链接至全局 scope 目录
const installRoot = process.env.DSH_INSTALL_DIR || '/usr/local';
const dshCoreModules = [
  path.join(installRoot, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
].find((d) => fs.existsSync(d));

const globalScopeDir = [
  path.join(installRoot, 'lib/node_modules/@deepseek-ai'),
  '/usr/local/lib/node_modules/@deepseek-ai'
].find((d) => fs.existsSync(d));

if (dshCoreModules && globalScopeDir) {
  try {
    const pkgs = fs.readdirSync(dshCoreModules);
    for (const p of pkgs) {
      if (p === 'dsh') continue;
      const target = path.join(globalScopeDir, p);
      const src = path.join(dshCoreModules, p);
      try {
        if (!pathExists(target)) {
          fs.symlinkSync(src, target);
        }
      } catch {}
    }
  } catch (e) {
    console.warn('[install-plugin] 补齐全局 @deepseek-ai 依赖失败:', e.message);
  }
}

// 1 & 2. mini 变体净身 / full 变体装配 @dsh-custom/dsh-browser-desktop
const isMiniVariant = String(process.env.DSH_VARIANT || '').trim().toLowerCase() === 'mini';
const browserDesktopName = '@dsh-custom/dsh-browser-desktop';

if (isMiniVariant) {
  console.log('[install-plugin] 当前为 mini 变体：执行 dsh-browser-desktop 清理');
  try {
    if (pathExists(targetLink)) removeIfExists(targetLink);
  } catch {}

  try {
    await writeProfile((pkg) => {
      let ch = false;
      if (pkg.dependencies && pkg.dependencies[browserDesktopName]) {
        delete pkg.dependencies[browserDesktopName];
        ch = true;
      }
      if (pkg.dsh?.profile?.bundles?.includes(browserDesktopName)) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== browserDesktopName);
        ch = true;
      }
      return ch;
    });
  } catch (e) {
    console.warn('[install-plugin] mini 清理 package.json 失败:', e.message);
  }

  if (fs.existsSync(patchPath)) {
    try {
      await withProfileLock(profileDir, async () => {
        assertProfileLockHeld(profileDir);
        const before = fs.readFileSync(patchPath, 'utf8');
        if (!before.includes('dsh-browser-desktop')) return;
        const r = removePatchEntries(before, (block) => block.includes('dsh-browser-desktop'));
        if (r.removed === 0) return;
        let res = r.text.trim();
        if (!res) res = '[]';
        assertPatchSafe({ before, after: res, removedIds: r.removedIds });
        atomicWrite(patchPath, res + '\n');
        console.log('[install-plugin] (mini) 已清理 cordis.patch.yml 中 dsh-browser-desktop 块');
      }, { label: 'install-plugin:mini-patch-cleanup' });
    } catch (e) {
      console.warn('[install-plugin] mini 清理 cordis.patch.yml 失败:', e.message);
    }
  }

  try {
    if (fs.existsSync(stateFile)) {
      const curState = readPluginState(stateFile);
      let stateChanged = false;
      for (const field of ['uninstalled', 'disabled', 'known']) {
        if (curState[field].includes(browserDesktopName)) {
          curState[field] = curState[field].filter((x) => x !== browserDesktopName);
          stateChanged = true;
        }
      }
      if (stateChanged) {
        writePluginState(stateFile, curState);
      }
    }
  } catch (e) {
    console.warn('[install-plugin] mini 校验 plugins-state.json 失败:', e.message);
  }
} else {
  const possibleSchemasterySources = [
    path.join(installRoot, 'lib/node_modules/@deepseek-ai/schemastery'),
    path.join(installRoot, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery'),
    '/usr/local/lib/node_modules/@deepseek-ai/schemastery',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery'
  ];
  for (const src of possibleSchemasterySources) {
    if (fs.existsSync(src)) {
      const pluginDepDir = path.join(pluginSource, 'node_modules/@deepseek-ai');
      try {
        fs.mkdirSync(pluginDepDir, { recursive: true });
        const linkPath = path.join(pluginDepDir, 'schemastery');
        if (pathExists(linkPath)) fs.unlinkSync(linkPath);
        fs.symlinkSync(src, linkPath);
        console.log('[install-plugin] 建立 schemastery 依赖软链接成功');
      } catch {}
      break;
    }
  }

  reconcileManagedState([browserDesktopName]);
  const isBrowserDesktopUninstalled = pluginState.uninstalled.includes(browserDesktopName);
  const isBrowserDesktopDisabled = pluginState.disabled.includes(browserDesktopName);

  if (isBrowserDesktopUninstalled) {
    console.log('[install-plugin] 用户已明确卸载 dsh-browser-desktop，跳过装配');
    try {
      if (pathExists(targetLink)) removeIfExists(targetLink);
    } catch {}
    try {
      await writeProfile((pkg) => {
        let ch = false;
        if (pkg.dependencies && pkg.dependencies[browserDesktopName]) {
          delete pkg.dependencies[browserDesktopName];
          ch = true;
        }
        if (pkg.dsh?.profile?.bundles?.includes(browserDesktopName)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== browserDesktopName);
          ch = true;
        }
        return ch;
      });
    } catch {}
  } else {
    try {
      if (pathExists(targetLink)) removeIfExists(targetLink);
      fs.symlinkSync(pluginSource, targetLink);
      console.log('[install-plugin] 建立插件目录软链接成功:', targetLink);
    } catch (e) {
      console.warn('[install-plugin] 建立软链接失败:', e.message);
    }

    try {
      await writeProfile((pkg) => {
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies[browserDesktopName] = 'link:' + pluginSource;
        pkg.dsh = pkg.dsh || { profile: {} };
        pkg.dsh.profile = pkg.dsh.profile || {};
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

        if (isBrowserDesktopDisabled) {
          if (pkg.dsh.profile.bundles.includes(browserDesktopName)) {
            pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== browserDesktopName);
          }
          console.log('[install-plugin] 用户已显式禁用 dsh-browser-desktop，保持停用状态');
        } else {
          if (!pkg.dsh.profile.bundles.includes(browserDesktopName)) {
            pkg.dsh.profile.bundles.push(browserDesktopName);
          }
          console.log('[install-plugin] 注册 bundle 依赖到 package.json 成功');
        }
        return true;
      });
    } catch (e) {
      console.warn('[install-plugin] 更新 package.json 失败:', e.message);
    }
  }
}

// 2.1 自动注册 @dsh-custom/dsh-container-helper（同时清理旧 @dsh-custom/dsh-deepseek-remote-login 软链与引用，不再重建幽灵软链）
const containerHelperName = '@dsh-custom/dsh-container-helper';
const containerHelperSource = '/app/plugins/dsh-container-helper';
const containerHelperLink = path.join(linkDir, 'dsh-container-helper');
const legacyRemoteLoginName = '@dsh-custom/dsh-deepseek-remote-login';
const legacyRemoteLoginLink = path.join(linkDir, 'dsh-deepseek-remote-login');

try {
  // 清理历史改名前的旧软链（避免在插件列表中产生幽灵条目）
  if (pathExists(legacyRemoteLoginLink)) {
    removeIfExists(legacyRemoteLoginLink);
    console.log('[install-plugin] 已清理历史改名旧软链: dsh-deepseek-remote-login');
  }
} catch {}

reconcileManagedState([containerHelperName]);
const isContainerHelperUninstalled = pluginState.uninstalled.includes(containerHelperName);
const isContainerHelperDisabled = pluginState.disabled.includes(containerHelperName);

if (isContainerHelperUninstalled) {
  console.log('[install-plugin] 用户已明确卸载 dsh-container-helper，跳过装配');
  try {
    if (pathExists(containerHelperLink)) removeIfExists(containerHelperLink);
  } catch {}
  try {
    await writeProfile((pkg) => {
      let ch = false;
      for (const n of [legacyRemoteLoginName, containerHelperName]) {
        if (pkg.dependencies && pkg.dependencies[n]) { delete pkg.dependencies[n]; ch = true; }
        if (pkg.dsh?.profile?.bundles?.includes(n)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== n);
          ch = true;
        }
      }
      return ch;
    });
  } catch {}
} else {
  try {
    if (pathExists(containerHelperLink)) removeIfExists(containerHelperLink);
    fs.symlinkSync(containerHelperSource, containerHelperLink);
    console.log('[install-plugin] 建立 DSH 容器助手插件软链接成功');
  } catch (e) {
    console.warn('[install-plugin] 建立 DSH 容器助手软链接失败:', e.message);
  }
  try {
    await writeProfile((pkg) => {
      pkg.dependencies = pkg.dependencies || {};
      delete pkg.dependencies[legacyRemoteLoginName];
      pkg.dependencies[containerHelperName] = 'link:' + containerHelperSource;
      pkg.dsh = pkg.dsh || { profile: {} };
      pkg.dsh.profile = pkg.dsh.profile || {};
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
      // 将存量数据卷中的旧 bundle 名平滑迁移到新名称
      pkg.dsh.profile.bundles = Array.from(new Set(
        pkg.dsh.profile.bundles.map((b) => (b === legacyRemoteLoginName ? containerHelperName : b))
      ));
      if (isContainerHelperDisabled) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== containerHelperName);
        console.log('[install-plugin] 用户已显式禁用 dsh-container-helper，保持停用状态');
      } else if (!pkg.dsh.profile.bundles.includes(containerHelperName)) {
        pkg.dsh.profile.bundles.push(containerHelperName);
      }
      console.log('[install-plugin] 注册 DSH 容器助手 bundle 成功');
      return true;
    });
  } catch (e) {
    console.warn('[install-plugin] 注册 DSH 容器助手失败:', e.message);
  }
}

// 3. 清除 profile cordis.patch.yml 中关于 dsh-browser-desktop 的历史遗留块
if (fs.existsSync(patchPath)) {
  try {
    await withProfileLock(profileDir, async () => {
      assertProfileLockHeld(profileDir);
      const before = fs.readFileSync(patchPath, 'utf8');
      if (!before.includes('dsh-browser-desktop')) return;
      const r = removePatchEntries(before, (block) => block.includes('dsh-browser-desktop'));
      if (r.removed === 0) return;
      let res = r.text.trim();
      if (!res) res = '[]';
      assertPatchSafe({ before, after: res, removedIds: r.removedIds });
      atomicWrite(patchPath, res + '\n');
      console.log('[install-plugin] 已清理 cordis.patch.yml 中本插件的遗留条目（配置权威在 Admin）');
    }, { label: 'install-plugin:patch-cleanup' });
  } catch (e) {
    console.warn('[install-plugin] 处理 cordis.patch.yml 失败（未写入）:', e.message);
  }
}

// 4. 初始化默认工作区 storages/workspace.json
const wsStoragePath = path.join(dshDir, 'storages/workspace.json');
const defaultWsPath = process.env.DSH_WORKSPACE || '/workspace';
fs.mkdirSync(path.join(dshDir, 'storages'), { recursive: true });

try {
  let wsData = null;
  if (fs.existsSync(wsStoragePath)) {
    try { wsData = JSON.parse(fs.readFileSync(wsStoragePath, 'utf8')); } catch {}
  }
  if (!wsData || !wsData.tables || Object.keys(wsData.tables.workspaces || {}).length === 0) {
    const wsId = 'ws-default-workspace';
    const now = new Date().toISOString();
    wsData = {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: [wsId],
        archivedSessionIds: []
      },
      tables: {
        workspaces: {
          [wsId]: {
            path: defaultWsPath,
            title: path.basename(defaultWsPath) || 'workspace',
            sessionIds: [],
            createdAt: now,
            updatedAt: now
          }
        }
      }
    };
    atomicWrite(wsStoragePath, JSON.stringify(wsData, null, 2) + '\n');
    console.log('[install-plugin] 成功为 DSH 注册初始默认工作区:', defaultWsPath);
  }
} catch (e) {
  console.warn('[install-plugin] 初始化默认工作区失败:', e.message);
}

// 5. 自动清理已废弃下线的历史内置插件 (@dsh-custom/dsh-settings-config-path)
try {
  const legacyLink = path.join(linkDir, 'dsh-settings-config-path');
  if (pathExists(legacyLink)) {
    removeIfExists(legacyLink);
    console.log('[install-plugin] 成功移除已废弃插件软链: dsh-settings-config-path');
  }
} catch {}

try {
  await writeProfile((pkg) => {
    let changed = false;
    const legacyPkgName = '@dsh-custom/dsh-settings-config-path';
    if (pkg.dependencies && pkg.dependencies[legacyPkgName]) {
      delete pkg.dependencies[legacyPkgName];
      changed = true;
    }
    if (pkg.dsh?.profile?.bundles?.includes(legacyPkgName)) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== legacyPkgName);
      changed = true;
    }
    if (changed) {
      console.log('[install-plugin] 成功清理已下线插件 @dsh-custom/dsh-settings-config-path');
    }
    return changed;
  });
} catch {}

// 6. 自动识别并装配预装的 Market 插件（尊重用户禁用/卸载偏好，兼容在线更新与镜像升级）
const MARKET_ROOT = process.env.DSH_MARKET_PLUGIN_ROOT || '/usr/local/lib/node_modules';

let _semverMod = null;
try {
  _semverMod = require('../gateway/src/core/semver.js');
} catch {}

const SEMVER_FALLBACK_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isValidSemver(v) {
  const s = String(v ?? '').trim();
  if (!s || !SEMVER_FALLBACK_RE.test(s)) return false;
  if (_semverMod && typeof _semverMod.isSemver === 'function') {
    return _semverMod.isSemver(s.split('+')[0]);
  }
  return true;
}

function compareSemver(a, b) {
  const sa = String(a ?? '').trim().split('+')[0];
  const sb = String(b ?? '').trim().split('+')[0];
  if (_semverMod && typeof _semverMod.compareSemver === 'function') {
    return _semverMod.compareSemver(sa, sb);
  }
  const parse = (v) => {
    const clean = v.replace(/^v/, '');
    const dashIdx = clean.indexOf('-');
    const main = dashIdx === -1 ? clean : clean.slice(0, dashIdx);
    const pre = dashIdx === -1 ? '' : clean.slice(dashIdx + 1);
    const [major = 0, minor = 0, patch = 0] = main.split('.').map((n) => Number(n) || 0);
    return { major, minor, patch, pre };
  };
  const p1 = parse(sa);
  const p2 = parse(sb);
  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  if (p1.patch !== p2.patch) return p1.patch - p2.patch;
  if (!p1.pre && p2.pre) return 1;
  if (p1.pre && !p2.pre) return -1;
  if (p1.pre === p2.pre) return 0;
  const pa = p1.pre.split('.');
  const pb = p2.pre.split('.');
  const isNum = (x) => /^[0-9]+$/.test(x);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = isNum(x);
    const yn = isNum(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function readPackageVersion(pkgDir) {
  try {
    const p = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ver = typeof raw?.version === 'string' ? raw.version.trim() : '';
    if (!ver || !isValidSemver(ver)) return null;
    return ver.replace(/^v/, '');
  } catch {
    return null;
  }
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function ensureSymlink(sourcePath, linkPath) {
  const scopeDir = path.dirname(linkPath);
  fs.mkdirSync(scopeDir, { recursive: true });
  try {
    if (fs.lstatSync(linkPath).isSymbolicLink() && fs.readlinkSync(linkPath) === sourcePath) {
      return;
    }
  } catch {}
  if (pathExists(linkPath)) removeIfExists(linkPath);
  fs.symlinkSync(sourcePath, linkPath);
}

function isLegacyMarketLinkSpec(spec, p) {
  if (typeof spec !== 'string') return false;
  const trimmed = spec.trim();
  if (!/^link:/i.test(trimmed)) return false;
  const linkTarget = trimmed.replace(/^link:/i, '').trim();
  if (!linkTarget) return false;
  const resolvedLink = path.resolve(profileDir, linkTarget);
  const resolvedBundled = path.resolve(p.path);
  if (resolvedLink === resolvedBundled) return true;
  const realLink = safeRealpath(resolvedLink);
  const realBundled = safeRealpath(resolvedBundled);
  if (realLink && realBundled && realLink === realBundled) return true;
  const resolvedMarketRoot = path.resolve(MARKET_ROOT);
  if (resolvedLink === resolvedMarketRoot || resolvedLink.startsWith(resolvedMarketRoot + path.sep)) return true;
  const defaultMarketRoot = '/usr/local/lib/node_modules';
  if (resolvedLink === defaultMarketRoot || resolvedLink.startsWith(defaultMarketRoot + path.sep)) return true;
  return false;
}

function isCustomNonRegistrySpec(spec, p) {
  if (typeof spec !== 'string') return false;
  const trimmed = spec.trim();
  if (!trimmed || isLegacyMarketLinkSpec(trimmed, p)) return false;
  return /^(?:github|gitlab|bitbucket|gist|git\+|file|link|https?|workspace):/i.test(trimmed) || trimmed.includes('/');
}

function parseMarketPackageName(line) {
  const clean = String(line || '').replace(/#.*/, '').trim();
  if (!clean) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || /^git@/i.test(clean)) return '';
  if (clean.startsWith('@')) {
    const slashIdx = clean.indexOf('/');
    if (slashIdx === -1) return '';
    const atIdx = clean.indexOf('@', slashIdx + 1);
    return (atIdx === -1 ? clean : clean.slice(0, atIdx)).trim();
  }
  const atIdx = clean.indexOf('@');
  return (atIdx === -1 ? clean : clean.slice(0, atIdx)).trim();
}

const marketPlugins = [
  { id: 'dshmarket', name: 'dshmarket', path: path.join(MARKET_ROOT, 'dshmarket') },
  { id: 'dsh-thinking-effort', name: '@hytime/dsh-thinking-effort', path: path.join(MARKET_ROOT, '@hytime/dsh-thinking-effort') }
];

const listFile = process.env.DSH_MARKET_PLUGIN_LIST || '/app/plugins.market.list';
if (fs.existsSync(listFile)) {
  try {
    const listLines = fs.readFileSync(listFile, 'utf8').split('\n');
    for (const line of listLines) {
      const pkgName = parseMarketPackageName(line);
      if (pkgName && !marketPlugins.some((item) => item.name === pkgName)) {
        const shortId = pkgName.replace(/^@.*\//, '');
        marketPlugins.push({
          id: shortId,
          name: pkgName,
          path: path.join(MARKET_ROOT, pkgName)
        });
      }
    }
  } catch {}
}

reconcileManagedState(marketPlugins.map((p) => p.name));

for (const p of marketPlugins) {
  const isMarketUninstalled = pluginState.uninstalled.includes(p.name);
  const isMarketDisabled = pluginState.disabled.includes(p.name);
  const targetLnk = path.join(profileDir, 'node_modules', p.name);

  if (isMarketUninstalled) {
    console.log(`[install-plugin] 用户已明确卸载 ${p.name}，保持卸载状态 (跳过装配)`);
    try {
      if (pathExists(targetLnk)) removeIfExists(targetLnk);
    } catch {}
    try {
      await writeProfile((pkg) => {
        let ch = false;
        if (pkg.dependencies && pkg.dependencies[p.name]) {
          delete pkg.dependencies[p.name];
          ch = true;
        }
        if (pkg.dsh?.profile?.bundles?.includes(p.name)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== p.name);
          ch = true;
        }
        return ch;
      });
    } catch {}
    continue;
  }

  if (fs.existsSync(p.path)) {
    try {
      const bundledVersion = readPackageVersion(p.path);
      const bundledReal = safeRealpath(p.path);

      const peerLinkDir = path.join(p.path, 'node_modules/@deepseek-ai');
      if (dshCoreModules) {
        try {
          ensureSymlink(dshCoreModules, peerLinkDir);
        } catch {}
      }

      await writeProfile((pkg) => {
        const targetPkgPath = path.join(targetLnk, 'package.json');
        const hasValidTargetPkg = fs.existsSync(targetPkgPath);
        const installedVersion = hasValidTargetPkg ? readPackageVersion(targetLnk) : null;
        const installedReal = hasValidTargetPkg ? safeRealpath(targetLnk) : null;
        const isExternalInstall = Boolean(installedReal && bundledReal && installedReal !== bundledReal);

        let changed = false;
        if (!pkg.dependencies || typeof pkg.dependencies !== 'object') {
          pkg.dependencies = {};
          changed = true;
        }
        const existingSpec = pkg.dependencies[p.name];

        if (isExternalInstall) {
          if (isCustomNonRegistrySpec(existingSpec, p)) {
            console.log(`[install-plugin] 保留用户自定义来源插件: ${p.name} (${existingSpec})`);
          } else if (installedVersion && bundledVersion && compareSemver(installedVersion, bundledVersion) >= 0) {
            if (!existingSpec || isLegacyMarketLinkSpec(existingSpec, p)) {
              const nextSpec = '^' + installedVersion;
              if (pkg.dependencies[p.name] !== nextSpec) {
                pkg.dependencies[p.name] = nextSpec;
                changed = true;
              }
            }
            console.log(`[install-plugin] 保留用户在线更新的 Market 插件: ${p.name}@${installedVersion} (镜像预装 ${bundledVersion})`);
          } else if (installedVersion && !bundledVersion) {
            if (!existingSpec || isLegacyMarketLinkSpec(existingSpec, p)) {
              const nextSpec = '^' + installedVersion;
              if (pkg.dependencies[p.name] !== nextSpec) {
                pkg.dependencies[p.name] = nextSpec;
                changed = true;
              }
            }
            console.log(`[install-plugin] 保留用户独立安装的 Market 插件: ${p.name}@${installedVersion}`);
          } else {
            ensureSymlink(p.path, targetLnk);
            const nextSpec = bundledVersion ? ('^' + bundledVersion) : ('link:' + p.path);
            if (pkg.dependencies[p.name] !== nextSpec) {
              pkg.dependencies[p.name] = nextSpec;
              changed = true;
            }
            if (installedVersion && bundledVersion) {
              console.log(`[install-plugin] 镜像预装版本更新，自动升级 Market 插件: ${p.name} (${installedVersion} -> ${bundledVersion})`);
            } else {
              console.log(`[install-plugin] 修复并装配预装 Market 插件: ${p.name}`);
            }
          }
        } else {
          ensureSymlink(p.path, targetLnk);
          const nextSpec = bundledVersion ? ('^' + bundledVersion) : ('link:' + p.path);
          if (pkg.dependencies[p.name] !== nextSpec) {
            pkg.dependencies[p.name] = nextSpec;
            changed = true;
          }
        }

        if (!pkg.dsh || typeof pkg.dsh !== 'object') {
          pkg.dsh = { profile: {} };
          changed = true;
        }
        if (!pkg.dsh.profile || typeof pkg.dsh.profile !== 'object') {
          pkg.dsh.profile = {};
          changed = true;
        }
        if (!Array.isArray(pkg.dsh.profile.bundles)) {
          pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
          changed = true;
        }

        if (isMarketDisabled) {
          if (pkg.dsh.profile.bundles.includes(p.name)) {
            pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== p.name);
            changed = true;
          }
          console.log(`[install-plugin] 用户已显式禁用 ${p.name}，保持停用状态`);
        } else {
          if (!pkg.dsh.profile.bundles.includes(p.name)) {
            pkg.dsh.profile.bundles.push(p.name);
            changed = true;
          }
          if (!isExternalInstall) {
            console.log(`[install-plugin] 自动装配预装 Market 插件: ${p.name}${bundledVersion ? '@' + bundledVersion : ''}`);
          }
        }
        return changed;
      });
    } catch (e) {
      console.warn(`[install-plugin] 自动装配 Market 插件失败 (${p.name}):`, e.message);
    }
  } else {
    try {
      await writeProfile((pkg) => {
        const hasInstalledPkg = fs.existsSync(path.join(targetLnk, 'package.json'));
        const existingSpec = pkg.dependencies?.[p.name];
        if (hasInstalledPkg && !isLegacyMarketLinkSpec(existingSpec, p)) {
          console.log(`[install-plugin] 保留 profile 内独立安装的插件: ${p.name}`);
          return false;
        }
        if (!hasInstalledPkg && pathExists(targetLnk)) {
          removeIfExists(targetLnk);
        }
        let changed = false;
        if (pkg.dsh?.profile?.bundles?.includes(p.name)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== p.name);
          changed = true;
        }
        if (pkg.dependencies && pkg.dependencies[p.name]) {
          delete pkg.dependencies[p.name];
          changed = true;
        }
        if (changed) {
          console.log(`[install-plugin] 基础镜像已自动清理未装配插件引用: ${p.name}`);
        }
        return changed;
      });
    } catch {}
  }
}

// 6.1 收尾对齐：把已装配的插件记入 known
const managedToRecord = [...marketPlugins.map((p) => p.name), containerHelperName];
if (!isMiniVariant) managedToRecord.push(browserDesktopName);
reconcileManagedState(managedToRecord);

// 6.2 清理无法解析的 profile bundle 幽灵条目（含 0.2.3 退役包）
function readGatewayConfig() {
  const file = process.env.GATEWAY_CONFIG_FILE || path.join(dshDir, 'gateway.config.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[install-plugin] 读取网关配置失败（回落默认策略）:', e.message);
  }
  return {};
}
const pruneCfg = resolvePruneConfig(process.env, readGatewayConfig());
if (pruneCfg.mode !== 'off') {
  try {
    await writeProfile((pkg) => {
      const { pruned, declared } = pruneStaleBundles(pkg, {
        profileDir,
        mode: pruneCfg.mode,
        extraNames: pruneCfg.extraNames
      });
      if (pruned.length > 0) {
        console.log(`[install-plugin] 已自动清理无法解析的 profile bundle 幽灵条目 (模式: ${pruneCfg.mode}): ${pruned.join(', ')}`);
      }
      if (declared.length > 0) {
        console.log(`[install-plugin] 以下 bundle 已在 dependencies 声明但尚未安装，保留未清理: ${declared.join(', ')}`);
      }
      return pruned.length > 0;
    });
  } catch (e) {
    console.warn('[install-plugin] 自动清理幽灵 bundle 失败:', e.message);
  }
}

// 7. Home 级容器预设（带幂等哨兵注释：仅首次初始化时写入，用户后续删改不再被覆写）
const homePatchPath = path.join(dshDir, 'cordis.patch.yml');

function ensureHomePatchEntries(entries) {
  try {
    fs.mkdirSync(path.dirname(homePatchPath), { recursive: true });
    let raw = '';
    try { raw = fs.readFileSync(homePatchPath, 'utf8'); } catch {}

    // 已有哨兵标记：尊重用户后续的一切编辑与删除，绝不重复追加
    if (raw.includes(HOME_PRESETS_SENTINEL)) {
      return;
    }

    const trimmed = raw.trim();
    const isFlowEmpty = trimmed === '' || trimmed === '[]';
    let text = isFlowEmpty ? '' : raw.replace(/\s*$/, '\n');
    const added = [];
    for (const { key, block } of entries) {
      if (text.includes(key)) continue;
      text += block.replace(/\s*$/, '') + '\n';
      added.push(key);
    }

    const finalText = `${HOME_PRESETS_SENTINEL}\n${text}`;
    atomicWrite(homePatchPath, finalText);
    if (added.length > 0) {
      console.log(`[install-plugin] Home 级补丁已初始化 (${added.join(', ')}): ${homePatchPath}`);
    } else {
      console.log(`[install-plugin] Home 级补丁已写入幂等哨兵标记: ${homePatchPath}`);
    }
  } catch (e) {
    console.warn('[install-plugin] 写入 Home 级补丁失败:', e.message);
  }
}

ensureHomePatchEntries([
  { key: 'ui-sidebar-browser', block: '- id: ui-sidebar-browser\n  disabled: false' },
  { key: 'dsh-market', block: '- id: dsh-market\n  config:\n    allowRestart: false' }
]);
