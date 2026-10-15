/**
 * 回归测试：DeepSeek 账号登录「回调 origin 归一 loopback」补丁
 * （patch-dsh-client.mjs 的 dsh-patch: account-loopback-callback）。
 *
 * 背景：上游 0.2.1-alpha.3 新增「Web 本机 HTTP 访问时登录 DeepSeek 账号」，但
 *   - DeepSeek 平台只接受 loopback 回调（非 loopback redirect_uri 返回 PAYLOAD_SCHEMA_MISMATCH）；
 *   - 宿主 loginOrigin() 直接拒绝非 loopback origin。
 * 补丁把非 loopback 回调 origin 归一到 http://localhost:<原端口>，使反代/域名访问下
 * 仍能启动登录，并由用户「本地隧道」或「手动粘贴回调链接」完成。
 *
 * 用法: node scripts/account-login-origin-test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(ROOT, 'scripts/patch-dsh-client.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

// 上游 0.2.1-alpha.3 的 loginOrigin 原始形态（用于锚定）
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
const AUTH_SNIPPET = 'class C {\n\tisAuthenticated(request, secure = false) {\n\t\treturn false;\n\t}\n}\n';
const COMBO_SNIPPET = 'class R {\n\tbundleResource(method, url) {\n\t\tconst resourceUrl = url;\n\t\tconst response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.chunkResponse(requestUrl);\n\t\treturn response;\n\t}\n}\n';
// 官方账号客户端（dsh-client-ui-settings-account）中被接管的三个锚点片段
const ACCOUNT_CLIENT_SNIPPET = [
  'var BrowserLogin = class {',
  '\t\t\tbegin() {',
  '\t\t\t\tthis.dispose();',
  '\t\t\t\tthis.popup = window.open("about:blank", "_blank");',
  '\t\t\t\tif (this.popup) this.popup.opener = null;',
  '\t\t\t}',
  '\t\t\tupdate(view) {',
  '\t\t\t\tconst attempt = view?.attempt;',
  '\t\t\t\tif (!attempt?.authorizeUrl || this.navigated) return;',
  '\t\t\t\tthis.navigated = true;',
  '\t\t\t\tif (this.popup && !this.popup.closed) this.popup.location.replace(this.destination(attempt.authorizeUrl));',
  '\t\t\t}',
  '\t\t};',
  '\t\t\t\t\t\t\t} else if (id === "signin") beginSignIn();',
  '\t\tfunction AccountOnboarding({ complete }) {',
  '\t\t\tif (!account.view || account.view.status === "credential-stored") return null;',
  '\t\t\treturn null;',
  '\t\t}',
  ''
].join('\n');

function makeSandbox() {
  const base = path.join(os.tmpdir(), 'dsh-account-' + Date.now());
  const mods = path.join(base, 'lib/node_modules/@deepseek-ai');
  const write = (rel, content) => {
    const p = path.join(mods, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write('dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-alpha.3' }));
  write('dsh-client-connection/lib/client.browser.js', LOOPBACK_SNIPPET + '\n');
  write('dsh-client-connection/lib/index.js', AUTH_SNIPPET);
  write('dsh-client-modules/lib/index.js', COMBO_SNIPPET);
  write('dsh-deepseek-account-platform/lib/index.js', ACCOUNT_SNIPPET);
  write('dsh-client-ui-settings-account/lib/client.js', ACCOUNT_CLIENT_SNIPPET);
  return base;
}

const base = makeSandbox();
const r = spawnSync('node', [SCRIPT], {
  env: { ...process.env, DSH_PATCH_ONLY_DIR: path.join(base, 'lib/node_modules/@deepseek-ai') },
  encoding: 'utf8'
});
const out = (r.stdout || '') + (r.stderr || '');

console.log('\n=== A. 补丁应用 ===');
ok(r.status === 0, `patch-dsh-client 退出码为 0（实际 ${r.status}）`);
ok(/account-loopback-callback/.test(out), '输出含 account-loopback-callback 修补记录');
const patched = fs.readFileSync(path.join(base, 'lib/node_modules/@deepseek-ai/dsh-deepseek-account-platform/lib/index.js'), 'utf8');
ok(patched.includes('/* dsh-patch: account-loopback-callback */'), '补丁标记已写入目标文件');

console.log('\n=== B. 补丁后 loginOrigin 行为 ===');
const m = patched.match(/function loginOrigin\(value\) \{[\s\S]*?\n\}/);
ok(Boolean(m), '能从补丁后文件提取 loginOrigin');
const fn = m ? new Function(m[0] + '; return loginOrigin;')() : null;
const run = (v) => { try { return fn(v); } catch (e) { return 'ERR:' + e.code; } };
if (fn) {
  ok(run('http://localhost:3079') === 'http://localhost:3079', 'loopback 原样保留: http://localhost:3079');
  ok(run('http://127.0.0.1:3080/') === 'http://127.0.0.1:3080', 'loopback 原样保留: http://127.0.0.1:3080');
  ok(run('http://10.10.10.99:3080') === 'http://localhost:3080', '远端 http 归一: http://10.10.10.99:3080 -> http://localhost:3080');
  ok(run('http://example.com:8080') === 'http://localhost:8080', '远端 http 归一: http://example.com:8080 -> http://localhost:8080');
  ok(run('https://dsh.example.com') === 'http://localhost:443', '远端 https 归一: https://dsh.example.com -> http://localhost:443');
  ok(String(run('not-a-url')).startsWith('ERR'), '非法 URL 仍拒绝');
  ok(String(run('http://localhost:0')).startsWith('ERR'), '端口 0 仍拒绝');
  ok(String(run('ftp://localhost:3080')).startsWith('ERR'), '非 http(s) 协议仍拒绝');
  ok(String(run('http://user:pw@10.10.10.99:3080')).startsWith('ERR'), '带凭据的 origin 仍拒绝（不静默剥离）');
}

console.log('\n=== C. 幂等 ===');
const r2 = spawnSync('node', [SCRIPT], {
  env: { ...process.env, DSH_PATCH_ONLY_DIR: path.join(base, 'lib/node_modules/@deepseek-ai') },
  encoding: 'utf8'
});
const patched2 = fs.readFileSync(path.join(base, 'lib/node_modules/@deepseek-ai/dsh-deepseek-account-platform/lib/index.js'), 'utf8');
ok(r2.status === 0, `二次运行退出码为 0（实际 ${r2.status}）`);
ok((patched2.match(/account-loopback-callback/g) || []).length === 1, '二次运行不重复注入（标记计数 = 1）');

console.log('\n=== D. 官方弹窗接管 + 关闭自动跳转 ===');
const officialPath = path.join(base, 'lib/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js');
const official = fs.readFileSync(officialPath, 'utf8');
ok(!official.includes('window.open("about:blank"'), '已移除预开标签页（不再自动跳转）');
ok(official.includes('dsh-patch: account-no-auto-open'), '自动跳转关闭标记已写入');
ok(!/^\t\t\t\tif \(this\.popup && !this\.popup\.closed\) this\.popup\.location\.replace/m.test(official), '已禁用弹窗自动导航');
ok(official.includes('dsh-patch: account-dialog-replaced'), '官方弹窗已被接管（不再渲染）');
ok(official.includes('dsh-patch: account-signin-notify'), '账号菜单「Sign in」已广播事件（可唤起插件弹窗）');
ok(!/else if \(id === "signin"\) beginSignIn\(\);\n/m.test(official), '单语句结构未被破坏（保留 else 分支语法）');

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
