const fs = require('fs');
const path = require('path');

const PROFILE_DIR = '/root/.dsh/profiles/web';
const PKG_PATH = path.join(PROFILE_DIR, 'package.json');
const PATCH_PATH = path.join(PROFILE_DIR, 'cordis.patch.yml');
const MOD_DIR = path.join(PROFILE_DIR, 'node_modules');
const PLUGINS_DATA_DIR = '/root/.dsh/plugins';
const PLUGIN_STATE_FILE = '/root/.dsh/plugins-state.json';

const CORE_PACKAGES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app'
]);

// 内置及核心组件规范中文介绍词典
const PLUGIN_DESCRIPTIONS_ZH = {
  '@deepseek-ai/dsh-base': 'DeepSeek Harness 核心基础运行环境与智能体执行框架',
  '@deepseek-ai/dsh-web-app': 'DeepSeek Harness 官方 Web 图形交互客户端',
  '@deepseek-ai/dsh-experimental-agent-team-profile': '官方 Agent Teams 多智能体协作实验性套件',
  '@deepseek-ai/dsh-experimental-agent-team-web-profile': '官方 Agent Teams Web 端多智能体协作交互界面',
  '@dsh-custom/dsh-browser-desktop': '容器 Chromium 图形浏览器与 noVNC 桌面集成插件，支持 AI 自主浏览网页、多标签管理与实时无损截图',
  '@dsh-custom/dsh-settings-config-path': '配置文件路径展示插件，消除 Web 界面不可点击的「打开配置」按钮并展示真实配置路径',
  'dshmarket': 'DSH 可视化插件市场：在界面内直接浏览、搜索并一键安装/管理社区拓展插件',
  '@hytime/dsh-thinking-effort': '为 DSH 的第三方模型补充可配置的思考强度档位，并支持设置子 Agent 默认思考强度',
  'dsh-client-auto-continue': 'DSH Web 客户端自动继续插件：遇网络波动或异常中断时自动发送本地化续写提示'
};

function readPluginState() {
  try {
    if (fs.existsSync(PLUGIN_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PLUGIN_STATE_FILE, 'utf8'));
      return {
        disabled: Array.isArray(data.disabled) ? data.disabled : [],
        uninstalled: Array.isArray(data.uninstalled) ? data.uninstalled : []
      };
    }
  } catch (err) {
    console.warn('[plugin-manager] 读取 plugins-state.json 警告:', err.message);
  }
  return { disabled: [], uninstalled: [] };
}

function writePluginState(state) {
  try {
    fs.mkdirSync(path.dirname(PLUGIN_STATE_FILE), { recursive: true });
    const payload = {
      disabled: Array.from(new Set(state.disabled || [])),
      uninstalled: Array.from(new Set(state.uninstalled || [])),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(PLUGIN_STATE_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.error('[plugin-manager] 写入 plugins-state.json 失败:', err.message);
    return false;
  }
}

function readPackageJson() {
  try {
    if (fs.existsSync(PKG_PATH)) {
      return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[plugin-manager] 读取 package.json 失败:', err.message);
  }
  return { dependencies: {}, dsh: { profile: { bundles: [] } } };
}

function writePackageJson(pkg) {
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.error('[plugin-manager] 写入 package.json 失败:', err.message);
    throw new Error('写入 package.json 失败: ' + err.message);
  }
}

function cleanPatchForPlugin(pluginName) {
  if (!fs.existsSync(PATCH_PATH)) return;
  try {
    let content = fs.readFileSync(PATCH_PATH, 'utf8');
    let changed = false;

    // 若禁用的插件是 dsh-git-worktree，清理其禁用的 ui-workspace 补丁
    if (pluginName.includes('worktree')) {
      if (content.includes('ui-workspace')) {
        content = content.replace(/- id:\s*ui-workspace[\s\S]*?(?=- |$)/g, '');
        changed = true;
      }
    }

    // 清理该插件自身的 insert 条目
    if (content.includes(pluginName)) {
      const reg = new RegExp(`- (?:id|insert):[\\s\\S]*?${pluginName}[\\s\\S]*?(?=- |$)`, 'g');
      content = content.replace(reg, '');
      changed = true;
    }

    content = content.trim();
    if (!content || content === '') content = '[]';
    if (changed) {
      fs.writeFileSync(PATCH_PATH, content + '\n', 'utf8');
      console.log(`[plugin-manager] 已自动清理 cordis.patch.yml 中关于 ${pluginName} 的补丁条目`);
    }
  } catch (err) {
    console.warn('[plugin-manager] 清理 patch 文件失败:', err.message);
  }
}

function getPlugins() {
  const pkg = readPackageJson();
  const dependencies = pkg.dependencies || {};
  const bundles = (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles))
    ? pkg.dsh.profile.bundles
    : [];

  const pluginState = readPluginState();
  const disabledSet = new Set(pluginState.disabled);
  const uninstalledSet = new Set(pluginState.uninstalled);

  const foundMap = new Map();

  // 1. 扫描 dependencies 与 bundles 列表中的插件
  const registeredNames = new Set([...Object.keys(dependencies), ...bundles]);

  for (const name of registeredNames) {
    const isCore = CORE_PACKAGES.has(name);
    const isCustom = name.startsWith('@dsh-custom/') || name.startsWith('@dsh-external/');
    
    // 如果显式记录在 disabledSet 中，强制视为禁用；否则依据 bundles 判定
    const isEnabled = !disabledSet.has(name) && bundles.includes(name);

    let version = dependencies[name] || '系统核心';
    let description = PLUGIN_DESCRIPTIONS_ZH[name] || '';

    // 查找 package.json 获取真实版本和简介（如未命中内置中文表）
    let targetPkgPath = path.join(MOD_DIR, name, 'package.json');
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

  // 2. 扫描 node_modules 探测未在 package.json 声明的潜在 DSH 拓展
  function inspectDir(dir, pkgName) {
    if (foundMap.has(pkgName)) return;
    const p = path.join(dir, 'package.json');
    if (!fs.existsSync(p)) return;
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      const isDshPlugin = json.dsh ||
        (Array.isArray(json.keywords) && (json.keywords.includes('dsh') || json.keywords.includes('deepseek-harness') || json.keywords.includes('cordis'))) ||
        json.name.startsWith('dsh-') ||
        json.name.startsWith('@dsh-');

      if (isDshPlugin) {
        const desc = PLUGIN_DESCRIPTIONS_ZH[pkgName] || json.description || '暂无功能描述';
        foundMap.set(pkgName, {
          name: pkgName,
          version: json.version || 'unknown',
          description: desc,
          enabled: false,
          isUninstalled: false,
          isCore: false,
          isCustom: false,
          type: 'unregistered',
          source: 'unlinked'
        });
      }
    } catch {}
  }

  if (fs.existsSync(MOD_DIR)) {
    try {
      for (const item of fs.readdirSync(MOD_DIR)) {
        if (item.startsWith('@')) {
          const scopeDir = path.join(MOD_DIR, item);
          if (fs.statSync(scopeDir).isDirectory()) {
            for (const sub of fs.readdirSync(scopeDir)) {
              inspectDir(path.join(scopeDir, sub), item + '/' + sub);
            }
          }
        } else if (!item.startsWith('.')) {
          inspectDir(path.join(MOD_DIR, item), item);
        }
      }
    } catch {}
  }

  // 3. 补充已被卸载但仍内置于镜像底座的 Market 预装插件，便于管理面板直观展示与重新安装
  for (const uninstalledName of uninstalledSet) {
    if (!foundMap.has(uninstalledName)) {
      const globalPkgPath = path.join('/usr/local/lib/node_modules', uninstalledName, 'package.json');
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
        isCustom: false,
        type: 'community',
        source: 'uninstalled'
      });
    }
  }

  const list = Array.from(foundMap.values());
  // 排序：核心组件居首，已安装在先（按启用降序、名称升序），已卸载排在最末
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
  // 仅允许标准合法 npm 包名 (如 "dshmarket", "@scope/package")，彻底杜绝相对路径字符与路径穿越
  const npmRegex = /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;
  return npmRegex.test(name) && !name.includes('..');
}

function togglePlugin(name, enable) {
  if (!isValidPluginName(name)) {
    throw new Error('非法或不安全的插件名称: ' + name);
  }
  if (CORE_PACKAGES.has(name)) {
    throw new Error('系统核心组件 (' + name + ') 不允许禁用，否则会导致系统无法运行');
  }

  const pkg = readPackageJson();
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

  const bundles = pkg.dsh.profile.bundles;
  const index = bundles.indexOf(name);

  const state = readPluginState();
  const disabledSet = new Set(state.disabled);
  const uninstalledSet = new Set(state.uninstalled);

  if (enable) {
    if (index === -1) {
      bundles.push(name);
    }
    disabledSet.delete(name);
    uninstalledSet.delete(name);
  } else {
    if (index !== -1) {
      bundles.splice(index, 1);
    }
    disabledSet.add(name);
    uninstalledSet.delete(name);
    // 禁用时顺便清理该插件在 cordis.patch.yml 中的破坏性补丁
    cleanPatchForPlugin(name);
  }

  writePackageJson(pkg);
  writePluginState({
    disabled: Array.from(disabledSet),
    uninstalled: Array.from(uninstalledSet)
  });

  console.log(`[plugin-manager] 插件 ${name} 已持久化${enable ? '启用' : '禁用'}`);

  return { ok: true, name, enabled: enable };
}

function uninstallPlugin(name) {
  if (!isValidPluginName(name)) {
    throw new Error('非法或不安全的插件名称: ' + name);
  }
  if (CORE_PACKAGES.has(name)) {
    throw new Error('系统核心组件 (' + name + ') 不允许卸载');
  }

  const pkg = readPackageJson();
  let changed = false;

  // 1. 从 bundles 中移除
  if (pkg.dsh?.profile?.bundles && Array.isArray(pkg.dsh.profile.bundles)) {
    const idx = pkg.dsh.profile.bundles.indexOf(name);
    if (idx !== -1) {
      pkg.dsh.profile.bundles.splice(idx, 1);
      changed = true;
    }
  }

  // 2. 从 dependencies 中移除
  if (pkg.dependencies && pkg.dependencies[name]) {
    delete pkg.dependencies[name];
    changed = true;
  }

  if (changed) {
    writePackageJson(pkg);
  }

  // 3. 持久化记录到 plugins-state.json (记录已卸载，防止镜像更新或重启后自动复活)
  const state = readPluginState();
  const disabledSet = new Set(state.disabled);
  const uninstalledSet = new Set(state.uninstalled);
  disabledSet.delete(name);
  uninstalledSet.add(name);
  writePluginState({
    disabled: Array.from(disabledSet),
    uninstalled: Array.from(uninstalledSet)
  });

  // 4. 清除 cordis 补丁残留
  cleanPatchForPlugin(name);

  // 5. 清理 node_modules 目录与插件数据目录 (严格沙箱前缀校验)
  const pluginDir = path.resolve(MOD_DIR, name);
  const resolvedModDir = path.resolve(MOD_DIR);
  if (!pluginDir.startsWith(resolvedModDir + path.sep)) {
    throw new Error('检测到非法越界删除操作，已拦截: ' + pluginDir);
  }

  try {
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[plugin-manager] 删除 node_modules 插件目录失败:', err.message);
  }

  const sanitizedScopeName = name.replace(/^@.*\//, '');
  const dataDir = path.resolve(PLUGINS_DATA_DIR, sanitizedScopeName);
  const resolvedDataDir = path.resolve(PLUGINS_DATA_DIR);
  try {
    if (dataDir.startsWith(resolvedDataDir + path.sep) && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  } catch {}

  console.log(`[plugin-manager] 插件 ${name} 已彻底卸载、清理残留并持久化标记为已卸载`);
  return { ok: true, name, uninstalled: true };
}

function installPlugin(name) {
  if (!isValidPluginName(name)) {
    throw new Error('非法或不安全的插件名称: ' + name);
  }

  const state = readPluginState();
  const disabledSet = new Set(state.disabled);
  const uninstalledSet = new Set(state.uninstalled);
  uninstalledSet.delete(name);
  disabledSet.delete(name);

  const pkg = readPackageJson();
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || { profile: {} };
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

  // 判断是否为全局预装插件 (例如在 /usr/local/lib/node_modules 下)
  const globalPath = path.join('/usr/local/lib/node_modules', name);
  const customPath = path.join('/app/plugins', name.replace(/^@dsh-custom\//, ''));

  let sourcePath = null;
  if (fs.existsSync(globalPath)) {
    sourcePath = globalPath;
  } else if (fs.existsSync(customPath)) {
    sourcePath = customPath;
  }

  if (sourcePath) {
    const scopeDir = path.dirname(path.join(MOD_DIR, name));
    fs.mkdirSync(scopeDir, { recursive: true });
    const targetLink = path.join(MOD_DIR, name);
    try {
      if (fs.existsSync(targetLink) || fs.lstatSync(targetLink).isSymbolicLink()) {
        fs.unlinkSync(targetLink);
      }
    } catch {}
    try {
      fs.symlinkSync(sourcePath, targetLink);
    } catch (e) {
      console.warn(`[plugin-manager] 重新建立插件软链接警告: ${e.message}`);
    }
    pkg.dependencies[name] = 'link:' + sourcePath;
  }

  if (!pkg.dsh.profile.bundles.includes(name)) {
    pkg.dsh.profile.bundles.push(name);
  }

  writePackageJson(pkg);
  writePluginState({
    disabled: Array.from(disabledSet),
    uninstalled: Array.from(uninstalledSet)
  });

  console.log(`[plugin-manager] 插件 ${name} 已重新安装并恢复启用`);
  return { ok: true, name, installed: true };
}

module.exports = {
  getPlugins,
  togglePlugin,
  uninstallPlugin,
  installPlugin,
  readPluginState,
  writePluginState,
  PLUGIN_DESCRIPTIONS_ZH
};
