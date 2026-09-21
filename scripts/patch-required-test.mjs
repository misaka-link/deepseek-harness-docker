/**
 * S4 回归测试：patch-dsh-client.mjs 的"必需补丁未命中即失败"行为。
 * 用法: node scripts/patch-required-test.mjs
 *
 * 在沙箱目录里伪造一份最小 DSH 目录结构，验证：
 *   A. 锚点齐全 → 退出码 0，且标记全部命中
 *   B. 破坏 auth 锚点 → 退出码非 0，且打印 [FATAL]
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

const LOOPBACK_SNIPPET = 'const x = isLoopbackHostname(pageLocation.hostname);';
const AUTH_SNIPPET = 'class C {\n\tisAuthenticated(request) {\n\t\treturn false;\n\t}\n}\n';
const COMBO_SNIPPET = 'class R {\n\tbundleResource(method, url) {\n\t\tconst resourceUrl = url;\n\t\tconst response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.chunkResponse(requestUrl);\n\t\treturn response;\n\t}\n}\n';

function makeSandbox(name, { breakAuth = false } = {}) {
  const base = path.join(os.tmpdir(), `dsh-patch-${name}-${Date.now()}`);
  const mods = path.join(base, 'lib/node_modules/@deepseek-ai');
  const write = (rel, content) => {
    const p = path.join(mods, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write('dsh-client-ui-layout/lib/client.js', LOOPBACK_SNIPPET + '\n');
  write('dsh-client-connection/lib/index.js', breakAuth ? 'class C {\n\tother() {}\n}\n' : AUTH_SNIPPET);
  write('dsh-client-modules/lib/index.js', COMBO_SNIPPET);
  return base;
}

function runPatch(base) {
  return spawnSync('node', [SCRIPT], {
    env: {
      ...process.env,
      // 只扫描沙箱目录，避免环境里其它（可能已打过补丁的）DSH 副本干扰判定
      DSH_PATCH_ONLY_DIR: path.join(base, 'lib/node_modules/@deepseek-ai')
    },
    encoding: 'utf8'
  });
}

console.log('\n=== A. 锚点齐全 → 应成功 ===');
const good = makeSandbox('good');
const rA = runPatch(good);
ok(rA.status === 0, `退出码为 0（实际 ${rA.status}）`);
ok(/全部必需补丁已生效/.test(rA.stdout || ''), '输出包含"全部必需补丁已生效"');
ok(/已应用=\[[^\]]*auth-bypass/.test(rA.stdout || ''), 'auth-bypass 被标记为已应用');
ok(/已应用=\[[^\]]*combo-fallback/.test(rA.stdout || ''), 'combo-fallback 被标记为已应用');
ok(/已应用=\[[^\]]*client-loopback/.test(rA.stdout || ''), 'client-loopback 被标记为已应用');

console.log('\n=== B. 破坏 auth 锚点 → 应 FATAL 非零退出 ===');
const bad = makeSandbox('bad', { breakAuth: true });
const rB = runPatch(bad);
const rBOut = (rB.stdout || '') + (rB.stderr || '');
ok(rB.status !== 0, `退出码非 0（实际 ${rB.status}）`);
ok(/\[FATAL\]/.test(rBOut), '输出包含 [FATAL]');
ok(/auth-bypass/.test(rBOut), '指出未命中的补丁名 auth-bypass');

fs.rmSync(good, { recursive: true, force: true });
fs.rmSync(bad, { recursive: true, force: true });
console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
