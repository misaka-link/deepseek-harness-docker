/**
 * S1 回归测试：DSH 版本号校验与路径包含性。
 * 纯函数测试，无副作用。用法: node scripts/dsh-version-validation-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { isValidVersion, resolveWithinDir } = require(path.join(here, '../gateway/dsh-version.js'));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; }
};

console.log('\n=== A. 合法版本号应通过 ===');
for (const v of ['0.1.6-alpha.2', '1.2.3', '0.1.2-rc.1', '10.20.30', '1.0.0+build.5', '0.1.6-alpha.2+build.1', '  0.1.6  ']) {
  ok(isValidVersion(v), `合法: ${JSON.stringify(v)}`);
}

console.log('\n=== B. 攻击性/非法输入应被拒 ===');
const bad = [
  '../../../root/.dsh/profiles/web',
  '../../..',
  '..',
  'a/b',
  '/etc/passwd',
  'npm:evil-package',
  'npm:@scope/pkg@1.0.0',
  'file:/etc/passwd',
  '1.2',
  '1.2.3.4',
  '',
  '   ',
  'x'.repeat(65),
  '1.2.3-',
  '1.2.3-..',
  '0.1.6-alpha.2; rm -rf /',
  '${jndi:ldap://x}',
  'v1.2.3',
  null,
  undefined,
  123,
  {}
];
for (const v of bad) ok(!isValidVersion(v), `拒绝: ${JSON.stringify(v)?.slice(0, 40)}`);

console.log('\n=== C. resolveWithinDir 包含性 ===');
const base = '/app/.dsh-versions-cache';
ok(resolveWithinDir(base, '0.1.6-alpha.2') === '/app/.dsh-versions-cache/0.1.6-alpha.2', '正常版本落在目录内');
ok(resolveWithinDir(base, 'a/../b') === '/app/.dsh-versions-cache/b', '内部 .. 归一化后仍在目录内');
for (const v of ['../../../root/.dsh/profiles/web', '/etc/passwd', '../../..']) {
  let threw = false;
  try { resolveWithinDir(base, v); } catch { threw = true; }
  ok(threw, `越界被拒: ${JSON.stringify(v)}`);
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
