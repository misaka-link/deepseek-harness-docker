/**
 * 回归测试：patch-dsh-client.mjs 的「中断安全」（Issue #18 同类缺陷）。
 *
 * 历史缺陷：补丁标记写在文件**开头** + 用 fs.writeFileSync 就地覆盖（先截断再写）。
 * 进程在写入途中被杀 → 文件只剩半截，但标记还在开头 → 幂等判定直接跳过 → 永不修复，
 * DSH 启动即 SyntaxError。与 npx「先内容后签名」正好互为镜像。
 *
 * 本测试验证修复后的三条契约：
 *   A. 正常打补丁：标记写在**末尾**、留 .dsh-orig 备份、无 .tmp 残留
 *   B. 旧式截断（标记在开头 + 正文残缺）：识别为损坏 → 从 .dsh-orig 还原 → 重打成功
 *   C. 新式截断（标记丢失）：不会静默通过 —— 重新尝试打补丁，打不上则 FATAL 退出
 *
 * 用法: node scripts/patch-interrupt-safety-test.mjs
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
const ok = (c, m, d) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m + (d ? '  → ' + d : '')); fail++; } };

const LOOPBACK = 'const x = isLoopbackHostname(pageLocation.hostname);\n';
const AUTH = 'class C {\n\tisAuthenticated(request, secure = false) {\n\t\treturn false;\n\t}\n}\n';
const COMBO = 'class R {\n\tbundleResource(method, url) {\n\t\tconst resourceUrl = url;\n\t\tconst response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.chunkResponse(requestUrl);\n\t\treturn response;\n\t\treturn { status: 404 };\n\t}\n\tserveBundle = async (req, res) => {\n\t};\n}\n';

function makeSandbox(name) {
  const base = path.join(os.tmpdir(), 'dsh-patch-int-' + name + '-' + Date.now());
  const mods = path.join(base, 'lib/node_modules/@deepseek-ai');
  const write = (rel, content) => { const p = path.join(mods, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  write('dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-alpha.2' }));
  write('dsh-client-ui-layout/lib/client.js', LOOPBACK);
  write('dsh-client-connection/lib/index.js', AUTH);
  write('dsh-client-modules/lib/index.js', COMBO);
  return { base, mods };
}

function runPatch(mods) {
  return spawnSync('node', [SCRIPT], { env: { ...process.env, DSH_PATCH_ONLY_DIR: mods }, encoding: 'utf8' });
}

// ── A. 正常打补丁 ────────────────────────────────────────────────
console.log('\n=== A. 正常打补丁：标记后置 + 备份 + 原子写 ===');
const a = makeSandbox('a');
const rA = runPatch(a.mods);
ok(rA.status === 0, "退出码 0", String(rA.status));
const clientFile = path.join(a.mods, 'dsh-client-ui-layout/lib/client.js');
const patched = fs.readFileSync(clientFile, 'utf8');
ok(/dsh-patch: loopback-host-mode-applied \*\/\s*$/.test(patched), '标记写在文件末尾（截断即丢标记，可被下次运行识别）');
ok(!patched.trimStart().startsWith('/* dsh-patch'), '标记不再位于文件开头');
ok(fs.existsSync(clientFile + '.dsh-orig'), '首次改写前留下 .dsh-orig 备份');
ok(!fs.readdirSync(path.dirname(clientFile)).some((n) => n.endsWith('.tmp')), '无 .tmp 残留');

// ── B. 旧式截断：标记在开头 + 正文残缺 ───────────────────────────
console.log('\n=== B. 旧式截断（标记前置 + 正文残缺）→ 从备份还原后重打 ===');
const b = makeSandbox('b');
const rB1 = runPatch(b.mods);
ok(rB1.status === 0, "首次打补丁成功", String(rB1.status));
const bFile = path.join(b.mods, 'dsh-client-ui-layout/lib/client.js');
const marker = '/* dsh-patch: loopback-host-mode-applied */';
fs.writeFileSync(bFile, marker + '\nclass B { constr\n'); // 模拟旧版「标记前置 + 截断」
ok(spawnSync(process.execPath, ['--check', bFile]).status !== 0, '夹具本身语法不合法（模拟真实截断）');
const rB2 = runPatch(b.mods);
const bAfter = fs.readFileSync(bFile, 'utf8');
ok(spawnSync(process.execPath, ['--check', bFile]).status === 0, '截断文件被修复为语法合法', '仍不合法');
ok(/dsh-patch: loopback-host-mode-applied \*\/\s*$/.test(bAfter), '修复后标记回到文件末尾');
ok(rB2.status === 0, '修复后补丁判定为已生效（退出码 0）', String(rB2.status));

// ── C. 新式截断：标记丢失 → 不能静默通过 ────────────────────────
console.log('\n=== C. 标记丢失（新式截断）→ 不得静默通过 ===');
const c = makeSandbox('c');
runPatch(c.mods);
const cFile = path.join(c.mods, 'dsh-client-connection/lib/index.js');
const cFull = fs.readFileSync(cFile, 'utf8');
fs.writeFileSync(cFile, cFull.slice(0, 40)); // 砍掉正文与末尾标记
const rC = runPatch(c.mods);
ok(rC.status !== 0, '无法重打时必须显式失败（不能静默当作已打补丁）', '退出码 ' + rC.status);
ok(/FATAL/.test((rC.stdout || '') + (rC.stderr || '')), '输出包含 [FATAL] 提示');


// ── D. 标记丢失 + 锚点仍在的截断：不得静默写成坏文件（子代理 P1）──
console.log('\n=== D. 标记丢失的截断 → 必须响亮失败，不能静默写坏 ===');
const d = makeSandbox('d');
const rD1 = runPatch(d.mods);
ok(rD1.status === 0, "首次打补丁成功", String(rD1.status));
const dFile = path.join(d.mods, 'dsh-client-ui-layout/lib/client.js');
// 构造：未打补丁的源文件被截断到一半 —— 锚点（部分）还在，但没有补丁标记，语法不合法。
// 这是旧版脚本「先写内容、后写标记」被打断后，在「尚未打补丁的文件」上的等价形态。
fs.writeFileSync(dFile, LOOPBACK.slice(0, 30));
ok(!fs.readFileSync(dFile, 'utf8').includes('dsh-patch'), '夹具无补丁标记');
ok(spawnSync(process.execPath, ['--check', dFile]).status !== 0, '夹具语法不合法');
const rD2 = runPatch(d.mods);
const dAfter = fs.readFileSync(dFile, 'utf8');
const dOk = spawnSync(process.execPath, ['--check', dFile]).status === 0;
ok(rD2.status !== 0 || dOk, '截断输入不得被静默「成功」处理（要么失败，要么产物合法）', 'exit=' + rD2.status + ' syntaxOk=' + dOk);
ok(dOk || !dAfter.includes('dsh-patch'), '绝不出现「写入了标记但语法仍坏」的中间态', dAfter.slice(0, 40));

// ── E. 原子写与写前自检的静态契约（防回归）──
console.log('\n=== E. 原子写契约 ===');
const scriptSrc = fs.readFileSync(SCRIPT, 'utf8');
ok(/renameSync\(tmp, target\)/.test(scriptSrc), '写入使用 rename 原子替换');
ok(/if \(!syntaxOk\(tmp\)\)/.test(scriptSrc), '落盘前对临时文件做语法自检');
ok(/\.tmp\.js'/.test(scriptSrc), '临时文件后缀为 .js（否则 node --check 恒失败）');
ok(/syntaxOk\(bak\)/.test(scriptSrc), '还原前校验备份本身是否合法');
for (const dir of [a.base, b.base, c.base, d.base]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
console.log('\n────────────────────────────────────────');
console.log(fail === 0
  ? '✅ 补丁中断安全测试通过（' + pass + '/' + (pass + fail) + '）'
  : '❌ 补丁中断安全测试失败：' + fail + ' 项未通过 / 共 ' + (pass + fail) + ' 项');
process.exit(fail === 0 ? 0 : 1);
