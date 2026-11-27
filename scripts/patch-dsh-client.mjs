#!/usr/bin/env node
/**
 * patch-dsh-client.mjs (v1.0.0 — 仅面向 @deepseek-ai/dsh >= 0.2.3-alpha.2)
 *
 * 模式：
 *   --build   构建期打补丁：要求至少扫描到 1 个 DSH 目录且 4 项必需补丁全部命中，否则 exit 1
 *   --verify  只读校验：检查 4 项必需补丁是否已生效且语法有效，不修改任何文件，缺失/损坏则 exit 1
 *   (默认)     运行期幂等模式：已生效且语法健康则跳过，损坏则从 .dsh-orig 自愈，缺失则原子补打
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const MODE_BUILD = ARGV.includes('--build');
const MODE_VERIFY = ARGV.includes('--verify');

// 离线/单测目录隔离：DSH_PATCH_ONLY_DIR 存在时仅扫描该目录树
const ONLY_DIR = process.env.DSH_PATCH_ONLY_DIR;

function resolveSearchDirs() {
  let rawCandidates;
  if (ONLY_DIR) {
    const nested = path.join(ONLY_DIR, 'dsh/node_modules/@deepseek-ai');
    rawCandidates = fs.existsSync(nested) ? [nested, ONLY_DIR] : [ONLY_DIR];
  } else {
    const installDir = process.env.DSH_INSTALL_DIR || '/usr/local';
    rawCandidates = [
      path.join(installDir, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
      path.join(installDir, 'lib/node_modules/@deepseek-ai'),
      '/app/node_modules/@deepseek-ai'
    ];
  }

  const dirs = [];
  const seen = new Set();
  for (const dir of rawCandidates) {
    if (!dir) continue;
    try {
      if (!fs.existsSync(dir)) continue;
      const real = fs.realpathSync(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      dirs.push(dir);
    } catch {}
  }
  return dirs;
}

const SEARCH_DIRS = resolveSearchDirs();
const MARKER = '/* dsh-patch: loopback-host-mode-applied */';

// ── 中断安全原语：node --check 前置校验 + .dsh-orig 备份 + 同目录原子 rename ──
function syntaxOk(file) {
  let target = file;
  let probe = null;
  const ext = path.extname(file).toLowerCase();
  if (!['.js', '.cjs', '.mjs'].includes(ext)) {
    probe = file + '.' + process.pid + '.check.js';
    try {
      fs.copyFileSync(file, probe);
      target = probe;
    } catch {
      return false;
    }
  }
  try {
    const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  } finally {
    if (probe) { try { fs.unlinkSync(probe); } catch {} }
  }
}

function writeFileAtomic(target, content) {
  const tmp = target + '.dsh-patch-' + process.pid + '.tmp.js';
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    if (!syntaxOk(tmp)) {
      console.error('[patch-dsh-client] [FATAL] 打补丁后的内容语法不合法，已放弃写入: ' + target);
      throw new Error('patched content failed syntax check');
    }
    const bak = target + '.dsh-orig';
    if (!fs.existsSync(bak) && fs.existsSync(target)) {
      if (syntaxOk(target)) {
        fs.copyFileSync(target, bak);
      } else {
        console.warn('[patch-dsh-client] ⚠️ 源文件语法不合法，跳过备份: ' + target);
      }
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ── 4 项必需补丁追踪 ──────────────────────────────────────────────────────────
const REQUIRED_PATCHES = ['client-loopback', 'auth-bypass', 'combo-fallback', 'bundle-selfheal'];
const appliedPatches = new Set();
const missedPatches = new Set();
let authCurrentGenMiss = false;
const markApplied = (name) => appliedPatches.add(name);
const markMissed = (name) => missedPatches.add(name);
let loopbackSeen = false;

function readInstalledDshVersion() {
  const candidates = [
    ONLY_DIR ? path.join(ONLY_DIR, 'dsh/package.json') : null,
    ONLY_DIR ? path.join(ONLY_DIR, 'package.json') : null,
    process.env.DSH_INSTALL_DIR ? path.join(process.env.DSH_INSTALL_DIR, 'lib/node_modules/@deepseek-ai/dsh/package.json') : null,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json'
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pkg.version) return { version: pkg.version, source: p };
    } catch {}
  }
  return { version: null, source: null };
}

function readCompatRange() {
  const candidates = [
    process.env.DSH_VERSION_JSON,
    ONLY_DIR ? path.join(SCRIPT_DIR, '../version.json') : null,
    '/app/version.json',
    path.join(SCRIPT_DIR, '../version.json')
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      const range = meta?.compatibilityV1?.supportedDshRange || meta?.compatibility?.supportedDshRange;
      if (range) return { range, source: p };
    } catch {}
  }
  return { range: null, source: null };
}

function logVersionBanner() {
  try {
    const { version: ver, source: verSrc } = readInstalledDshVersion();
    const { range, source: rangeSrc } = readCompatRange();
    if (ver && range) {
      console.log(`[patch-dsh-client] DSH 版本: ${ver} (来源: ${verSrc})，声明兼容区间: ${range} (来源: ${rangeSrc})`);
    }
  } catch {}
}

// ── 0.2.3+ 载体与签名定义 ─────────────────────────────────────────────────────
const AUTH_MARK = '/* dsh-patch: auth-bypass-all */ return true;';
const AUTH_BYPASS_TARGETS = ['dsh-host-authentication-token/lib/index.js'];
const AUTH_BYPASS_SIGNATURES = ['isAuthenticated(request, secure = false) {'];

const REPLACEMENTS = [
  {
    needle: 'isLoopbackHostname(pageLocation.hostname)',
    replacement: 'true'
  }
];

const CLIENT_FILE_NAMES = new Set(['client.browser.js', 'client.node.js']);

function findClientFiles(baseDir) {
  const matched = [];
  if (!fs.existsSync(baseDir)) return matched;
  const visited = new Set();

  function walk(dir) {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'src' || ent.name.startsWith('.')) continue;
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(fullPath);
      } else if (ent.isSymbolicLink()) {
        try {
          const st = fs.statSync(fullPath);
          if (st.isDirectory()) walk(fullPath);
          else if (st.isFile() && CLIENT_FILE_NAMES.has(ent.name)) matched.push(fullPath);
        } catch {}
      } else if (ent.isFile() && CLIENT_FILE_NAMES.has(ent.name)) {
        matched.push(fullPath);
      }
    }
  }

  walk(baseDir);
  return matched;
}

/** 最小词法上下文扫描：识别模板字符串、单双引号字符串与注释区域 */
function scanContext(src, pos) {
  let inTpl = false, inBlock = false, inLine = false, inS = false, inD = false;
  for (let i = 0; i < pos; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inTpl || inS || inD) {
      if (c === '\\') { i++; continue; }
      if (inTpl && c === '`') { inTpl = false; continue; }
      if (inS && c === "'") { inS = false; continue; }
      if (inD && c === '"') { inD = false; continue; }
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '`') { inTpl = true; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
  }
  return { inTpl, inBlock, inLine, inS, inD };
}

function patchServerConnection(baseDir) {
  const findCarrier = () => {
    for (const rel of AUTH_BYPASS_TARGETS) {
      const pkgName = rel.split('/')[0];
      const pkgDir = path.join(baseDir, pkgName);
      if (!fs.existsSync(pkgDir)) continue;
      const expected = path.join(baseDir, rel);
      if (fs.existsSync(expected)) return { pkgDir, file: expected };
      const libDir = path.join(pkgDir, 'lib');
      let found = null;
      try {
        for (const f of fs.readdirSync(libDir).sort()) {
          if (!/\.(?:js|cjs|mjs)$/.test(f)) continue;
          const full = path.join(libDir, f);
          let txt = '';
          try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; }
          if (txt.includes(AUTH_MARK) || AUTH_BYPASS_SIGNATURES.some((sig) => txt.includes(sig))) {
            found = full;
            break;
          }
        }
      } catch {}
      return { pkgDir, file: found };
    }
    return null;
  };

  const carrierInfo = findCarrier();
  if (carrierInfo && !carrierInfo.file) {
    console.error('[patch-dsh-client] ⚠️ 必需补丁 auth-bypass：载体包存在但 lib/ 下找不到锚点文件: ' + carrierInfo.pkgDir);
    markMissed('auth-bypass');
    authCurrentGenMiss = true;
  } else if (carrierInfo) {
    const carrier = carrierInfo.file;
    let doneHere = false;
    try {
      let cContent = fs.readFileSync(carrier, 'utf8');
      if (cContent.includes(AUTH_MARK)) {
        if (syntaxOk(carrier)) {
          markApplied('auth-bypass');
          doneHere = true;
        } else if (MODE_VERIFY) {
          console.error('[patch-dsh-client] ⚠️ [verify] auth-bypass 载体语法损坏: ' + carrier);
          markMissed('auth-bypass');
          authCurrentGenMiss = true;
          doneHere = true;
        } else {
          const bak = carrier + '.dsh-orig';
          if (fs.existsSync(bak) && syntaxOk(bak)) {
            console.warn('[patch-dsh-client] ⚠️ auth-bypass 载体语法损坏，从备份还原后重打: ' + carrier);
            fs.copyFileSync(bak, carrier);
            cContent = fs.readFileSync(carrier, 'utf8');
            if (cContent.includes(AUTH_MARK)) {
              markApplied('auth-bypass');
              doneHere = true;
            }
          } else {
            console.error('[patch-dsh-client] ⚠️ auth-bypass 载体语法损坏且无可用备份: ' + carrier);
            markMissed('auth-bypass');
            authCurrentGenMiss = true;
            doneHere = true;
          }
        }
      } else if (MODE_VERIFY) {
        console.error('[patch-dsh-client] ⚠️ [verify] auth-bypass 补丁未生效: ' + carrier);
        markMissed('auth-bypass');
        authCurrentGenMiss = true;
        doneHere = true;
      }

      if (!doneHere) {
        const candidates = [];
        for (const sig of AUTH_BYPASS_SIGNATURES) {
          let from = 0;
          for (;;) {
            const at = cContent.indexOf(sig, from);
            if (at < 0) break;
            const lineStart = cContent.lastIndexOf('\n', at) + 1;
            const head = cContent.slice(lineStart, at);
            const lineHead = cContent.slice(lineStart);
            const ctx = scanContext(cContent, at);
            const inLiteral = ctx.inTpl || ctx.inBlock || ctx.inLine || ctx.inS || ctx.inD;
            if (/^[ \t]*$/.test(head) && /^[ \t]*isAuthenticated\(/.test(lineHead) && !inLiteral) {
              candidates.push({ sig, at });
            }
            from = at + sig.length;
          }
        }
        candidates.sort((a, b) => a.at - b.at);

        if (candidates.length === 0) {
          console.error('[patch-dsh-client] ⚠️ 必需补丁 auth-bypass 锚点失效: ' + carrier);
          markMissed('auth-bypass');
          authCurrentGenMiss = true;
        } else if (candidates.length > 1) {
          console.error('[patch-dsh-client] ⚠️ 必需补丁 auth-bypass 锚点有歧义 (' + candidates.length + ' 处): ' + carrier);
          markMissed('auth-bypass');
          authCurrentGenMiss = true;
        } else {
          const hit = candidates[0];
          const patched = cContent.slice(0, hit.at + hit.sig.length)
            + '\n\t\t/* dsh-patch: auth-bypass-all */ return true;'
            + cContent.slice(hit.at + hit.sig.length);
          writeFileAtomic(carrier, patched);
          markApplied('auth-bypass');
          console.log(`[patch-dsh-client] 成功修补服务端免鉴权直连: ${carrier}`);
        }
      }
    } catch (err) {
      console.error(`[patch-dsh-client] ⚠️ 必需补丁 auth-bypass 失败 (${carrier}): ${err.message}`);
      markMissed('auth-bypass');
      authCurrentGenMiss = true;
    }
  } else {
    console.log('[patch-dsh-client] 本目录无 auth-bypass 载体，跳过: ' + baseDir);
  }

  // 可选：目录选择器默认根路径对齐 DSH_WORKSPACE
  if (!MODE_VERIFY) {
    const pickerTarget = path.join(baseDir, 'dsh-host-directory-picker-browse/lib/index.js');
    if (fs.existsSync(pickerTarget)) {
      try {
        let pContent = fs.readFileSync(pickerTarget, 'utf8');
        if (pContent.includes('const home = homedir();') && !pContent.includes('process.env.DSH_WORKSPACE')) {
          pContent = pContent.replace('const home = homedir();', 'const home = process.env.DSH_WORKSPACE || homedir();');
          writeFileAtomic(pickerTarget, pContent);
          console.log(`[patch-dsh-client] 成功对齐目录选择器默认根路径为 DSH_WORKSPACE: ${pickerTarget}`);
        }
      } catch (err) {
        console.warn(`[patch-dsh-client] 对齐目录选择器失败: ${err.message}`);
      }
    }
  }
}

// DeepSeek 账号登录回调 origin 归一（dsh-deepseek-account，非必需）
function patchAccountLoginOrigin(searchDir) {
  const target = path.join(searchDir, 'dsh-deepseek-account/lib/index.js');
  if (!fs.existsSync(target) || MODE_VERIFY) return;
  try {
    let content = fs.readFileSync(target, 'utf8');
    if (content.includes('/* dsh-patch: account-loopback-callback */')) {
      console.log('[patch-dsh-client] DeepSeek 账号回调 origin 归一补丁已存在: ' + target);
      return;
    }
    const anchor = '\t\tthrow new PlatformAuthError("protocol");\n\t}\n\tconst explicitPort = ';
    if (!content.includes(anchor)) {
      console.warn('[patch-dsh-client] ⚠️ DeepSeek 账号回调 origin 归一补丁未命中（非必需）: ' + target);
      return;
    }
    const injected = '\t\tthrow new PlatformAuthError("protocol");\n\t}\n'
      + '\t/* dsh-patch: account-loopback-callback */ if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) { const __dshPort = url.port || (url.protocol === "https:" ? "443" : "80"); url = new URL("http://localhost:" + __dshPort + "/"); value = url.href; }\n'
      + '\tconst explicitPort = ';
    content = content.replace(anchor, injected);
    writeFileAtomic(target, content);
    console.log('[patch-dsh-client] 成功归一 DeepSeek 账号登录回调 origin 为 loopback: ' + target);
  } catch (err) {
    console.warn(`[patch-dsh-client] 归一 DeepSeek 账号回调 origin 失败: ${err.message}`);
  }
}

// DeepSeek 账号登录弹窗接管（0.2.3+ 压缩产物锚点，非必需）
function patchAccountDialog(searchDir) {
  const target = path.join(searchDir, 'dsh-client-ui-settings-account/lib/client.js');
  if (!fs.existsSync(target) || MODE_VERIFY) return;
  try {
    let c = fs.readFileSync(target, 'utf8');
    const MARKS = [
      'dsh-patch: account-no-auto-open',
      'dsh-patch: account-dialog-replaced',
      'dsh-patch: account-overlay-dialog-replaced',
      'dsh-patch: account-signin-notify'
    ];
    if (MARKS.every((m) => c.includes(m))) {
      console.log(`[patch-dsh-client] DeepSeek 账号弹窗接管补丁已存在: ${target}`);
      return;
    }
    const edits = [
      ['this.popup=window.open(`about:blank`,`_blank`)',
       'this.popup=null /* dsh-patch: account-no-auto-open */'],
      ['if(this.popup&&!this.popup.closed)this.popup.location.replace(this.destination(attempt.authorizeUrl))',
       'if(false)this.popup.location.replace(this.destination(attempt.authorizeUrl)); /* dsh-patch: account-no-auto-open */'],
      ['account.loginVisible&&!account.onboarding&&(0,react_jsx_runtime.jsx)(SignInDialog,{',
       'false&&(0,react_jsx_runtime.jsx)(SignInDialog,{ /* dsh-patch: account-overlay-dialog-replaced */'],
      ['else if(id===`signin`)beginSignIn();',
       'else if(id===`signin`)(beginSignIn(),window.dispatchEvent(new CustomEvent("dsh-container-helper:open"))); /* dsh-patch: account-signin-notify */'],
      ['inject:()=>operations},AccountOnboarding)',
       'inject:()=>operations},/* dsh-patch: account-dialog-replaced */()=>null)']
    ];
    let changed = false;
    for (const [from, to] of edits) {
      if (c.includes(to)) continue;
      if (!c.includes(from)) {
        console.warn(`[patch-dsh-client] ⚠️ 账号弹窗接管锚点未命中（非必需）: ${from.slice(0, 60)}…`);
        continue;
      }
      c = c.replace(from, to);
      changed = true;
    }
    if (changed) {
      writeFileAtomic(target, c);
      console.log(`[patch-dsh-client] 成功接管 DeepSeek 账号弹窗并关闭自动跳转: ${target}`);
    }
  } catch (err) {
    console.warn(`[patch-dsh-client] 接管 DeepSeek 账号弹窗失败: ${err.message}`);
  }
}

let patchedCount = 0;
let checkedDirs = 0;

for (const searchDir of SEARCH_DIRS) {
  if (!fs.existsSync(searchDir)) continue;
  checkedDirs++;
  console.log(`[patch-dsh-client] 扫描模块目录 (${MODE_VERIFY ? 'verify' : (MODE_BUILD ? 'build' : 'runtime')}): ${searchDir}`);

  // 1. Client loopback patch (client.browser.js / client.node.js)
  const clientFiles = findClientFiles(searchDir);
  for (const file of clientFiles) {
    try {
      let content = fs.readFileSync(file, 'utf8');
      if (content.includes(MARKER)) {
        if (syntaxOk(file)) {
          if (!MODE_VERIFY) {
            const bakForLater = file + '.dsh-orig';
            try {
              if (!fs.existsSync(bakForLater)) fs.copyFileSync(file, bakForLater);
            } catch {}
          }
          loopbackSeen = true;
          continue;
        }
        if (MODE_VERIFY) {
          console.error(`[patch-dsh-client] [FATAL] [verify] 已补丁客户端文件语法不合法: ${file}`);
          process.exitCode = 1;
          continue;
        }
        const bak = file + '.dsh-orig';
        if (fs.existsSync(bak) && syntaxOk(bak)) {
          content = fs.readFileSync(bak, 'utf8');
          console.warn(`[patch-dsh-client] 检测到语法损坏的已补丁文件，已从备份还原后重打: ${file}`);
        } else if (fs.existsSync(bak)) {
          console.error(`[patch-dsh-client] [FATAL] 备份文件本身语法不合法，拒绝还原: ${bak}`);
          process.exitCode = 1;
          continue;
        } else {
          console.error(`[patch-dsh-client] [FATAL] 文件含补丁标记但语法不合法，且无备份可还原: ${file}`);
          process.exitCode = 1;
          continue;
        }
      }

      if (content.includes(MARKER)) {
        loopbackSeen = true;
        continue;
      }

      if (MODE_VERIFY) {
        const hasUnpatched = REPLACEMENTS.some(({ needle }) => content.includes(needle));
        if (hasUnpatched) {
          console.error(`[patch-dsh-client] [verify] 客户端回环补丁未生效: ${file}`);
          process.exitCode = 1;
        }
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
        content = `${content}\n${MARKER}`;
        writeFileAtomic(file, content);
        console.log(`[patch-dsh-client] 成功修补客户端: ${file}`);
        patchedCount++;
        loopbackSeen = true;
      }
    } catch (err) {
      console.warn(`[patch-dsh-client] 修补失败: ${file} - ${err.message}`);
      process.exitCode = 1;
    }
  }

  // 2. Server auth-bypass + directory picker
  patchServerConnection(searchDir);

  // 2.5 DeepSeek 账号登录回调 origin 归一
  patchAccountLoginOrigin(searchDir);

  // 2.6 DeepSeek 账号登录弹窗接管
  patchAccountDialog(searchDir);

  // 3. client-modules combo fallback & bundle-404-selfheal (0.2.3+ fetchBundle 形态)
  const modulesTarget = path.join(searchDir, 'dsh-client-modules/lib/index.js');
  if (fs.existsSync(modulesTarget)) {
    try {
      let mContent = fs.readFileSync(modulesTarget, 'utf8');
      let changed = false;

      const hasCombo = mContent.includes('/* dsh-patch: combo-fallback */');
      const hasSelfheal = mContent.includes('/* dsh-patch: bundle-404-selfheal */');

      if (MODE_VERIFY) {
        if (hasCombo && syntaxOk(modulesTarget)) markApplied('combo-fallback');
        else markMissed('combo-fallback');
        if (hasSelfheal && syntaxOk(modulesTarget)) markApplied('bundle-selfheal');
        else markMissed('bundle-selfheal');
      } else {
        if (hasCombo) markApplied('combo-fallback');
        else {
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

        if (!hasSelfheal) {
          const healBody = 'try{if(!sessionStorage.getItem("dsh-bundle-heal")){sessionStorage.setItem("dsh-bundle-heal","1");setTimeout(function(){try{sessionStorage.removeItem("dsh-bundle-heal")}catch(e){}},20000);location.reload()}}catch(e){}';
          const selfhealReturn =
            '\n\t\t/* dsh-patch: bundle-404-selfheal */' +
            '\n\t\tif (resourceUrl.startsWith("/plugins/")) {' +
            '\n\t\t\treturn {' +
            '\n\t\t\t\tstatus: 200,' +
            '\n\t\t\t\theaders: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },' +
            '\n\t\t\t\t...(method === "HEAD" ? {} : { body: Buffer.from(' + JSON.stringify(healBody) + ') })' +
            '\n\t\t\t};' +
            '\n\t\t}';
          const ANCHOR = '\t\t\t...method === "HEAD" ? {} : { body: await response.body() }\n\t\t};\n\t\treturn { status: 404 };\n\t}\n};';
          if (mContent.includes(ANCHOR)) {
            mContent = mContent.replace(
              ANCHOR,
              ANCHOR.replace('\t\treturn { status: 404 };\n\t}\n};', selfhealReturn + '\n\t\treturn { status: 404 };\n\t}\n};')
            );
            changed = true;
          }
        }

        if (changed) {
          writeFileAtomic(modulesTarget, mContent);
          console.log(`[patch-dsh-client] 成功修补 combo 插件包版本自愈兼容机制: ${modulesTarget}`);
        }

        if (mContent.includes('/* dsh-patch: combo-fallback */')) markApplied('combo-fallback');
        else {
          markMissed('combo-fallback');
          console.warn(`[patch-dsh-client] ⚠️ 必需补丁 combo-fallback 未命中: ${modulesTarget}`);
        }
        if (mContent.includes('/* dsh-patch: bundle-404-selfheal */')) markApplied('bundle-selfheal');
        else {
          markMissed('bundle-selfheal');
          console.warn(`[patch-dsh-client] ⚠️ 必需补丁 bundle-selfheal 未命中: ${modulesTarget}`);
        }
      }
    } catch (err) {
      markMissed('combo-fallback');
      markMissed('bundle-selfheal');
      console.warn(`[patch-dsh-client] 修补 client-modules 失败: ${err.message}`);
    }
  }

  // 4. 设置页：隐藏“打开配置文件”按钮（非必需）
  if (!MODE_VERIFY) {
    const generalClientTarget = path.join(searchDir, 'dsh-client-ui-settings-general/lib/client.js');
    if (fs.existsSync(generalClientTarget)) {
      try {
        let gContent = fs.readFileSync(generalClientTarget, 'utf8');
        if (gContent.includes('function SettingsDocumentAction(') && !gContent.includes('function SettingsDocumentAction(props) { return null; }')) {
          gContent = gContent.replace(
            'function SettingsDocumentAction(',
            'function SettingsDocumentAction(props) { return null; }\n\t\tfunction __ignored_SettingsDocumentAction('
          );
          writeFileAtomic(generalClientTarget, gContent);
          console.log(`[patch-dsh-client] 成功隐藏“配置文件”按钮: ${generalClientTarget}`);
        }
      } catch (err) {
        console.warn(`[patch-dsh-client] 隐藏设置页按钮失败: ${err.message}`);
      }
    }

    // 5. 模型与引导：跳过“内测声明”弹窗（非必需）
    const modelsClientTarget = path.join(searchDir, 'dsh-client-ui-settings-models/lib/client.js');
    if (fs.existsSync(modelsClientTarget)) {
      try {
        let mContent = fs.readFileSync(modelsClientTarget, 'utf8');
        if (mContent.includes('function WelcomeNotice(') && !mContent.includes('/* dsh-patch: welcome-notice-bypass */')) {
          const before = mContent;
          mContent = mContent.replace(
            /function WelcomeNotice\(props\)\s*\{/,
            '/* dsh-patch: welcome-notice-bypass */ function WelcomeNotice(props) { props?.complete?.(); return null;'
          );
          if (mContent === before) {
            console.warn(`[patch-dsh-client] ⚠️ 内测声明弹窗锚点未命中（非必需）: ${modelsClientTarget}`);
          } else {
            writeFileAtomic(modelsClientTarget, mContent);
            console.log(`[patch-dsh-client] 成功跳过内测声明弹窗: ${modelsClientTarget}`);
          }
        }
      } catch (err) {
        console.warn(`[patch-dsh-client] 跳过内测声明弹窗失败: ${err.message}`);
      }
    }
  }
}

console.log(`[patch-dsh-client] 补丁扫描完成，共修补 ${patchedCount} 个客户端文件 (已检查 ${checkedDirs} 个根目录)`);
logVersionBanner();

if (loopbackSeen) markApplied('client-loopback'); else markMissed('client-loopback');
for (const req of REQUIRED_PATCHES) {
  if (!appliedPatches.has(req)) missedPatches.add(req);
}
for (const name of appliedPatches) missedPatches.delete(name);
if (authCurrentGenMiss) {
  missedPatches.add('auth-bypass');
  console.error('[patch-dsh-client] ⚠️ auth-bypass 载体补齐失败');
}
console.log(`[patch-dsh-client] 必需补丁状态: 已应用=[${[...appliedPatches].join(', ') || '无'}] 未命中=[${[...missedPatches].join(', ') || '无'}]`);

if (checkedDirs === 0) {
  console.error('[patch-dsh-client] [FATAL] 未找到任何 DSH 模块目录，补丁完全没有执行');
  process.exit(1);
}
if (missedPatches.size > 0) {
  console.error(`[patch-dsh-client] [FATAL] 必需补丁未命中: ${[...missedPatches].join(', ')}`);
  process.exit(1);
}
if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
console.log('[patch-dsh-client] 全部必需补丁已生效');
