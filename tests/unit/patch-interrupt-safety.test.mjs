#!/usr/bin/env node
/**
 * 回归测试：patch-dsh-client.mjs 的「中断安全」（0.2.3+ 载体）。
 * 用法: node tests/unit/patch-interrupt-safety.test.mjs
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
const ok = (c, m, d) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m + (d ? '  → ' + d : '')); fail++; } };

const LOOPBACK = 'const x = isLoopbackHostname(pageLocation.hostname);\n';
const AUTH = 'class BrowserAuth {\n\tisAuthenticated(request, secure = false) {\n\t\treturn false;\n\t}\n}\n';
const COMBO = [
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

const createdDirs = [];
function makeSandbox(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-patch-int-${name}-`));
  createdDirs.push(base);
  const mods = path.join(base, 'lib/node_modules/@deepseek-ai');
  const write = (rel, content) => { const p = path.join(mods, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  write('dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.3-alpha.2' }));
  write('dsh-client-connection/lib/client.browser.js', LOOPBACK);
  write('dsh-host-authentication-token/lib/index.js', AUTH);
  write('dsh-client-modules/lib/index.js', COMBO);
  return { base, mods };
}

const runPatch = (mods) => spawnSync(process.execPath, [SCRIPT], {
  env: { ...process.env, DSH_PATCH_ONLY_DIR: mods },
  encoding: 'utf8'
});

try {
  console.log('\n=== A. 正常打补丁：标记后置 + 备份 + 原子写 ===');
  const a = makeSandbox('a');
  const rA = runPatch(a.mods);
  ok(rA.status === 0, '退出码 0', String(rA.status));
  const clientFile = path.join(a.mods, 'dsh-client-connection/lib/client.browser.js');
  const patched = fs.readFileSync(clientFile, 'utf8');
  ok(/dsh-patch: loopback-host-mode-applied \*\/\s*$/.test(patched), '标记写在文件末尾');
  ok(!patched.trimStart().startsWith('/* dsh-patch'), '标记不在文件开头');
  ok(fs.existsSync(clientFile + '.dsh-orig'), '留下 .dsh-orig 备份');
  ok(!fs.readdirSync(path.dirname(clientFile)).some((n) => n.endsWith('.tmp.js')), '无 .tmp.js 残留');

  console.log('\n=== B. 旧式截断（标记前置 + 语法损坏）→ 从备份自愈重打 ===');
  const b = makeSandbox('b');
  ok(runPatch(b.mods).status === 0, '首次打补丁成功');
  const bFile = path.join(b.mods, 'dsh-client-connection/lib/client.browser.js');
  fs.writeFileSync(bFile, '/* dsh-patch: loopback-host-mode-applied */\nclass B { constr\n');
  ok(spawnSync(process.execPath, ['--check', bFile]).status !== 0, '夹具语法不合法');
  const rB2 = runPatch(b.mods);
  const bAfter = fs.readFileSync(bFile, 'utf8');
  ok(rB2.status === 0 && spawnSync(process.execPath, ['--check', bFile]).status === 0, '损坏文件自愈且语法合法');
  ok(/dsh-patch: loopback-host-mode-applied \*\/\s*$/.test(bAfter), '修复后标记位于末尾');

  console.log('\n=== C. 标记丢失（新式截断）→ 显式失败 ===');
  const c = makeSandbox('c');
  runPatch(c.mods);
  const cFile = path.join(c.mods, 'dsh-host-authentication-token/lib/index.js');
  fs.writeFileSync(cFile, fs.readFileSync(cFile, 'utf8').slice(0, 35));
  const rC = runPatch(c.mods);
  ok(rC.status !== 0 && /FATAL/.test((rC.stdout || '') + (rC.stderr || '')), '无法重打时 FATAL 非零退出');

  console.log('\n=== D. 标记丢失 + 语法截断的客户端文件 → 响亮失败，不写坏产物 ===');
  const d = makeSandbox('d');
  ok(runPatch(d.mods).status === 0, '首次打补丁成功');
  const dFile = path.join(d.mods, 'dsh-client-connection/lib/client.browser.js');
  fs.writeFileSync(dFile, 'const x = isLoopbackHostname(pageLocation.hostname'); // 缺少右括号
  ok(spawnSync(process.execPath, ['--check', dFile]).status !== 0, '夹具语法损坏');
  const rD2 = runPatch(d.mods);
  const dAfter = fs.readFileSync(dFile, 'utf8');
  const dOk = spawnSync(process.execPath, ['--check', dFile]).status === 0;
  ok(rD2.status !== 0 || dOk, '截断输入不会静默成功');
  ok(dOk || !dAfter.includes('dsh-patch'), '绝不写出带标记的语法坏文件');

  console.log('\n=== E. 原子写静态契约 ===');
  const scriptSrc = fs.readFileSync(SCRIPT, 'utf8');
  ok(/renameSync\(tmp, target\)/.test(scriptSrc), 'rename 原子替换');
  ok(/if \(!syntaxOk\(tmp\)\)/.test(scriptSrc), '落盘前语法自检');
  ok(/\.tmp\.js'/.test(scriptSrc), '临时文件带 .js 后缀');
  ok(/syntaxOk\(bak\)/.test(scriptSrc), '还原前校验备份语法');
} finally {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
