#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const profileDir = '/root/.dsh/profiles/web';
const pkgPath = path.join(profileDir, 'package.json');
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const linkDir = path.join(profileDir, 'node_modules/@dsh-custom');
const targetLink = path.join(linkDir, 'dsh-browser-desktop');
const pluginSource = '/app/plugins/dsh-browser-desktop';

fs.mkdirSync(linkDir, { recursive: true });

// 1. 建立插件依赖软链接 (schemastery)
const possibleSchemasterySources = [
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery',
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

// 2. 建立 node_modules junction / symlink
try {
  if (fs.existsSync(targetLink)) fs.unlinkSync(targetLink);
  fs.symlinkSync(pluginSource, targetLink);
  console.log('[install-plugin] 建立插件目录软链接成功:', targetLink);
} catch (e) {
  console.warn('[install-plugin] 建立软链接失败:', e.message);
}

// 3. 注入 profile package.json (bundles 列表与 dependencies link)
if (fs.existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies['@dsh-custom/dsh-browser-desktop'] = 'link:' + pluginSource;
    pkg.dsh = pkg.dsh || { profile: {} };
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
    if (!pkg.dsh.profile.bundles.includes('@dsh-custom/dsh-browser-desktop')) {
      pkg.dsh.profile.bundles.push('@dsh-custom/dsh-browser-desktop');
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[install-plugin] 注册 bundle 依赖到 package.json 成功');
  } catch (e) {
    console.warn('[install-plugin] 更新 package.json 失败:', e.message);
  }
}

// 4. 清除 cordis.patch.yml 中的重复 insert 项
if (fs.existsSync(patchPath)) {
  try {
    let content = fs.readFileSync(patchPath, 'utf8');
    if (content.includes('- insert:') && content.includes('dsh-browser-desktop')) {
      content = content.replace(/- insert:[\s\S]*?dsh-browser-desktop[\s\S]*?(?=- |$)/g, '').trim();
      if (!content || content === '') content = '[]';
      fs.writeFileSync(patchPath, content + '\n', 'utf8');
      console.log('[install-plugin] 清除 cordis.patch.yml 中多余的 insert 条目成功');
    }
  } catch (e) {}
}

// 5. 自动在 DSH 存储库中初始化默认工作区
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

// 6. 自动注册 dsh-settings-config-path 插件到 Web Profile (显示只读路径)
const pathPluginSource = '/app/plugins/dsh-settings-config-path';
const pathPluginTargetLink = path.join(linkDir, 'dsh-settings-config-path');

if (fs.existsSync(pathPluginSource)) {
  try {
    if (fs.existsSync(pathPluginTargetLink)) fs.unlinkSync(pathPluginTargetLink);
    fs.symlinkSync(pathPluginSource, pathPluginTargetLink);
    console.log('[install-plugin] 建立 dsh-settings-config-path 软链接成功');
  } catch (e) {}

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies['@dsh-custom/dsh-settings-config-path'] = 'link:' + pathPluginSource;
      pkg.dsh = pkg.dsh || { profile: {} };
      pkg.dsh.profile = pkg.dsh.profile || {};
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
      if (!pkg.dsh.profile.bundles.includes('@dsh-custom/dsh-settings-config-path')) {
        pkg.dsh.profile.bundles.push('@dsh-custom/dsh-settings-config-path');
      }
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log('[install-plugin] 注册 dsh-settings-config-path 到 package.json 成功');
    } catch (e) {}
  }
}

// 7. 自动识别并装配已预装的 Market 插件 (如 dshmarket, @hytime/dsh-thinking-effort)
const marketPlugins = [
  { id: 'dshmarket', name: 'dshmarket', path: '/usr/local/lib/node_modules/dshmarket' },
  { id: 'dsh-thinking-effort', name: '@hytime/dsh-thinking-effort', path: '/usr/local/lib/node_modules/@hytime/dsh-thinking-effort' }
];

for (const p of marketPlugins) {
  if (fs.existsSync(p.path)) {
    try {
      const scopeDir = path.dirname(path.join(profileDir, 'node_modules', p.name));
      fs.mkdirSync(scopeDir, { recursive: true });
      const targetLnk = path.join(profileDir, 'node_modules', p.name);
      if (fs.existsSync(targetLnk)) fs.unlinkSync(targetLnk);
      fs.symlinkSync(p.path, targetLnk);

      // 确保插件内部 node_modules/@deepseek-ai 指向全局依赖
      const peerLinkDir = path.join(p.path, 'node_modules/@deepseek-ai');
      if (!fs.existsSync(peerLinkDir)) {
        fs.mkdirSync(path.dirname(peerLinkDir), { recursive: true });
        fs.symlinkSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai', peerLinkDir);
      }

      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies[p.name] = 'link:' + p.path;
        pkg.dsh = pkg.dsh || { profile: {} };
        pkg.dsh.profile = pkg.dsh.profile || {};
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
        if (!pkg.dsh.profile.bundles.includes(p.name)) {
          pkg.dsh.profile.bundles.push(p.name);
        }
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        console.log(`[install-plugin] 自动装配预装 Market 插件: ${p.name}`);
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
