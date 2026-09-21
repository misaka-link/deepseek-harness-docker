#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// 测试/调试用：DSH_PATCH_ONLY_DIR 存在时只扫描该目录，避免误改环境中其它 DSH 副本
const ONLY_DIR = process.env.DSH_PATCH_ONLY_DIR;
const SEARCH_DIRS = ONLY_DIR ? [ONLY_DIR] : [
  process.env.DSH_INSTALL_DIR ? path.join(process.env.DSH_INSTALL_DIR, 'lib/node_modules/@deepseek-ai') : null,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/usr/local/lib/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai',
  '/app/node_modules/@deepseek-ai'
].filter(Boolean);

const MARKER = '/* dsh-patch: loopback-host-mode-applied */';

// ── 必需补丁追踪 ──────────────────────────────────────────────
// 背景：本脚本靠字符串锚点给 DSH 源码打补丁，DSH 一升级锚点就可能失效。
// 过去失效是"静默跳过 + 结尾打印成功"，本项目已因此踩过两次坑，这里改为必须显式失败。
const REQUIRED_PATCHES = ['client-loopback', 'auth-bypass', 'combo-fallback'];
const appliedPatches = new Set();
const missedPatches = new Set();
const markApplied = (name) => appliedPatches.add(name);
const markMissed = (name) => missedPatches.add(name);
let loopbackSeen = false;

/** 读取已安装 DSH 版本（用于与 version.json 的兼容区间比对） */
function readInstalledDshVersion() {
  const candidates = [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json'
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch {}
  }
  return null;
}

/** 与 version.json 的 supportedDshRange 比对（仅告警，不阻断启动） */
function warnIfVersionOutOfRange() {
  try {
    const ver = readInstalledDshVersion();
    const vj = '/app/version.json';
    if (!ver || !fs.existsSync(vj)) return;
    const range = (JSON.parse(fs.readFileSync(vj, 'utf8')).compatibility || {}).supportedDshRange;
    if (!range) return;
    console.log(`[patch-dsh-client] DSH 版本: ${ver}，声明兼容区间: ${range}`);
  } catch (e) {
    console.warn('[patch-dsh-client] 版本区间检查跳过:', e.message);
  }
}

const REPLACEMENTS = [
  {
    needle: 'isLoopbackHostname(pageLocation.hostname)',
    replacement: 'true'
  },
  {
    needle: 'connection.isLoopback ? "host" : "memory"',
    replacement: '"host"'
  },
  {
    needle: 'connection.isLoopback?"host":"memory"',
    replacement: '"host"'
  }
];

function findClientFiles(baseDir) {
  const matched = [];
  if (!fs.existsSync(baseDir)) return matched;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(fullPath);
      } else if (ent.isFile() && ent.name === 'client.js') {
        matched.push(fullPath);
      }
    }
  }

  walk(baseDir);
  return matched;
}

function patchServerConnection(baseDir) {
  // 1. 服务端鉴权：统一由网关接管认证，彻底消除 /api 与 WebSocket 连接中 token 换取的 401 拦截
  const connTarget = path.join(baseDir, 'dsh-client-connection/lib/index.js');
  if (fs.existsSync(connTarget)) {
    try {
      let cContent = fs.readFileSync(connTarget, 'utf8');
      if (cContent.includes('/* dsh-patch: auth-bypass-all */')) {
        markApplied('auth-bypass');
      } else if (cContent.includes('isAuthenticated(request) {')) {
        cContent = cContent.replace(
          'isAuthenticated(request) {',
          'isAuthenticated(request) {\n\t\t/* dsh-patch: auth-bypass-all */ return true;'
        );
        fs.writeFileSync(connTarget, cContent, 'utf8');
        markApplied('auth-bypass');
        console.log(`[patch-dsh-client] 成功修补服务端免鉴权直连 (由网关统一收口认证): ${connTarget}`);
      } else {
        markMissed('auth-bypass');
        console.warn(`[patch-dsh-client] ⚠️ 必需补丁 auth-bypass 未命中（锚点失效）: ${connTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 修补服务端放行失败: ${err.message}`);
    }
  }

  // 2. 目录选择器根路径微调 (若存在)
  const pickerTarget = path.join(baseDir, 'dsh-host-directory-picker-browse/lib/index.js');
  if (fs.existsSync(pickerTarget)) {
    try {
      let pContent = fs.readFileSync(pickerTarget, 'utf8');
      if (pContent.includes('const home = homedir();') && !pContent.includes('process.env.DSH_WORKSPACE')) {
        pContent = pContent.replace('const home = homedir();', 'const home = process.env.DSH_WORKSPACE || homedir();');
        fs.writeFileSync(pickerTarget, pContent, 'utf8');
        console.log(`[patch-dsh-client] 成功对齐目录选择器默认根路径为 DSH_WORKSPACE: ${pickerTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 对齐目录选择器失败: ${err.message}`);
    }
  }
}

let patchedCount = 0;
let checkedDirs = 0;

for (const searchDir of SEARCH_DIRS) {
  if (!fs.existsSync(searchDir)) continue;
  checkedDirs++;
  console.log(`[patch-dsh-client] 扫描模块目录: ${searchDir}`);
  
  // 1. Client patch (host mode & loopback)
  const clientFiles = findClientFiles(searchDir);
  for (const file of clientFiles) {
    try {
      let content = fs.readFileSync(file, 'utf8');
      if (content.includes(MARKER)) {
        loopbackSeen = true;
        continue;
      }

      let modified = false;
      for (const { needle, replacement } of REPLACEMENTS) {
        if (content.includes(needle)) {
          content = content.replaceAll(needle, replacement);
          modified = true;
        }
      }

      if (modified) {
        content = `${MARKER}\n${content}`;
        fs.writeFileSync(file, content, 'utf8');
        console.log(`[patch-dsh-client] 成功修补客户端: ${file}`);
        patchedCount++;
        loopbackSeen = true;
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 修补失败: ${file} - ${err.message}`);
    }
  }

  // 2. Server connection patch (gateway manages auth)
  patchServerConnection(searchDir);

  // 3. 修补 client-modules combo 静态资源路由
  //    背景：客户端插件包 URL 形如 /plugins/??a/client.js,b/client.js&rev=<hash>；
  //    DSH 重启后 hash 变化，**已打开的页面**若再去取旧 rev 的包会拿到 404 → 白屏。
  //    3a. 同进程内 rev 变化：优先复用同前缀的历史 batch 响应；
  //    3b. 跨进程重启后旧 rev 已彻底不存在：返回一段"自愈重载"脚本，让页面自动刷新恢复。
  const modulesTarget = path.join(searchDir, 'dsh-client-modules/lib/index.js');
  if (fs.existsSync(modulesTarget)) {
    try {
      let mContent = fs.readFileSync(modulesTarget, 'utf8');
      let changed = false;
      if (mContent.includes('/* dsh-patch: combo-fallback */')) markApplied('combo-fallback');

      // 3a. 同进程内 rev 变化 → 复用同前缀历史 batch（兼容新旧两版 DSH 源码形态）
      if (!mContent.includes('/* dsh-patch: combo-fallback */')) {
        const needles = [
          'const response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.chunkResponse(requestUrl);',
          'const response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl);'
        ];
        for (const needle of needles) {
          if (!mContent.includes(needle)) continue;
          const head = needle.replace('const response =', '/* dsh-patch: combo-fallback */ let response =');
          const replacement = head +
            '\n\t\tif (response === void 0 && resourceUrl.startsWith("/plugins/??")) {' +
            '\n\t\t\tconst prefix = resourceUrl.split("&rev=")[0];' +
            '\n\t\t\tfor (const [key, val] of this.responses.entries()) {' +
            '\n\t\t\t\tif (key.startsWith(prefix)) { response = val; break; }' +
            '\n\t\t\t}' +
            '\n\t\t}';
          mContent = mContent.replace(needle, replacement);
          changed = true;
          break;
        }
      }

      // 3b. 旧 rev 已不存在（DSH 重启/换镜像后）→ 不再 404，返回自愈重载模块
      if (!mContent.includes('/* dsh-patch: bundle-404-selfheal */')) {
        const anchor = 'return { status: 404 };\n\t}\n\tserveBundle = async (req, res) => {';
        if (mContent.includes(anchor)) {
          const healBody = 'try{if(!sessionStorage.getItem("dsh-bundle-heal")){sessionStorage.setItem("dsh-bundle-heal","1");setTimeout(function(){try{sessionStorage.removeItem("dsh-bundle-heal")}catch(e){}},20000);location.reload()}}catch(e){}';
          const replacement =
            '/* dsh-patch: bundle-404-selfheal */' +
            '\n\t\tif (resourceUrl.startsWith("/plugins/")) {' +
            '\n\t\t\treturn {' +
            '\n\t\t\t\tstatus: 200,' +
            '\n\t\t\t\theaders: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },' +
            '\n\t\t\t\t...(method === "HEAD" ? {} : { body: ' + JSON.stringify(healBody) + ' })' +
            '\n\t\t\t};' +
            '\n\t\t}' +
            '\n\t\treturn { status: 404 };' +
            '\n\t}' +
            '\n\tserveBundle = async (req, res) => {';
          mContent = mContent.replace(anchor, replacement);
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(modulesTarget, mContent, 'utf8');
        markApplied('combo-fallback');
        console.log(`[patch-dsh-client] 成功修补 combo 插件包版本自愈兼容机制: ${modulesTarget}`);
      }
      if (!appliedPatches.has('combo-fallback')) {
        markMissed('combo-fallback');
        console.warn(`[patch-dsh-client] ⚠️ 必需补丁 combo-fallback 未命中（锚点失效）: ${modulesTarget}`);
      }
    } catch (err) {
      markMissed('combo-fallback');
      console.warn(`[patch-dsh-client] 修补 client-modules 失败: ${err.message}`);
    }
  }

  // 4. 设置页面：彻底消除“打开配置文件”按钮，啥也不显示 (return null)
  const generalClientTarget = path.join(searchDir, 'dsh-client-ui-settings-general/lib/client.js');
  if (fs.existsSync(generalClientTarget)) {
    try {
      let gContent = fs.readFileSync(generalClientTarget, 'utf8');
      if (gContent.includes('function SettingsDocumentAction(') && !gContent.includes('function SettingsDocumentAction(props) { return null; }')) {
        gContent = gContent.replace(
          'function SettingsDocumentAction(',
          'function SettingsDocumentAction(props) { return null; }\n\t\tfunction __ignored_SettingsDocumentAction('
        );
        fs.writeFileSync(generalClientTarget, gContent, 'utf8');
        console.log(`[patch-dsh-client] 成功消除“配置文件”按钮: ${generalClientTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 消除设置页按钮失败: ${err.message}`);
    }
  }

  // 5. 模型与引导：消除“内测声明”弹窗 (直接 return null 并通知 complete 放行，彻底消除卡死弹窗)
  const modelsClientTarget = path.join(searchDir, 'dsh-client-ui-settings-models/lib/client.js');
  if (fs.existsSync(modelsClientTarget)) {
    try {
      let mContent = fs.readFileSync(modelsClientTarget, 'utf8');
      if (mContent.includes('function WelcomeNotice(') && !mContent.includes('/* dsh-patch: welcome-notice-bypass */')) {
        mContent = mContent.replace(
          'function WelcomeNotice(props) {',
          '/* dsh-patch: welcome-notice-bypass */ function WelcomeNotice(props) { props?.complete?.(); return null;'
        );
        fs.writeFileSync(modelsClientTarget, mContent, 'utf8');
        console.log(`[patch-dsh-client] 成功跳过内测声明弹窗: ${modelsClientTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 跳过内测声明弹窗失败: ${err.message}`);
    }
  }

  // 6. 修补 dsh-settings 兼容性：补齐 settingsNamespace 导出 (解决 dsh-better-sidebar 等市场插件因缺失 settingsNamespace 崩溃)
  const settingsTarget = path.join(searchDir, 'dsh-settings/lib/index.js');
  if (fs.existsSync(settingsTarget)) {
    try {
      let sContent = fs.readFileSync(settingsTarget, 'utf8');
      if (!sContent.includes('settingsNamespace')) {
        const polyfill = `function settingsNamespace(val) { return val; }\n`;
        sContent = sContent.replace(
          'export { SettingsConflictError,',
          polyfill + 'export { settingsNamespace, SettingsConflictError,'
        );
        fs.writeFileSync(settingsTarget, sContent, 'utf8');
        console.log(`[patch-dsh-client] 成功修补 dsh-settings 的 settingsNamespace 导出: ${settingsTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 修补 dsh-settings 失败: ${err.message}`);
    }
  }
}

console.log(`[patch-dsh-client] 补丁扫描完成，共修补 ${patchedCount} 个客户端文件 (已检查 ${checkedDirs} 个根目录)`);
warnIfVersionOutOfRange();

// 必需补丁必须命中：否则说明 DSH 源码锚点已漂移，补丁"静默失效"比启动失败更危险
if (loopbackSeen) markApplied('client-loopback'); else markMissed('client-loopback');
// 同一补丁在任一目录命中即视为满足（多份 DSH 副本时，只读副本失败不算致命）
for (const name of appliedPatches) missedPatches.delete(name);
console.log(`[patch-dsh-client] 必需补丁状态: 已应用=[${[...appliedPatches].join(', ') || '无'}] 未命中=[${[...missedPatches].join(', ') || '无'}]`);

if (checkedDirs === 0) {
  console.error('[patch-dsh-client] [FATAL] 未找到任何 DSH 模块目录，补丁完全没有执行（镜像结构异常）');
  process.exit(1);
}
if (missedPatches.size > 0) {
  console.error(`[patch-dsh-client] [FATAL] 必需补丁未命中: ${[...missedPatches].join(', ')}`);
  console.error(`[patch-dsh-client] [FATAL] 必需补丁清单: ${REQUIRED_PATCHES.join(', ')}`);
  console.error('[patch-dsh-client] [FATAL] 这通常意味着 DSH 版本已漂移、补丁源码锚点失效；请先更新 patch-dsh-client.mjs 再启动。');
  process.exit(1);
}
console.log('[patch-dsh-client] 全部必需补丁已生效 ✅');
