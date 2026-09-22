const fs = require('fs');
const path = require('path');

// M11：DSH_HOME 可迁移（非 root 部署），默认 /root
const DSH_HOME = process.env.DSH_HOME || '/root';
const PROFILE_DIR = path.join(DSH_HOME, '.dsh/profiles/web');
const PKG_PATH = path.join(PROFILE_DIR, 'package.json');
// 注意（官方 0.1.7 起）：该 Profile 补丁文件同时是「DSH 设置」的权威存储（dsh-config-editor 落盘于此）。
// 因此对它的任何读写都必须只按插件名做块级增删，绝不整体重写或写空为其它形态；
// 容器级设置预设一律放 Home 级补丁 $DSH_HOME/.dsh/cordis.patch.yml（见 install-plugin.mjs 第 7 节）。
const PATCH_PATH = path.join(PROFILE_DIR, 'cordis.patch.yml');
const MOD_DIR = path.join(PROFILE_DIR, 'node_modules');
const PLUGINS_DATA_DIR = path.join(DSH_HOME, '.dsh/plugins');
const PLUGIN_STATE_FILE = path.join(DSH_HOME, '.dsh/plugins-state.json');

// ── P6：与 DSH 共享 profile 写锁 ─────────────────────────────────────────
// 官方 0.1.7 的原生插件管理器 / 设置编辑器在改 profile 前会取
// `profiles/web/package.json.lock`（wx 独占）。我们此前不参与该锁，
// 两边各自"读-改-写"整份文件 ⇒ 后写者覆盖先写者（插件状态漂移、设置被吞）。
// 现在所有 profile 写操作都必须包在 withProfileLock 内；writePackageJson 与补丁写入
// 都带 assertProfileLockHeld 运行时护栏，忘记加锁会立即报错而不是静默丢更新。
const {
  withProfileLock,
  assertProfileLockHeld,
  profileLockPath
} = require(path.join(__dirname, '..', 'scripts', 'profile-lock.cjs'));

// ── P6：cordis.patch.yml 改为"外科手术式"删除 + 安全闸 ──────────────────
// 该文件同时是 DSH 设置的权威存储（含 `- id: llm-pi-ai` 模型 provider 配置）。
const {
  removePatchEntries,
  assertPatchSafe,
  topLevelEntryIds
} = require(path.join(__dirname, '..', 'scripts', 'patch-yaml.cjs'));

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

// 原子写：先写临时文件再 rename，避免进程被杀 / 磁盘满时留下截断的 JSON/YAML（那会让 DSH 起不来）
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writePluginState(state) {
  try {
    fs.mkdirSync(path.dirname(PLUGIN_STATE_FILE), { recursive: true });
    const payload = {
      disabled: Array.from(new Set(state.disabled || [])),
      uninstalled: Array.from(new Set(state.uninstalled || [])),
      updatedAt: new Date().toISOString()
    };
    atomicWrite(PLUGIN_STATE_FILE, JSON.stringify(payload, null, 2) + '\n');
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
  // P6 护栏：写 profile 必须在写锁内。忘记加锁时立即抛 PROFILE_LOCK_NOT_HELD，
  // 而不是静默产生丢更新（该抛错不会被下面的 try 吞掉）。
  assertProfileLockHeld(PROFILE_DIR);
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    atomicWrite(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
    return true;
  } catch (err) {
    console.error('[plugin-manager] 写入 package.json 失败:', err.message);
    throw new Error('写入 package.json 失败: ' + err.message);
  }
}

// 条目级删除实现已抽到 scripts/patch-yaml.cjs（外科手术式：只删命中条目的字符区间，
// 其余字节逐字保留，避免"拆行-过滤-重排"吞掉 DSH 并发写入或改变文档形态）。
// 这里继续 re-export `removePatchEntries` 以保持既有测试与调用方兼容。

/**
 * 清除 cordis.patch.yml 中提到该插件的条目（**必须在 profile 写锁内调用**）。
 * 采用外科手术式删除 + 安全闸：只删命中条目的字符区间，其余字节逐字保留；
 * 任何会波及 `llm-pi-ai` 等非本插件条目的改写都会被 assertPatchSafe 拦下并放弃写入。
 * @returns {boolean} 是否真的发生了写入
 */
function cleanPatchForPluginLocked(pluginName) {
  if (!fs.existsSync(PATCH_PATH)) return false;
  assertProfileLockHeld(PROFILE_DIR);
  try {
    const before = fs.readFileSync(PATCH_PATH, 'utf8');
    let content = before;
    let changed = false;
    const removedIds = [];

    // 若禁用的插件是 dsh-git-worktree，清理其禁用的 ui-workspace 补丁
    if (pluginName.includes('worktree')) {
      const r = removePatchEntries(content, (block) => /\bid:\s*ui-workspace\b/.test(block));
      if (r.removed > 0) { content = r.text; changed = true; removedIds.push(...r.removedIds); }
    }

    // 清理提到该插件名的条目（按条目整体删除，不做跨行正则）
    if (content.includes(pluginName)) {
      const esc = pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc);
      const r = removePatchEntries(content, (block) => re.test(block));
      if (r.removed > 0) { content = r.text; changed = true; removedIds.push(...r.removedIds); }
    }

    if (!changed) return false;

    content = content.trim();
    if (!content) content = '[]';
    // 安全闸：不允许丢失任何非本插件的顶层条目（尤其 llm-pi-ai 模型配置）
    assertPatchSafe({ before, after: content, removedIds });
    atomicWrite(PATCH_PATH, content + '\n');
    console.log(`[plugin-manager] 已自动清理 cordis.patch.yml 中关于 ${pluginName} 的补丁条目`);
    return true;
  } catch (err) {
    // 安全闸拦下属于"拒绝写入"，必须显式告警，绝不能静默
    console.error(`[plugin-manager] 清理 cordis.patch.yml 已放弃（未写入）: ${err.message}`);
    return false;
  }
}

/** 对外入口：自行获取 profile 写锁后清理 */
async function cleanPatchForPlugin(pluginName) {
  return withProfileLock(
    PROFILE_DIR,
    async () => cleanPatchForPluginLocked(pluginName),
    { label: `cleanPatch:${pluginName}` }
  );
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

async function togglePlugin(name, enable) {
  if (!isValidPluginName(name)) {
    throw new Error('非法或不安全的插件名称: ' + name);
  }
  if (CORE_PACKAGES.has(name)) {
    throw new Error('系统核心组件 (' + name + ') 不允许禁用，否则会导致系统无法运行');
  }

  // P6：整个"读 package.json → 改 bundles → 写回"必须在同一把 profile 写锁内完成，
  // 否则会与 DSH 原生插件管理器的并发写互相覆盖（丢更新）。
  return withProfileLock(PROFILE_DIR, async () => {
    const pkg = readPackageJson();
    const pkgSnapshot = JSON.stringify(pkg, null, 2) + '\n'; // 供状态写失败时回滚
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
      // 禁用时顺便清理该插件在 cordis.patch.yml 中的破坏性补丁（已在锁内，直接调 locked 版本）
      cleanPatchForPluginLocked(name);
    }

    writePackageJson(pkg);
    const stateOk = writePluginState({
      disabled: Array.from(disabledSet),
      uninstalled: Array.from(uninstalledSet)
    });
    if (!stateOk) {
      // 状态文件写失败：回滚 package.json，避免内存/磁盘分叉（被禁用的插件重启后"复活"）
      try { atomicWrite(PKG_PATH, pkgSnapshot); } catch {}
      throw new Error('插件状态持久化失败（已回滚 package.json），请检查数据卷权限与磁盘空间');
    }

    console.log(`[plugin-manager] 插件 ${name} 已持久化${enable ? '启用' : '禁用'}`);

    return { ok: true, name, enabled: enable };
  }, { label: `toggle:${name}` });
}

async function uninstallPlugin(name) {
  if (!isValidPluginName(name)) {
    throw new Error('非法或不安全的插件名称: ' + name);
  }
  if (CORE_PACKAGES.has(name)) {
    throw new Error('系统核心组件 (' + name + ') 不允许卸载');
  }

  // P6：profile 的"读-改-写 + 状态 + 补丁清理"整体放进同一把写锁；
  // 下方 node_modules / 数据目录的物理删除与 profile 无关，放到锁外以免长时间占锁。
  await withProfileLock(PROFILE_DIR, async () => {
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

    // 4. 清除 cordis 补丁残留（锁内直接调 locked 版本）
    cleanPatchForPluginLocked(name);
  }, { label: `uninstall:${name}` });

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

async function installPlugin(name) {
  if (!isValidPluginName(name)) {
    throw new Error('非法或不安全的插件名称: ' + name);
  }

  // P6：软链建立 + package.json 读改写 + 状态持久化整体进同一把写锁
  await withProfileLock(PROFILE_DIR, async () => {
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
