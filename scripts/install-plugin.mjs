#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const profileDir = process.env.DSH_PROFILE_DIR || `${process.env.DSH_HOME || '/root'}/.dsh/profiles/web`;
const pkgPath = path.join(profileDir, 'package.json');
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const linkDir = path.join(profileDir, 'node_modules/@dsh-custom');
const targetLink = path.join(linkDir, 'dsh-browser-desktop');
const pluginSource = '/app/plugins/dsh-browser-desktop';
const stateFile = `${process.env.DSH_HOME || '/root'}/.dsh/plugins-state.json`;

// ── P6：与 DSH 共享 profile 写锁 ─────────────────────────────────────────
// 官方 0.1.7 的原生插件管理器/设置编辑器在改 profile 前会取
// `profiles/web/package.json.lock`（wx 独占）。容器启动/版本切换时本脚本也会改
// 同一个 package.json；不加锁就会与 DSH 的并发写互相覆盖（丢更新）。
// 这里让每处「读 package.json → 改 → 写」都在同一把锁内完成。
const require = createRequire(import.meta.url);
const { withProfileLock, assertProfileLockHeld } = require('./profile-lock.cjs');
const { removePatchEntries, assertPatchSafe } = require('./patch-yaml.cjs');
const { pruneStaleBundles, resolvePruneConfig } = require('./stale-bundles.cjs');

/**
 * 在 profile 写锁内完成一次「读 package.json → 由 mutate 修改 → 需要时写回」。
 * @param {(pkg: any) => boolean} mutate 返回 true 表示需要写回
 * @returns {Promise<boolean>}
 */
async function writeProfile(mutate) {
  return withProfileLock(profileDir, async () => {
    assertProfileLockHeld(profileDir);
    // 与既有语义一致：profile 文件不存在时不凭空创建（初始化由 ensureProfilePackage 负责）
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

/**
 * 原子写文件（轻微项）：先写临时文件再 rename，避免写盘中断留下半截 JSON/YAML
 * 让 DSH 下次启动解析失败。rename 在同目录内是原子操作。
 */
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

fs.mkdirSync(linkDir, { recursive: true });

/**
 * 安全判断路径是否已存在（含悬空软链）。
 * 注意：不能用 `fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()`——
 * 当 p 完全不存在时 lstatSync 会抛 ENOENT，导致插件注册流程中断。
 */
function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 删除已存在的文件/软链（含悬空软链），不存在则静默跳过 */
function removeIfExists(p) {
  try {
    fs.unlinkSync(p);
  } catch {}
}

/**
 * 确保 profile 的 package.json 存在。
 * 全新容器首次启动时 DSH 尚未生成该文件，若此处不做初始化，下方
 * `if (fs.existsSync(pkgPath))` 的依赖/bundle 注册会被整段跳过，
 * 导致 dsh-browser-desktop 永远不会被注册进 profile（AI 工具与提示词全缺失）。
 */
async function ensureProfilePackage() {
  try {
    await withProfileLock(profileDir, async () => {
      assertProfileLockHeld(profileDir);
      // 锁内再判一次：避免与并发的另一个写者抢着初始化
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

function readPluginState() {
  try {
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return {
        disabled: Array.isArray(data.disabled) ? data.disabled : [],
        uninstalled: Array.isArray(data.uninstalled) ? data.uninstalled : [],
        // known：我们"见过/装配过"的插件清单。用于区分"从未装配过"（应默认启用）
        // 与"被外部卸载"（应保持卸载）——见 reconcileManagedState()
        known: Array.isArray(data.known) ? data.known : []
      };
    }
  } catch (e) {
    console.warn('[install-plugin] 读取 plugins-state.json 警告:', e.message);
  }
  return { disabled: [], uninstalled: [], known: [] };
}

function writePluginState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    atomicWrite(stateFile, JSON.stringify({
      disabled: Array.from(new Set(state.disabled || [])),
      uninstalled: Array.from(new Set(state.uninstalled || [])),
      known: Array.from(new Set(state.known || [])),
      updatedAt: new Date().toISOString()
    }, null, 2) + '\n');
  } catch (e) {
    console.warn('[install-plugin] 写入 plugins-state.json 警告:', e.message);
  }
}

/**
 * 与 profile manifest 对齐"外部写者"（DSH 原生插件管理器 / 设置页）的插件状态。
 *
 * 为什么需要（P6 的语义面）：官方原生插件管理器启停插件时**只改 bundles**，
 * 不会写我们的 plugins-state.json。若不识别，容器重启时本脚本会把"依赖仍在、
 * 但已被移出 bundles"的插件当成"从未装配"而自动装回去，等于静默回退用户的停用决定。
 *
 * 规则（manifest 是唯一事实来源）：
 *   dependencies 有 + bundles 有  → 启用：清除我们的 disabled / uninstalled 标记
 *   dependencies 有 + bundles 无  → 停用：写入 disabled 标记（不再自动装配）
 *   dependencies 无 + bundles 无 + known 中有 → 卸载：写入 uninstalled 标记
 *   dependencies 无 + bundles 无 + known 中无 → 从未装配：维持默认（走正常自动装配）
 *
 * @param {string[]} names 受本脚本管理的插件名
 */
function reconcileManagedState(names) {
  try {
    if (!fs.existsSync(pkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    const bundles = (pkg.dsh?.profile?.bundles) || [];
    const state = readPluginState();
    const known = new Set(state.known);
    const disabled = new Set(state.disabled);
    const uninstalled = new Set(state.uninstalled);
    let changed = false;

    // 1) 记录"见过/装配过"的插件（首次运行会用现有 manifest 播种；之后需持久化才能识别外部卸载）
    for (const n of [...deps, ...bundles]) {
      if (!known.has(n)) { known.add(n); changed = true; }
    }

    // 2) 按 manifest 对齐受管插件的启停/卸载标记
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
      writePluginState({ disabled: [...disabled], uninstalled: [...uninstalled], known: [...known] });
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

const pluginState = readPluginState();

// 如果不存在 plugins-state.json 但存在已有的 package.json，说明已有运行历史
// 自动推断现有已停用的插件，避免镜像升级时覆盖用户现有的禁用偏好
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
    }
    if (updated) {
      writePluginState(pluginState);
    }
  } catch {}
}

// 0. 全局依赖自动补齐：将 DSH 内置的 @deepseek-ai/* 兄弟包链接至全局 /usr/local/lib/node_modules/@deepseek-ai
// 彻底解决 dshmarket 等第三方插件因无法在上一级目录找到 @deepseek-ai/schemastery 等库而启动崩溃的问题
const dshCoreModules = [
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
].find(d => fs.existsSync(d));

const globalScopeDir = [
  '/usr/local/lib/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai'
].find(d => fs.existsSync(d));

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

// 1. 建立插件依赖软链接 (schemastery)
const possibleSchemasterySources = [
  '/usr/local/lib/node_modules/@deepseek-ai/schemastery',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery',
  '/opt/dsh/lib/node_modules/@deepseek-ai/schemastery',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery'
];
for (const src of possibleSchemasterySources) {
  if (fs.existsSync(src)) {
    const pluginDepDir = path.join(pluginSource, 'node_modules/@deepseek-ai');
    fs.mkdirSync(pluginDepDir, { recursive: true });
    const linkPath = path.join(pluginDepDir, 'schemastery');
    try {
      if (pathExists(linkPath)) fs.unlinkSync(linkPath);
      fs.symlinkSync(src, linkPath);
      console.log('[install-plugin] 建立 schemastery 依赖软链接成功');
    } catch {}
    break;
  }
}

// 2. 自动注册并配置 @dsh-custom/dsh-browser-desktop (尊重用户持久化偏好)
const browserDesktopName = '@dsh-custom/dsh-browser-desktop';
// P6：先与 manifest 对齐（识别"被 DSH 原生插件管理器停用"），再决定是否装配
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
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== browserDesktopName);
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
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== browserDesktopName);
        }
        console.log('[install-plugin] 用户已显式禁用 dsh-browser-desktop，保持停用状态 (不加入 bundles)');
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

// 3. 清除 cordis.patch.yml 中的重复 insert 项（外科手术式删除 + 安全闸，绝不误伤相邻插件/设置条目）
if (fs.existsSync(patchPath)) {
  try {
    await withProfileLock(profileDir, async () => {
      assertProfileLockHeld(profileDir);
      const before = fs.readFileSync(patchPath, 'utf8');
      // 本插件一律通过 bundles 加载；patch 里任何关于它的条目都是历史遗留（仅注入过期的 config）
      if (!before.includes('dsh-browser-desktop')) return;
      const r = removePatchEntries(before, (block) => block.includes('dsh-browser-desktop'));
      if (r.removed === 0) return;
      let res = r.text.trim();
      // 过滤后若为空，必须写成合法的空 YAML 序列 '[]'。
      // 写空文件（仅换行）会让 DSH 的 cordis patch 加载器解析失败 → DSH 启动即退出 (code=1)。
      if (!res) res = '[]';
      // 安全闸：该文件同时是 DSH 设置权威（含 llm-pi-ai 模型配置），绝不吞掉非本插件条目
      assertPatchSafe({ before, after: res, removedIds: r.removedIds });
      atomicWrite(patchPath, res + '\n');
      console.log('[install-plugin] 已清理 cordis.patch.yml 中本插件的遗留条目（配置权威在 Admin）');
    }, { label: 'install-plugin:patch-cleanup' });
  } catch (e) {
    console.warn('[install-plugin] 处理 cordis.patch.yml 失败（未写入）:', e.message);
  }
}

// 4. 自动在 DSH 存储库中初始化默认工作区
const wsStoragePath = `${process.env.DSH_HOME || '/root'}/.dsh/storages/workspace.json`;
const defaultWsPath = process.env.DSH_WORKSPACE || '/workspace';
fs.mkdirSync(`${process.env.DSH_HOME || '/root'}/.dsh/storages`, { recursive: true });

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

// 5. 自动清理已废弃下线的历史内置插件 (如已无实际意义的 @dsh-custom/dsh-settings-config-path)
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
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== legacyPkgName);
      changed = true;
    }
    if (changed) {
      console.log('[install-plugin] 成功从 package.json 依赖与 bundles 中清理已下线插件 @dsh-custom/dsh-settings-config-path');
    }
    return changed;
  });
} catch {}

// 6. 自动识别并装配已预装的 Market 插件 (从 plugins.market.list 动态同步，并完全尊重用户禁用/卸载偏好)
// 预装插件的物理安装根目录（可用 DSH_MARKET_PLUGIN_ROOT 覆盖，便于测试与二次打包）
const MARKET_ROOT = process.env.DSH_MARKET_PLUGIN_ROOT || '/usr/local/lib/node_modules';
const marketPlugins = [
  { id: 'dshmarket', name: 'dshmarket', path: path.join(MARKET_ROOT, 'dshmarket') },
  { id: 'dsh-thinking-effort', name: '@hytime/dsh-thinking-effort', path: path.join(MARKET_ROOT, '@hytime/dsh-thinking-effort') }
];

const listFile = '/app/plugins.market.list';
if (fs.existsSync(listFile)) {
  try {
    const listLines = fs.readFileSync(listFile, 'utf8').split('\n');
    for (const line of listLines) {
      const clean = line.replace(/#.*/, '').trim();
      if (clean && !marketPlugins.some(item => item.name === clean)) {
        const shortId = clean.replace(/^@.*\//, '');
        marketPlugins.push({
          id: shortId,
          name: clean,
          path: path.join(MARKET_ROOT, clean)
        });
      }
    }
  } catch {}
}

// P6：与 manifest 对齐（识别外部停用/卸载），再决定是否装配
reconcileManagedState(marketPlugins.map((p) => p.name));

for (const p of marketPlugins) {
  const isMarketUninstalled = pluginState.uninstalled.includes(p.name);
  const isMarketDisabled = pluginState.disabled.includes(p.name);

  // 若用户已显式卸载，保持卸载状态，清理残留软链接与引用，绝对不重新装配！
  if (isMarketUninstalled) {
    console.log(`[install-plugin] 用户已明确卸载 ${p.name}，保持卸载状态 (跳过装配)`);
    const targetLnk = path.join(profileDir, 'node_modules', p.name);
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
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== p.name);
          ch = true;
        }
        return ch;
      });
    } catch {}
    continue;
  }

  if (fs.existsSync(p.path)) {
    try {
      const scopeDir = path.dirname(path.join(profileDir, 'node_modules', p.name));
      fs.mkdirSync(scopeDir, { recursive: true });
      const targetLnk = path.join(profileDir, 'node_modules', p.name);
      if (pathExists(targetLnk)) removeIfExists(targetLnk);
      fs.symlinkSync(p.path, targetLnk);

      // 确保插件内部 node_modules/@deepseek-ai 指向全局依赖 (pathExists 可安全处理悬空软链)
      const peerLinkDir = path.join(p.path, 'node_modules/@deepseek-ai');
      try {
        if (pathExists(peerLinkDir)) {
          removeIfExists(peerLinkDir);
        }
        if (dshCoreModules) {
          fs.mkdirSync(path.dirname(peerLinkDir), { recursive: true });
          fs.symlinkSync(dshCoreModules, peerLinkDir);
        }
      } catch (e) {}

      await writeProfile((pkg) => {
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies[p.name] = 'link:' + p.path;
        pkg.dsh = pkg.dsh || { profile: {} };
        pkg.dsh.profile = pkg.dsh.profile || {};
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

        if (isMarketDisabled) {
          if (pkg.dsh.profile.bundles.includes(p.name)) {
            pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== p.name);
          }
          console.log(`[install-plugin] 用户已显式禁用 ${p.name}，保持停用状态 (不加入 bundles)`);
        } else {
          if (!pkg.dsh.profile.bundles.includes(p.name)) {
            pkg.dsh.profile.bundles.push(p.name);
          }
          console.log(`[install-plugin] 自动装配预装 Market 插件: ${p.name}`);
        }
        return true;
      });
    } catch (e) {
      console.warn(`[install-plugin] 自动装配 Market 插件失败 (${p.name}):`, e.message);
    }
  } else {
    // 插件未安装（纯净基础镜像），清理 package.json 中残留的 bundle 引用
    try {
      await writeProfile((pkg) => {
        let changed = false;
        if (pkg.dsh?.profile?.bundles?.includes(p.name)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== p.name);
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
    } catch (e) {}
  }
}

// 6.1 收尾对齐：把本次装配过的插件记入 known（日后才能区分"从未装配"与"被外部卸载"）
reconcileManagedState([...marketPlugins.map((p) => p.name), browserDesktopName]);

// 6.2 自动清理无法解析的 profile bundle 幽灵条目。
//     背景：官方 0.1.7 起合并/下线了若干 bundle 包（如
//     `@deepseek-ai/dsh-experimental-agent-team-web-profile` 被并入
//     `@deepseek-ai/dsh-experimental-agent-team-profile`）。镜像升级后，profile 的
//     `dsh.profile.bundles` 会残留已不存在的包名，DSH 每次加载都打印
//     `skipping profile bundle "..." : cannot resolve ...` 并在 UI 提示。
//     策略来源（优先级）：环境变量 DSH_PRUNE_STALE_BUNDLES > 管理后台持久化配置
//     `$DSH_HOME/.dsh/gateway.config.json#pruneStaleBundles` > 默认 known（保守）。
//     默认「保守模式」仅清理已知被上游下线的 bundle（stale-bundles.cjs 的清单 + 额外清单），
//     只删「确实无法解析且未在依赖字段声明」的条目，绝不误删并发写者/用户意图。
//     注意：本脚本在容器启动阶段执行一次，管理后台改动需重启容器后生效。
function readGatewayConfig() {
  const file = process.env.GATEWAY_CONFIG_FILE || path.join(process.env.DSH_HOME || '/root', '.dsh', 'gateway.config.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[install-plugin] 读取网关配置失败（忽略，回落默认策略）:', e.message);
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
        console.log(`[install-plugin] 以下 bundle 已在 dependencies 声明但尚未安装，保留未清理: ${declared.join(', ')}（可执行 dsh plugin --profile web install 安装）`);
      }
      return pruned.length > 0;
    });
  } catch (e) {
    console.warn('[install-plugin] 自动清理幽灵 bundle 失败:', e.message);
  }
}

// 7. 容器级配置预设写入 Home 级补丁层（官方 0.1.7 起设置权威在补丁层，旧 settings.yaml 仅导入一次）。
//    - dsh-market.allowRestart:false —— 由容器 dsh-manager 统一守护，防止市场「一键重启」双重启端口冲突。
//      注意：该字段是 entry 的 config（dshmarket 未导出可配置 Schema，无法经 settings.yaml 导入）。
//    - ui-sidebar-browser disabled:false —— 0.1.7 起内置侧边栏浏览器在 Web 端默认关闭，这里重新开启以保持 0.1.6 的功能面。
//    Home 级补丁 $DSH_HOME/cordis.patch.yml 优先级最高，且不会被 DSH 设置页或我方 profile 补丁清理逻辑改写。
const homePatchPath = path.join(process.env.DSH_HOME || '/root', '.dsh', 'cordis.patch.yml');

function ensureHomePatchEntries(entries) {
  try {
    fs.mkdirSync(path.dirname(homePatchPath), { recursive: true });
    let raw = '';
    try { raw = fs.readFileSync(homePatchPath, 'utf8'); } catch {}
    const trimmed = raw.trim();
    const isFlowEmpty = trimmed === '' || trimmed === '[]';
    let text = isFlowEmpty ? '' : raw.replace(/\s*$/, '\n');
    const added = [];
    for (const { key, block } of entries) {
      if (text.includes(key)) continue;
      text += block.replace(/\s*$/, '') + '\n';
      added.push(key);
    }
    if (added.length > 0) {
      atomicWrite(homePatchPath, text);
      console.log(`[install-plugin] Home 级补丁已更新 (${added.join(', ')}): ${homePatchPath}`);
    }
  } catch (e) {
    console.warn('[install-plugin] 写入 Home 级补丁失败:', e.message);
  }
}

ensureHomePatchEntries([
  { key: 'ui-sidebar-browser', block: '- id: ui-sidebar-browser\n  disabled: false' },
  { key: 'dsh-market', block: '- id: dsh-market\n  config:\n    allowRestart: false' }
]);
