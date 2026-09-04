#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const SEARCH_DIRS = [
  process.env.DSH_INSTALL_DIR ? path.join(process.env.DSH_INSTALL_DIR, 'lib/node_modules/@deepseek-ai') : null,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/usr/local/lib/node_modules/@deepseek-ai',
  '/opt/dsh/lib/node_modules/@deepseek-ai',
  '/app/node_modules/@deepseek-ai'
].filter(Boolean);

const MARKER = '/* dsh-patch: loopback-host-mode-applied */';

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
  // 服务端鉴权完全由网关基于进程标准输出动态换取官方会话 Cookie，
  // 真正实现零侵入、零篡改 DSH 服务端源码，此处无需对 dsh-client-connection/lib/index.js 进行任何修改！

  // 3. 目录选择器根路径微调 (若存在)
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
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 修补失败: ${file} - ${err.message}`);
    }
  }

  // 2. Server connection patch (gateway manages auth)
  patchServerConnection(searchDir);

  // 3. 修补 client-modules combo 静态资源路由 (防浏览器缓存旧 rev 导致 404 崩溃)
  const modulesTarget = path.join(searchDir, 'dsh-client-modules/lib/index.js');
  if (fs.existsSync(modulesTarget)) {
    try {
      let mContent = fs.readFileSync(modulesTarget, 'utf8');
      const needle = 'const response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl);';
      if (mContent.includes(needle) && !mContent.includes('/* dsh-patch: combo-fallback */')) {
        const replacement = `/* dsh-patch: combo-fallback */ let response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl);
		if (response === void 0 && resourceUrl.startsWith("/plugins/??")) {
			const prefix = resourceUrl.split("&rev=")[0];
			for (const [key, val] of this.responses.entries()) {
				if (key.startsWith(prefix)) { response = val; break; }
			}
		}`;
        mContent = mContent.replace(needle, replacement);
        fs.writeFileSync(modulesTarget, mContent, 'utf8');
        console.log(`[patch-dsh-client] 成功修补 combo 插件包版本自愈兼容机制: ${modulesTarget}`);
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 修补 client-modules 失败: ${err.message}`);
    }
  }

  // 4. 设置页面：彻底消除“打开配置文件”按钮，啥也不显示 (return null)
  const generalClientTarget = path.join(searchDir, 'dsh-client-ui-settings-general/lib/client.js');
  if (fs.existsSync(generalClientTarget)) {
    try {
      let gContent = fs.readFileSync(generalClientTarget, 'utf8');
      if (gContent.includes('function SettingsDocumentAction(') && !gContent.includes('function SettingsDocumentAction() { return null; }')) {
        const startIdx = gContent.indexOf('function SettingsDocumentAction(');
        const endIdx = gContent.indexOf('//#endregion', startIdx);
        if (startIdx !== -1 && endIdx !== -1) {
          gContent = gContent.slice(0, startIdx) + 'function SettingsDocumentAction() { return null; }\n\t\t' + gContent.slice(endIdx);
          fs.writeFileSync(generalClientTarget, gContent, 'utf8');
          console.log(`[patch-dsh-client] 成功消除“打开配置文件”按钮 (啥也不显示，return null): ${generalClientTarget}`);
        }
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 消除设置页按钮失败: ${err.message}`);
    }
  }
}

console.log(`[patch-dsh-client] 补丁扫描完成，共修补 ${patchedCount} 个客户端文件 (已检查 ${checkedDirs} 个根目录)`);
