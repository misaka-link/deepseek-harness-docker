#!/usr/bin/env node
/**
 * 回归测试：DeepSeek 账号登录「回调 origin 归一 loopback」与官方弹窗接管补丁（0.2.3+ 载体）。
 * 用法: node tests/unit/account-login-origin.test.mjs
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

const ACCOUNT_SNIPPET = [
  'class PlatformAuthError extends Error { constructor(code) { super("account: " + code); this.code = code; } }',
  'function loginOrigin(value) {',
  '\tlet url;',
  '\ttry {',
  '\t\turl = new URL(value);',
  '\t} catch {',
  '\t\tthrow new PlatformAuthError("protocol");',
  '\t}',
  '\tconst explicitPort = /^http:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):([0-9]+)\\/?$/i.exec(value)?.[1];',
  '\tif (explicitPort === void 0 || Number(explicitPort) === 0 || url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new PlatformAuthError("protocol");',
  '\treturn url.protocol + "//" + url.hostname + ":" + Number(explicitPort);',
  '}',
  'export { loginOrigin };',
  ''
].join('\n');

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

const ACCOUNT_CLIENT_SNIPPET = [
  'var BrowserLogin = class {',
  '  begin() {',
  '    this.dispose();',
  '    this.popup=window.open(`about:blank`,`_blank`);',
  '    if (this.popup) this.popup.opener = null;',
  '  }',
  '  update(view) {',
  '    const attempt = view?.attempt;',
  '    if (!attempt?.authorizeUrl || this.navigated) return;',
  '    this.navigated = true;',
  '    if(this.popup&&!this.popup.closed)this.popup.location.replace(this.destination(attempt.authorizeUrl));',
  '  }',
  '};',
  'function overlay(account, react_jsx_runtime, SignInDialog) {',
  '  return account.loginVisible&&!account.onboarding&&(0,react_jsx_runtime.jsx)(SignInDialog,{ open: true });',
  '}',
  'function handleMenu(id, beginSignIn) {',
  '  if (id === "other") return;',
  '  else if(id===`signin`)beginSignIn();',
  '}',
  'function register(reg, operations, AccountOnboarding) {',
  '  reg({ inject:()=>operations},AccountOnboarding);',
  '}',
  ''
].join('\n');

function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-account-'));
  const mods = path.join(base, 'lib/node_modules/@deepseek-ai');
  const write = (rel, content) => {
    const p = path.join(mods, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write('dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.3-alpha.2' }));
  write('dsh-client-connection/lib/client.browser.js', LOOPBACK_SNIPPET + '\n');
  write('dsh-host-authentication-token/lib/index.js', AUTH_SNIPPET);
  write('dsh-client-modules/lib/index.js', COMBO_SNIPPET);
  write('dsh-deepseek-account/lib/index.js', ACCOUNT_SNIPPET);
  write('dsh-client-ui-settings-account/lib/client.js', ACCOUNT_CLIENT_SNIPPET);
  return base;
}

const base = makeSandbox();
try {
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DSH_PATCH_ONLY_DIR: path.join(base, 'lib/node_modules/@deepseek-ai') },
    encoding: 'utf8'
  });
  const out = (r.stdout || '') + (r.stderr || '');

  console.log('\n=== A. 补丁应用 ===');
  ok(r.status === 0, `patch-dsh-client 退出码为 0（实际 ${r.status}）`);
  ok(/account-loopback-callback|归一 DeepSeek 账号登录回调/.test(out), '输出含账号回调归一修补记录');
  const patched = fs.readFileSync(path.join(base, 'lib/node_modules/@deepseek-ai/dsh-deepseek-account/lib/index.js'), 'utf8');
  ok(patched.includes('/* dsh-patch: account-loopback-callback */'), '补丁标记已写入目标文件');

  console.log('\n=== B. 补丁后 loginOrigin 行为 ===');
  const m = patched.match(/function loginOrigin\(value\) \{[\s\S]*?\n\}/);
  ok(Boolean(m), '能从补丁后文件提取 loginOrigin');
  const clsM = patched.match(/class PlatformAuthError[\s\S]*?\n/);
  const fn = m ? new Function((clsM ? clsM[0] : '') + m[0] + '; return loginOrigin;')() : null;
  const run = (v) => { try { return fn(v); } catch (e) { return 'ERR:' + (e.code || e.message); } };
  if (fn) {
    ok(run('http://localhost:3079') === 'http://localhost:3079', 'loopback 原样保留: http://localhost:3079');
    ok(run('http://127.0.0.1:3080/') === 'http://127.0.0.1:3080', 'loopback 原样保留: http://127.0.0.1:3080');
    ok(run('http://192.0.2.10:3080') === 'http://localhost:3080', '远端 http 归一: http://192.0.2.10:3080 -> http://localhost:3080');
    ok(run('http://example.com:8080') === 'http://localhost:8080', '远端 http 归一: http://example.com:8080 -> http://localhost:8080');
    ok(run('https://dsh.example.com') === 'http://localhost:443', '远端 https 归一: https://dsh.example.com -> http://localhost:443');
    ok(String(run('not-a-url')).startsWith('ERR'), '非法 URL 仍拒绝');
    ok(String(run('http://localhost:0')).startsWith('ERR'), '端口 0 仍拒绝');
    ok(String(run('ftp://localhost:3080')).startsWith('ERR'), '非 http(s) 协议仍拒绝');
    ok(String(run('http://user:pw@192.0.2.10:3080')).startsWith('ERR'), '带凭据的 origin 仍拒绝');
  }

  console.log('\n=== C. 幂等 ===');
  const r2 = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DSH_PATCH_ONLY_DIR: path.join(base, 'lib/node_modules/@deepseek-ai') },
    encoding: 'utf8'
  });
  const patched2 = fs.readFileSync(path.join(base, 'lib/node_modules/@deepseek-ai/dsh-deepseek-account/lib/index.js'), 'utf8');
  ok(r2.status === 0, `二次运行退出码为 0（实际 ${r2.status}）`);
  ok((patched2.match(/account-loopback-callback/g) || []).length === 1, '二次运行不重复注入（标记计数 = 1）');

  console.log('\n=== D. 官方弹窗接管 + 关闭自动跳转 ===');
  const officialPath = path.join(base, 'lib/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js');
  const official = fs.readFileSync(officialPath, 'utf8');
  ok(!official.includes('window.open(`about:blank`'), '已移除预开标签页');
  ok(official.includes('dsh-patch: account-no-auto-open'), '自动跳转关闭标记已写入');
  ok(official.includes('dsh-patch: account-overlay-dialog-replaced'), '覆盖层弹窗已接管');
  ok(official.includes('dsh-patch: account-dialog-replaced'), '引导弹窗已接管');
  ok(official.includes('dsh-patch: account-signin-notify'), '账号菜单 Sign in 已广播自定义事件');
  ok(spawnSync(process.execPath, ['--check', officialPath]).status === 0, '修补后客户端 JS 语法有效');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
