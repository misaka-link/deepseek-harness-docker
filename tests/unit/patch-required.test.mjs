#!/usr/bin/env node
/**
 * patch-dsh-client.mjs（0.2.3+ 4 项必需补丁 + --build / --verify 模式 + 对抗边界）回归测试。
 * 用法: node tests/unit/patch-required.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const SCRIPT = path.join(ROOT, 'scripts/patch-dsh-client.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };
const syntaxOkFile = (file) => spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status === 0;

const LOOPBACK_SNIPPET = 'const x = isLoopbackHostname(pageLocation.hostname);';
const AUTH_SNIPPET = 'class BrowserAuth {\n\tisAuthenticated(request, secure = false) {\n\t\treturn false;\n\t}\n}\n';
const COMBO_SNIPPET = [
  'const Mod = class {',
  '\tasync fetchBundle(method, requestUrl) {',
  '\t\tconst resourceUrl = requestUrl;',
  '\t\tconst response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.chunkResponse(requestUrl);',
  '\t\tif (response) return {',
  '\t\t\tstatus: 200,',
  '\t\t\t...method === "HEAD" ? {} : { body: await response.body() }',
  '\t\t};',
  '\t\treturn { status: 404 };',
  '\t}',
  '};',
  ''
].join('\n');

const AUTH_CARRIER = 'dsh-host-authentication-token/lib/index.js';
const REMOTE_CONN_FILE = 'dsh-client-remote-connection/lib/index.js';
const REMOTE_CONN_SNIPPET = 'class RC {\n\tisAuthenticated(request, secure) {\n\t\treturn false;\n\t}\n}\n';

const createdDirs = [];
function makeSandbox(name, {
  breakAuth = false,
  authSnippet = AUTH_SNIPPET,
  dshVersion = '0.2.3-alpha.2',
  clientFile = 'dsh-client-connection/lib/client.browser.js',
  remoteConn = null
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-patch-${name}-`));
  createdDirs.push(base);
  const mods = path.join(base, 'lib/node_modules/@deepseek-ai');
  const write = (rel, content) => {
    const p = path.join(mods, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write('dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: dshVersion }));
  write(clientFile, LOOPBACK_SNIPPET + '\n');
  write('dsh-client-modules/lib/index.js', COMBO_SNIPPET);
  write(AUTH_CARRIER, breakAuth ? 'class BrowserAuth {\n\tother() {}\n}\n' : authSnippet);
  if (remoteConn) write(REMOTE_CONN_FILE, remoteConn);
  return base;
}

const runPatch = (base, args = []) => spawnSync(process.execPath, [SCRIPT, ...args], {
  env: { ...process.env, DSH_PATCH_ONLY_DIR: path.join(base, 'lib/node_modules/@deepseek-ai') },
  encoding: 'utf8'
});

try {
  console.log('\n=== A. --build / --verify / 4 项必需补丁全命中 ===');
  const good = makeSandbox('good');
  const rVerifyFail = runPatch(good, ['--verify']);
  ok(rVerifyFail.status !== 0, '未打补丁前 --verify 必须非零失败');

  const rBuild = runPatch(good, ['--build']);
  const rOut = (rBuild.stdout || '') + (rBuild.stderr || '');
  ok(rBuild.status === 0, `--build 退出码 0（实际 ${rBuild.status}）`);
  ok(/全部必需补丁已生效/.test(rOut), '输出含「全部必需补丁已生效」');
  for (const name of ['client-loopback', 'auth-bypass', 'combo-fallback', 'bundle-selfheal']) {
    ok(new RegExp(`已应用=\\[[^\\]]*${name}`).test(rOut), `${name} 已应用`);
  }

  const rVerifyPass = runPatch(good, ['--verify']);
  ok(rVerifyPass.status === 0, '打补丁后 --verify 退出码 0');

  const authAfter = fs.readFileSync(path.join(good, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER), 'utf8');
  ok(/isAuthenticated\([^)]*\)\s*\{\s*\n\s*\/\* dsh-patch: auth-bypass-all \*\/ return true;/.test(authAfter), 'return true 位于方法体第一句');
  ok(syntaxOkFile(path.join(good, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER)), 'auth 载体语法有效');

  console.log('\n=== B. 破坏 auth 锚点 → FATAL 非零退出 ===');
  const bad = makeSandbox('bad', { breakAuth: true });
  const rB = runPatch(bad);
  const rBOut = (rB.stdout || '') + (rB.stderr || '');
  ok(rB.status !== 0 && /\[FATAL\]/.test(rBOut) && /auth-bypass/.test(rBOut), '破坏 auth 锚点触发 FATAL');

  console.log('\n=== C. dsh-client-remote-connection 绝不被误改 ===');
  const withRemote = makeSandbox('remote', { remoteConn: REMOTE_CONN_SNIPPET });
  const rcPath = path.join(withRemote, 'lib/node_modules/@deepseek-ai', REMOTE_CONN_FILE);
  const rcBefore = fs.readFileSync(rcPath, 'utf8');
  ok(runPatch(withRemote).status === 0 && fs.readFileSync(rcPath, 'utf8') === rcBefore, 'remote-connection 字节不变');

  console.log('\n=== D. 截断恢复 / 注释与模板诱饵 / .cjs 重命名 / 歧义 fail-closed ===');
  const trunc = makeSandbox('trunc');
  runPatch(trunc);
  const tPath = path.join(trunc, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER);
  const tGood = fs.readFileSync(tPath, 'utf8');
  fs.writeFileSync(tPath, tGood.slice(0, tGood.indexOf('auth-bypass-all') + 35));
  ok(runPatch(trunc).status === 0 && syntaxOkFile(tPath), 'marker 在但语法截断 → 从 .dsh-orig 自愈');

  const decoy = makeSandbox('decoy', {
    authSnippet: [
      '// isAuthenticated(request, secure = false) {',
      'const s = "isAuthenticated(request, secure = false) {";',
      'const tpl = `\nisAuthenticated(request, secure = false) {\n`;',
      'const esc = `a\\`b`;',
      AUTH_SNIPPET
    ].join('\n')
  });
  const dPath = path.join(decoy, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER);
  ok(runPatch(decoy).status === 0 && (fs.readFileSync(dPath, 'utf8').match(/auth-bypass-all/g) || []).length === 1 && syntaxOkFile(dPath), '注释/字符串/模板诱饵与转义反引号不误伤');

  const renamed = makeSandbox('cjs');
  const origEntry = path.join(renamed, 'lib/node_modules/@deepseek-ai', AUTH_CARRIER);
  const cjsEntry = origEntry.replace(/\.js$/, '.cjs');
  fs.renameSync(origEntry, cjsEntry);
  ok(runPatch(renamed).status === 0 && /auth-bypass-all/.test(fs.readFileSync(cjsEntry, 'utf8')), '.cjs 入口通过 lib/ 扫描正确命中');

  const ambig = makeSandbox('ambig', { authSnippet: AUTH_SNIPPET + 'class Other {\n\tisAuthenticated(request, secure = false) {\n\t\treturn false;\n\t}\n}\n' });
  const rAmb = runPatch(ambig);
  ok(rAmb.status !== 0 && /歧义/.test((rAmb.stdout || '') + (rAmb.stderr || '')), '两处候选歧义 fail-closed');

  console.log('\n=== E. 嵌套与提升双树均须修补 ===');
  const twoBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-two-'));
  createdDirs.push(twoBase);
  for (const mods of [path.join(twoBase, 'dsh/node_modules/@deepseek-ai'), twoBase]) {
    const w = (rel, content) => { const p = path.join(mods, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
    w('dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.3-alpha.2' }));
    w(AUTH_CARRIER, AUTH_SNIPPET);
    w('dsh-client-connection/lib/client.browser.js', LOOPBACK_SNIPPET + '\n');
    w('dsh-client-modules/lib/index.js', COMBO_SNIPPET);
  }
  const rTwo = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DSH_PATCH_ONLY_DIR: twoBase },
    encoding: 'utf8'
  });
  ok(
    rTwo.status === 0 &&
    /auth-bypass-all/.test(fs.readFileSync(path.join(twoBase, 'dsh/node_modules/@deepseek-ai', AUTH_CARRIER), 'utf8')) &&
    /auth-bypass-all/.test(fs.readFileSync(path.join(twoBase, AUTH_CARRIER), 'utf8')),
    '嵌套树与提升树均已完成修补'
  );

  console.log('\n=== F. 客户端文件改名为未知名称 → FATAL ===');
  const unknownClient = makeSandbox('unk', { clientFile: 'dsh-client-connection/lib/client.unknown.js' });
  const rUnk = runPatch(unknownClient);
  ok(rUnk.status !== 0 && /client-loopback/.test((rUnk.stdout || '') + (rUnk.stderr || '')), '未知名客户端文件触发 client-loopback FATAL');
} finally {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
