#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const profileDir = '/root/.dsh/profiles/web';
const pkgPath = path.join(profileDir, 'package.json');
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const linkDir = path.join(profileDir, 'node_modules/@dsh-custom');
const targetLink = path.join(linkDir, 'dsh-browser-desktop');
const pluginSource = '/app/plugins/dsh-browser-desktop';
const stateFile = '/root/.dsh/plugins-state.json';

fs.mkdirSync(linkDir, { recursive: true });

function readPluginState() {
  try {
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return {
        disabled: Array.isArray(data.disabled) ? data.disabled : [],
        uninstalled: Array.isArray(data.uninstalled) ? data.uninstalled : []
      };
    }
  } catch (e) {
    console.warn('[install-plugin] 读取 plugins-state.json 警告:', e.message);
  }
  return { disabled: [], uninstalled: [] };
}

function writePluginState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      disabled: Array.from(new Set(state.disabled || [])),
      uninstalled: Array.from(new Set(state.uninstalled || [])),
      updatedAt: new Date().toISOString()
    }, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.warn('[install-plugin] 写入 plugins-state.json 警告:', e.message);
  }
}

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
        if (!fs.existsSync(target)) {
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
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
      fs.symlinkSync(src, linkPath);
      console.log('[install-plugin] 建立 schemastery 依赖软链接成功');
    } catch {}
    break;
  }
}

// 2. 自动注册并配置 @dsh-custom/dsh-browser-desktop (尊重用户持久化偏好)
const browserDesktopName = '@dsh-custom/dsh-browser-desktop';
const isBrowserDesktopUninstalled = pluginState.uninstalled.includes(browserDesktopName);
const isBrowserDesktopDisabled = pluginState.disabled.includes(browserDesktopName);

if (isBrowserDesktopUninstalled) {
  console.log('[install-plugin] 用户已明确卸载 dsh-browser-desktop，跳过装配');
  try {
    if (fs.existsSync(targetLink) || fs.lstatSync(targetLink).isSymbolicLink()) fs.unlinkSync(targetLink);
  } catch {}
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      let ch = false;
      if (pkg.dependencies && pkg.dependencies[browserDesktopName]) {
        delete pkg.dependencies[browserDesktopName];
        ch = true;
      }
      if (pkg.dsh?.profile?.bundles?.includes(browserDesktopName)) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== browserDesktopName);
        ch = true;
      }
      if (ch) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    } catch {}
  }
} else {
  try {
    if (fs.existsSync(targetLink) || fs.lstatSync(targetLink).isSymbolicLink()) fs.unlinkSync(targetLink);
    fs.symlinkSync(pluginSource, targetLink);
    console.log('[install-plugin] 建立插件目录软链接成功:', targetLink);
  } catch (e) {
    console.warn('[install-plugin] 建立软链接失败:', e.message);
  }

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
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
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    } catch (e) {
      console.warn('[install-plugin] 更新 package.json 失败:', e.message);
    }
  }
}

// 3. 清除 cordis.patch.yml 中的重复 insert 项 (按顶级条目结构化过滤，绝不误伤相邻插件)
if (fs.existsSync(patchPath)) {
  try {
    const rawYaml = fs.readFileSync(patchPath, 'utf8');
    if (rawYaml.includes('- insert:') && rawYaml.includes('dsh-browser-desktop')) {
      const lines = rawYaml.split('\n');
      const entries = [];
      let current = [];
      let header = [];
      let started = false;

      for (const line of lines) {
        if (/^-\s+/.test(line)) {
          started = true;
          if (current.length > 0) entries.push(current.join('\n'));
          current = [line];
        } else if (!started) {
          header.push(line);
        } else {
          current.push(line);
        }
      }
      if (current.length > 0) entries.push(current.join('\n'));

      const filtered = entries.filter(e => !e.includes('dsh-browser-desktop') || !/insert:/i.test(e));
      const res = (header.length > 0 ? header.join('\n') + '\n' : '') + filtered.join('\n');
      fs.writeFileSync(patchPath, res.trim() + '\n', 'utf8');
      console.log('[install-plugin] 清除 cordis.patch.yml 中多余的 insert 条目成功');
    }
  } catch (e) {
    console.warn('[install-plugin] 处理 cordis.patch.yml 失败:', e.message);
  }
}

// 4. 自动在 DSH 存储库中初始化默认工作区
const wsStoragePath = '/root/.dsh/storages/workspace.json';
const defaultWsPath = process.env.DSH_WORKSPACE || '/workspace';
fs.mkdirSync('/root/.dsh/storages', { recursive: true });

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
    fs.writeFileSync(wsStoragePath, JSON.stringify(wsData, null, 2) + '\n', 'utf8');
    console.log('[install-plugin] 成功为 DSH 注册初始默认工作区:', defaultWsPath);
  }
} catch (e) {
  console.warn('[install-plugin] 初始化默认工作区失败:', e.message);
}

// 5. 自动注册 dsh-settings-config-path 插件到 Web Profile (尊重用户持久化偏好)
const pathPluginSource = '/app/plugins/dsh-settings-config-path';
const pathPluginTargetLink = path.join(linkDir, 'dsh-settings-config-path');
const configPathPluginName = '@dsh-custom/dsh-settings-config-path';
const isConfigPathUninstalled = pluginState.uninstalled.includes(configPathPluginName);
const isConfigPathDisabled = pluginState.disabled.includes(configPathPluginName);

if (isConfigPathUninstalled) {
  console.log('[install-plugin] 用户已明确卸载 dsh-settings-config-path，跳过装配');
  try {
    if (fs.existsSync(pathPluginTargetLink) || fs.lstatSync(pathPluginTargetLink).isSymbolicLink()) fs.unlinkSync(pathPluginTargetLink);
  } catch {}
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      let ch = false;
      if (pkg.dependencies && pkg.dependencies[configPathPluginName]) {
        delete pkg.dependencies[configPathPluginName];
        ch = true;
      }
      if (pkg.dsh?.profile?.bundles?.includes(configPathPluginName)) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== configPathPluginName);
        ch = true;
      }
      if (ch) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    } catch {}
  }
} else if (fs.existsSync(pathPluginSource)) {
  try {
    if (fs.existsSync(pathPluginTargetLink) || fs.lstatSync(pathPluginTargetLink).isSymbolicLink()) fs.unlinkSync(pathPluginTargetLink);
    fs.symlinkSync(pathPluginSource, pathPluginTargetLink);
    console.log('[install-plugin] 建立 dsh-settings-config-path 软链接成功');
  } catch (e) {}

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies[configPathPluginName] = 'link:' + pathPluginSource;
      pkg.dsh = pkg.dsh || { profile: {} };
      pkg.dsh.profile = pkg.dsh.profile || {};
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

      if (isConfigPathDisabled) {
        if (pkg.dsh.profile.bundles.includes(configPathPluginName)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== configPathPluginName);
        }
        console.log('[install-plugin] 用户已显式禁用 dsh-settings-config-path，保持停用状态 (不加入 bundles)');
      } else {
        if (!pkg.dsh.profile.bundles.includes(configPathPluginName)) {
          pkg.dsh.profile.bundles.push(configPathPluginName);
        }
        console.log('[install-plugin] 注册 dsh-settings-config-path 到 package.json 成功');
      }
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    } catch (e) {}
  }
}

// 6. 自动识别并装配已预装的 Market 插件 (从 plugins.market.list 动态同步，并完全尊重用户禁用/卸载偏好)
const marketPlugins = [
  { id: 'dshmarket', name: 'dshmarket', path: '/usr/local/lib/node_modules/dshmarket' },
  { id: 'dsh-thinking-effort', name: '@hytime/dsh-thinking-effort', path: '/usr/local/lib/node_modules/@hytime/dsh-thinking-effort' }
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
          path: path.join('/usr/local/lib/node_modules', clean)
        });
      }
    }
  } catch {}
}

for (const p of marketPlugins) {
  const isMarketUninstalled = pluginState.uninstalled.includes(p.name);
  const isMarketDisabled = pluginState.disabled.includes(p.name);

  // 若用户已显式卸载，保持卸载状态，清理残留软链接与引用，绝对不重新装配！
  if (isMarketUninstalled) {
    console.log(`[install-plugin] 用户已明确卸载 ${p.name}，保持卸载状态 (跳过装配)`);
    const targetLnk = path.join(profileDir, 'node_modules', p.name);
    try {
      if (fs.existsSync(targetLnk) || fs.lstatSync(targetLnk).isSymbolicLink()) fs.unlinkSync(targetLnk);
    } catch {}
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        let ch = false;
        if (pkg.dependencies && pkg.dependencies[p.name]) {
          delete pkg.dependencies[p.name];
          ch = true;
        }
        if (pkg.dsh?.profile?.bundles?.includes(p.name)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== p.name);
          ch = true;
        }
        if (ch) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      } catch {}
    }
    continue;
  }

  if (fs.existsSync(p.path)) {
    try {
      const scopeDir = path.dirname(path.join(profileDir, 'node_modules', p.name));
      fs.mkdirSync(scopeDir, { recursive: true });
      const targetLnk = path.join(profileDir, 'node_modules', p.name);
      if (fs.existsSync(targetLnk) || fs.lstatSync(targetLnk).isSymbolicLink()) fs.unlinkSync(targetLnk);
      fs.symlinkSync(p.path, targetLnk);

      // 确保插件内部 node_modules/@deepseek-ai 指向全局依赖 (使用 lstatSync 处理悬空软链)
      const peerLinkDir = path.join(p.path, 'node_modules/@deepseek-ai');
      try {
        try {
          if (fs.lstatSync(peerLinkDir).isSymbolicLink() || fs.existsSync(peerLinkDir)) {
            fs.unlinkSync(peerLinkDir);
          }
        } catch {}
        if (dshCoreModules) {
          fs.mkdirSync(path.dirname(peerLinkDir), { recursive: true });
          fs.symlinkSync(dshCoreModules, peerLinkDir);
        }
      } catch (e) {}

      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
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
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      }
    } catch (e) {
      console.warn(`[install-plugin] 自动装配 Market 插件失败 (${p.name}):`, e.message);
    }
  } else {
    // 插件未安装（纯净基础镜像），清理 package.json 中残留的 bundle 引用
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
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
          fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
          console.log(`[install-plugin] 基础镜像已自动清理未装配插件引用: ${p.name}`);
        }
      } catch (e) {}
    }
  }
}

// 7. 确保 dsh-market 禁用独立进程重启 (由容器 dsh-manager 统一守护，防止双重启端口冲突)
const settingsPath = '/root/.dsh/settings.yaml';
try {
  if (fs.existsSync(settingsPath)) {
    let sContent = fs.readFileSync(settingsPath, 'utf8');
    if (!sContent.includes('dsh-market:')) {
      sContent += '\ndsh-market:\n  allowRestart: false\n';
      fs.writeFileSync(settingsPath, sContent, 'utf8');
      console.log('[install-plugin] 成功注入 dsh-market.allowRestart: false 到 settings.yaml');
    }
  }
} catch (e) {}
