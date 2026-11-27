'use strict';
/**
 * plugin-manager.js — DSH 插件状态查询、启停、卸载与重装管理器（v1.0.0）。
 *
 * 改进：
 *   - 读写 plugins-state.json 统一走 scripts/lib/plugin-state.cjs 单写者，
 *     完整保留 `known` 与未知扩展字段，彻底修复已卸载/停用插件复活问题；
 *   - 所有路径动态经由 core/paths.js 获取，适配非 root 与自定义 DSH_HOME；
 *   - 补齐 @dsh-custom/dsh-container-helper 描述，扫描 scope 目录时对悬空软链 lstat 容错。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../core/paths');
const CAPABILITIES = require('../core/capabilities');
const { isSemver } = require('../core/semver');
const { writeFileAtomicSync } = require('../core/atomic-write');
const {
  withProfileLock,
  assertProfileLockHeld
} = require('../../../scripts/lib/profile-lock.cjs');
const {
  removePatchEntries,
  assertPatchSafe,
  topLevelEntryIds
} = require('../../../scripts/lib/patch-yaml.cjs');
const {
  readPluginState: readStateFromFile,
  writePluginState: writeStateToFile
} = require('../../../scripts/lib/plugin-state.cjs');

const CORE_PACKAGES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app'
]);

const PLUGIN_DESCRIPTIONS_ZH = {
  '@deepseek-ai/dsh-base': 'DeepSeek Harness 核心基础运行环境与智能体执行框架',
  '@deepseek-ai/dsh-web-app': 'DeepSeek Harness 官方 Web 图形交互客户端',
  '@deepseek-ai/dsh-experimental-agent-team-profile': '官方 Agent Teams 多智能体协作实验性套件',
  '@dsh-custom/dsh-browser-desktop': '容器 Chromium 图形浏览器与 noVNC 桌面集成插件，支持 AI 自主浏览网页、多标签管理与实时无损截图',
  '@dsh-custom/dsh-container-helper': 'DSH 容器助手：集成移动端视口防黑屏适配、远程/反代 DeepSeek 账号登录中继与敏感信息打码脱敏',
  'dshmarket': 'DSH 可视化插件市场：在界面内直接浏览、搜索并一键安装/管理社区拓展插件',
  '@hytime/dsh-thinking-effort': '为 DSH 的第三方模型补充可配置的思考强度档位，并支持设置子 Agent 默认思考强度',
  'dsh-client-auto-continue': 'DSH Web 客户端自动继续插件：遇网络波动或异常中断时自动发送本地化续写提示'
};

function getMarketPluginRoot() {
  return process.env.DSH_MARKET_PLUGIN_ROOT || '/usr/local/lib/node_modules';
}

function readValidPackageVersion(pkgDir) {
  try {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return null;
    const raw = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const ver = typeof raw?.version === 'string' ? raw.version.trim() : '';
    if (!ver) return null;
    const clean = ver.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(clean)) return null;
    return isSemver(clean.split('+')[0]) ? clean : null;
  } catch {
    return null;
  }
}

function getProfilePaths() {
  const dshDir = paths.getDshDir();
  const profileDir = path.join(dshDir, 'profiles', 'web');
  return {
    dshDir,
    profileDir,
    pkgPath: path.join(profileDir, 'package.json'),
    patchPath: path.join(profileDir, 'cordis.patch.yml'),
    modDir: path.join(profileDir, 'node_modules'),
    pluginsDataDir: path.join(dshDir, 'plugins'),
    stateFile: paths.getPluginsStateFile()
  };
}

function readPluginState() {
  return readStateFromFile(paths.getPluginsStateFile());
}

function writePluginState(state) {
  return writeStateToFile(paths.getPluginsStateFile(), state);
}

function readPackageJson(pkgPath) {
  try {
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    }
  } catch (err) {
    console.error('[plugin-manager] 读取 package.json 失败:', err.message);
  }
  return { dependencies: {}, dsh: { profile: { bundles: [] } } };
}

function writePackageJson(profileDir, pkgPath, pkg) {
  assertProfileLockHeld(profileDir);
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    writeFileAtomicSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', { mode: 0o644 });
    return true;
  } catch (err) {
    console.error('[plugin-manager] 写入 package.json 失败:', err.message);
    throw new Error('写入 package.json 失败: ' + err.message);
  }
}

function cleanPatchForPluginLocked(profileDir, patchPath, pluginName) {
  if (!fs.existsSync(patchPath)) return false;
  assertProfileLockHeld(profileDir);
  try {
    const before = fs.readFileSync(patchPath, 'utf8');
    let content = before;
    let changed = false;
    const removedIds = [];

    if (pluginName.includes('worktree')) {
      const r = removePatchEntries(content, (block) => /\bid:\s*ui-workspace\b/.test(block));
      if (r.removed > 0) { content = r.text; changed = true; removedIds.push(...r.removedIds); }
    }

    if (content.includes(pluginName)) {
      const esc = pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc);
      const r = removePatchEntries(content, (block) => re.test(block));
      if (r.removed > 0) { content = r.text; changed = true; removedIds.push(...r.removedIds); }
    }

    if (!changed) return false;

    content = content.trim();
    if (!content) content = '[]';
    assertPatchSafe({ before, after: content, removedIds });
    writeFileAtomicSync(patchPath, content + '\n', { mode: 0o644 });
    console.log(`[plugin-manager] 已自动清理 cordis.patch.yml 中关于 ${pluginName} 的补丁条目`);
    return true;
  } catch (err) {
    console.error(`[plugin-manager] 清理 cordis.patch.yml 已放弃（未写入）: ${err.message}`);
    return false;
  }
}

async function cleanPatchForPlugin(pluginName) {
  const { profileDir, patchPath } = getProfilePaths();
  return withProfileLock(
    profileDir,
    async () => cleanPatchForPluginLocked(profileDir, patchPath, pluginName),
    { label: `cleanPatch:${pluginName}` }
  );
}

function getPlugins() {
  const { pkgPath, modDir } = getProfilePaths();
  const pkg = readPackageJson(pkgPath);
  const dependencies = pkg.dependencies || {};
  const bundles = (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles))
    ? pkg.dsh.profile.bundles
    : [];

  const pluginState = readPluginState();
  const disabledSet = new Set(pluginState.disabled);
  const uninstalledSet = new Set(pluginState.uninstalled);

  const foundMap = new Map();
  const registeredNames = new Set([...Object.keys(dependencies), ...bundles]);

  for (const name of registeredNames) {
    const isCore = CORE_PACKAGES.has(name);
    const isCustom = name.startsWith('@dsh-custom/') || name.startsWith('@dsh-external/');
    const isEnabled = !disabledSet.has(name) && bundles.includes(name);

    let version = dependencies[name] || '系统核心';
    let description = PLUGIN_DESCRIPTIONS_ZH[name] || '';

    let targetPkgPath = path.join(modDir, name, 'package.json');
    if (!fs.existsSync(targetPkgPath) && dependencies[name] && dependencies[name].startsWith('link:')) {
      const linkTarget = dependencies[name].replace(/^link:/, '');
      targetPkgPath = path.join(linkTarget, 'package.json');
    }

    if (fs.existsSync(targetPkgPath)) {
      try {
        const modPkg = JSON.parse(fs.readFileSync(targetPkgPath, 'utf8'));
        if (modPkg.version) version = modPkg.version;
        if (!description && modPkg.description) description = modPkg.description;
      } catch {}
    }

    foundMap.set(name, {
      name,
      version,
      description: description || '暂无功能描述',
      enabled: isEnabled,
      isUninstalled: false,
      isCore,
      isCustom,
      type: isCore ? 'core' : (isCustom ? 'builtin' : 'community'),
      source: dependencies[name] || 'bundled'
    });
  }

  function inspectDir(dir, pkgName) {
    if (foundMap.has(pkgName)) return;
    // 悬空软链容错：lstat 检查存在，再安全读取 package.json
    try { fs.lstatSync(dir); } catch { return; }
    const p = path.join(dir, 'package.json');
    if (!fs.existsSync(p)) return;
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      const isDshPlugin = json.dsh
        || (Array.isArray(json.keywords) && (json.keywords.includes('dsh') || json.keywords.includes('deepseek-harness') || json.keywords.includes('cordis')))
        || (typeof json.name === 'string' && (json.name.startsWith('dsh-') || json.name.startsWith('@dsh-')));

      if (isDshPlugin) {
        const desc = PLUGIN_DESCRIPTIONS_ZH[pkgName] || json.description || '暂无功能描述';
        foundMap.set(pkgName, {
          name: pkgName,
          version: json.version || 'unknown',
          description: desc,
          enabled: false,
          isUninstalled: false,
          isCore: false,
          isCustom: pkgName.startsWith('@dsh-custom/'),
          type: 'unregistered',
          source: 'unlinked'
        });
      }
    } catch {}
  }

  if (fs.existsSync(modDir)) {
    try {
      for (const item of fs.readdirSync(modDir)) {
        if (item.startsWith('@')) {
          const scopeDir = path.join(modDir, item);
          let isDir = false;
          try { isDir = fs.statSync(scopeDir).isDirectory(); } catch { isDir = false; }
          if (isDir) {
            let subs = [];
            try { subs = fs.readdirSync(scopeDir); } catch { subs = []; }
            for (const sub of subs) {
              inspectDir(path.join(scopeDir, sub), item + '/' + sub);
            }
          }
        } else if (!item.startsWith('.')) {
          inspectDir(path.join(modDir, item), item);
        }
      }
    } catch {}
  }

  for (const uninstalledName of uninstalledSet) {
    if (!foundMap.has(uninstalledName)) {
      const globalPkgPath = path.join(getMarketPluginRoot(), uninstalledName, 'package.json');
      let version = '内置镜像';
      let desc = PLUGIN_DESCRIPTIONS_ZH[uninstalledName] || '已卸载插件';
      if (fs.existsSync(globalPkgPath)) {
        try {
          const gPkg = JSON.parse(fs.readFileSync(globalPkgPath, 'utf8'));
          if (gPkg.version) version = gPkg.version;
          if (gPkg.description && !PLUGIN_DESCRIPTIONS_ZH[uninstalledName]) desc = gPkg.description;
        } catch {}
      }
      foundMap.set(uninstalledName, {
        name: uninstalledName,
        version,
        description: desc,
        enabled: false,
        isUninstalled: true,
        isCore: false,
        isCustom: uninstalledName.startsWith('@dsh-custom/'),
        type: 'community',
        source: 'uninstalled'
      });
    }
  }

  let list = Array.from(foundMap.values());
  if (CAPABILITIES.browser && !CAPABILITIES.browser.pluginSupported) {
    list = list.filter((p) => p.name !== '@dsh-custom/dsh-browser-desktop' && p.name !== 'dsh-browser-desktop');
  }

  list.sort((a, b) => {
    if (a.isCore && !b.isCore) return -1;
    if (!a.isCore && b.isCore) return 1;
    if (a.isUninstalled !== b.isUninstalled) return a.isUninstalled ? 1 : -1;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { ok: true, plugins: list };
}

function isValidPluginName(name) {
  if (!name || typeof name !== 'string') return false;
  const npmRegex = /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;
  return npmRegex.test(name) && !name.includes('..');
}

async function togglePlugin(name, enable) {
  if (!isValidPluginName(name)) {
    const err = new Error('非法或不安全的插件名称: ' + name);
    err.errorCode = 'PLUGIN_NAME_REQUIRED';
    throw err;
  }
  if (CAPABILITIES.browser && !CAPABILITIES.browser.pluginSupported && (name === '@dsh-custom/dsh-browser-desktop' || name === 'dsh-browser-desktop') && enable) {
    const err = new Error('当前为 mini 镜像，不含容器桌面与 Chromium 栈，无法启用该插件');
    err.errorCode = 'CAPABILITY_UNAVAILABLE';
    err.code = 'CAPABILITY_UNAVAILABLE';
    throw err;
  }
  if (CORE_PACKAGES.has(name)) {
    const err = new Error('系统核心组件 (' + name + ') 不允许禁用，否则会导致系统无法运行');
    err.errorCode = 'PLUGIN_CORE_PROTECTED';
    err.params = { name };
    throw err;
  }

  const { profileDir, pkgPath, patchPath } = getProfilePaths();

  return withProfileLock(profileDir, async () => {
    const pkg = readPackageJson(pkgPath);
    const pkgSnapshot = JSON.stringify(pkg, null, 2) + '\n';
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

    const bundles = pkg.dsh.profile.bundles;
    const index = bundles.indexOf(name);

    const state = readPluginState();
    const disabledSet = new Set(state.disabled);
    const uninstalledSet = new Set(state.uninstalled);
    const knownSet = new Set(state.known);
    knownSet.add(name);

    if (enable) {
      if (index === -1) bundles.push(name);
      disabledSet.delete(name);
      uninstalledSet.delete(name);
    } else {
      if (index !== -1) bundles.splice(index, 1);
      disabledSet.add(name);
      uninstalledSet.delete(name);
      cleanPatchForPluginLocked(profileDir, patchPath, name);
    }

    writePackageJson(profileDir, pkgPath, pkg);
    const stateOk = writePluginState({
      disabled: Array.from(disabledSet),
      uninstalled: Array.from(uninstalledSet),
      known: Array.from(knownSet)
    });
    if (!stateOk) {
      try { writeFileAtomicSync(pkgPath, pkgSnapshot, { mode: 0o644 }); } catch {}
      throw new Error('插件状态持久化失败（已回滚 package.json），请检查数据卷权限与磁盘空间');
    }

    console.log(`[plugin-manager] 插件 ${name} 已持久化${enable ? '启用' : '禁用'}`);
    return { ok: true, name, enabled: enable };
  }, { label: `toggle:${name}` });
}

async function uninstallPlugin(name) {
  if (!isValidPluginName(name)) {
    const err = new Error('非法或不安全的插件名称: ' + name);
    err.errorCode = 'PLUGIN_NAME_REQUIRED';
    throw err;
  }
  if (CORE_PACKAGES.has(name)) {
    const err = new Error('系统核心组件 (' + name + ') 不允许卸载');
    err.errorCode = 'PLUGIN_CORE_PROTECTED';
    err.params = { name };
    throw err;
  }

  const { profileDir, pkgPath, patchPath, modDir, pluginsDataDir } = getProfilePaths();

  await withProfileLock(profileDir, async () => {
    const pkg = readPackageJson(pkgPath);
    let changed = false;

    if (pkg.dsh?.profile?.bundles && Array.isArray(pkg.dsh.profile.bundles)) {
      const idx = pkg.dsh.profile.bundles.indexOf(name);
      if (idx !== -1) {
        pkg.dsh.profile.bundles.splice(idx, 1);
        changed = true;
      }
    }

    if (pkg.dependencies && pkg.dependencies[name]) {
      delete pkg.dependencies[name];
      changed = true;
    }

    if (changed) {
      writePackageJson(profileDir, pkgPath, pkg);
    }

    const state = readPluginState();
    const disabledSet = new Set(state.disabled);
    const uninstalledSet = new Set(state.uninstalled);
    const knownSet = new Set(state.known);
    disabledSet.delete(name);
    uninstalledSet.add(name);
    knownSet.add(name);
    writePluginState({
      disabled: Array.from(disabledSet),
      uninstalled: Array.from(uninstalledSet),
      known: Array.from(knownSet)
    });

    cleanPatchForPluginLocked(profileDir, patchPath, name);
  }, { label: `uninstall:${name}` });

  const pluginDir = path.resolve(modDir, name);
  const resolvedModDir = path.resolve(modDir);
  if (!pluginDir.startsWith(resolvedModDir + path.sep)) {
    throw new Error('检测到非法越界删除操作，已拦截: ' + pluginDir);
  }

  try {
    fs.lstatSync(pluginDir);
    fs.rmSync(pluginDir, { recursive: true, force: true });
  } catch {}

  const sanitizedScopeName = name.replace(/^@.*\//, '');
  const dataDir = path.resolve(pluginsDataDir, sanitizedScopeName);
  const resolvedDataDir = path.resolve(pluginsDataDir);
  try {
    if (dataDir.startsWith(resolvedDataDir + path.sep) && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  } catch {}

  console.log(`[plugin-manager] 插件 ${name} 已彻底卸载并持久化标记`);
  return { ok: true, name, uninstalled: true };
}

async function installPlugin(name) {
  if (!isValidPluginName(name)) {
    const err = new Error('非法或不安全的插件名称: ' + name);
    err.errorCode = 'PLUGIN_NAME_REQUIRED';
    throw err;
  }
  if (CAPABILITIES.browser && !CAPABILITIES.browser.pluginSupported && (name === '@dsh-custom/dsh-browser-desktop' || name === 'dsh-browser-desktop')) {
    const err = new Error('当前为 mini 镜像，不含容器桌面与 Chromium 栈，无法安装该插件');
    err.errorCode = 'CAPABILITY_UNAVAILABLE';
    err.code = 'CAPABILITY_UNAVAILABLE';
    throw err;
  }

  const { profileDir, pkgPath, modDir } = getProfilePaths();

  await withProfileLock(profileDir, async () => {
    const state = readPluginState();
    const disabledSet = new Set(state.disabled);
    const uninstalledSet = new Set(state.uninstalled);
    const knownSet = new Set(state.known);
    uninstalledSet.delete(name);
    disabledSet.delete(name);
    knownSet.add(name);

    const pkg = readPackageJson(pkgPath);
    pkg.dependencies = pkg.dependencies || {};
    pkg.dsh = pkg.dsh || { profile: {} };
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

    const globalPath = path.join(getMarketPluginRoot(), name);
    const customPath = path.join('/app/plugins', name.replace(/^@dsh-custom\//, ''));

    let sourcePath = null;
    if (fs.existsSync(globalPath)) {
      sourcePath = globalPath;
    } else if (fs.existsSync(customPath)) {
      sourcePath = customPath;
    }

    if (sourcePath) {
      const scopeDir = path.dirname(path.join(modDir, name));
      fs.mkdirSync(scopeDir, { recursive: true });
      const targetLink = path.join(modDir, name);
      try {
        const st = fs.lstatSync(targetLink);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          fs.rmSync(targetLink, { recursive: true, force: true });
        } else {
          fs.unlinkSync(targetLink);
        }
      } catch {}
      try {
        fs.symlinkSync(sourcePath, targetLink);
      } catch (e) {
        console.warn(`[plugin-manager] 重新建立插件软链接警告: ${e.message}`);
      }
      if (sourcePath === globalPath) {
        const validVer = readValidPackageVersion(globalPath);
        pkg.dependencies[name] = validVer ? ('^' + validVer) : ('link:' + sourcePath);
      } else {
        pkg.dependencies[name] = 'link:' + sourcePath;
      }
    }

    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name);
    }

    writePackageJson(profileDir, pkgPath, pkg);
    writePluginState({
      disabled: Array.from(disabledSet),
      uninstalled: Array.from(uninstalledSet),
      known: Array.from(knownSet)
    });
  }, { label: `install:${name}` });

  console.log(`[plugin-manager] 插件 ${name} 已重新安装并恢复启用`);
  return { ok: true, name, installed: true };
}

module.exports = {
  getPlugins,
  togglePlugin,
  uninstallPlugin,
  installPlugin,
  cleanPatchForPlugin,
  readPluginState,
  writePluginState,
  removePatchEntries,
  topLevelEntryIds,
  PLUGIN_DESCRIPTIONS_ZH
};
