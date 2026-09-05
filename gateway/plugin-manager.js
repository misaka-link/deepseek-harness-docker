const fs = require('fs');
const path = require('path');

const PROFILE_DIR = '/root/.dsh/profiles/web';
const PKG_PATH = path.join(PROFILE_DIR, 'package.json');
const PATCH_PATH = path.join(PROFILE_DIR, 'cordis.patch.yml');
const MOD_DIR = path.join(PROFILE_DIR, 'node_modules');
const PLUGINS_DATA_DIR = '/root/.dsh/plugins';

const CORE_PACKAGES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app'
]);

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

  const foundMap = new Map();

  // 1. 扫描 dependencies 与 bundles 列表中的插件
  const registeredNames = new Set([...Object.keys(dependencies), ...bundles]);

  for (const name of registeredNames) {
    const isCore = CORE_PACKAGES.has(name);
    const isCustom = name.startsWith('@dsh-custom/') || name.startsWith('@dsh-external/');
    const isEnabled = bundles.includes(name);

    let version = dependencies[name] || '系统核心';
    let description = '';

    // 查找 package.json 获取真实版本和简介
    let targetPkgPath = path.join(MOD_DIR, name, 'package.json');
    if (!fs.existsSync(targetPkgPath) && dependencies[name] && dependencies[name].startsWith('link:')) {
      const linkTarget = dependencies[name].replace(/^link:/, '');
      targetPkgPath = path.join(linkTarget, 'package.json');
    }

    if (fs.existsSync(targetPkgPath)) {
      try {
        const modPkg = JSON.parse(fs.readFileSync(targetPkgPath, 'utf8'));
        if (modPkg.version) version = modPkg.version;
        if (modPkg.description) description = modPkg.description;
      } catch {}
    }

    foundMap.set(name, {
      name,
      version,
      description,
      enabled: isEnabled,
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
        foundMap.set(pkgName, {
          name: pkgName,
          version: json.version || 'unknown',
          description: json.description || '',
          enabled: false,
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

  const list = Array.from(foundMap.values());
  // 排序：核心组件居首，随后按启用状态降序、名称升序
  list.sort((a, b) => {
    if (a.isCore && !b.isCore) return -1;
    if (!a.isCore && b.isCore) return 1;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { ok: true, plugins: list };
}

function togglePlugin(name, enable) {
  if (CORE_PACKAGES.has(name)) {
    throw new Error('系统核心组件 (' + name + ') 不允许禁用，否则会导致系统无法运行');
  }

  const pkg = readPackageJson();
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

  const bundles = pkg.dsh.profile.bundles;
  const index = bundles.indexOf(name);

  if (enable) {
    if (index === -1) {
      bundles.push(name);
    }
  } else {
    if (index !== -1) {
      bundles.splice(index, 1);
    }
    // 禁用时顺便清理该插件在 cordis.patch.yml 中的破坏性补丁
    cleanPatchForPlugin(name);
  }

  writePackageJson(pkg);
  console.log(`[plugin-manager] 插件 ${name} 已${enable ? '启用' : '禁用'}`);

  return { ok: true, name, enabled: enable };
}

function uninstallPlugin(name) {
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

  // 3. 清除 cordis 补丁残留
  cleanPatchForPlugin(name);

  // 4. 清理 node_modules 目录与插件数据目录
  const pluginDir = path.join(MOD_DIR, name);
  try {
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[plugin-manager] 删除 node_modules 插件目录失败:', err.message);
  }

  const dataDir = path.join(PLUGINS_DATA_DIR, name.replace(/^@.*\//, ''));
  try {
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  } catch {}

  console.log(`[plugin-manager] 插件 ${name} 已彻底卸载并清理残留`);
  return { ok: true, name, uninstalled: true };
}

module.exports = {
  getPlugins,
  togglePlugin,
  uninstallPlugin
};
