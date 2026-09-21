/**
 * M8 回归测试：cordis.patch.yml 按"条目"粒度删除（替代旧跨行正则）。
 * 用法: node scripts/patch-entry-removal-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { removePatchEntries } = require(path.join(here, '../gateway/plugin-manager.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

const SAMPLE = [
  '# 注释行',
  '- id: better-sidebar',
  '  disabled: true',
  '- id: dsh-super-injector',
  '  disabled: true',
  '- insert:',
  '    - id: dsh-archived-chats',
  '      name: dsh-archived-chats',
  '- id: keep-me',
  '  disabled: true',
  ''
].join('\n');

console.log('\n=== A. 只删命中的条目，不动其它条目/注释 ===');
const r1 = removePatchEntries(SAMPLE, (b) => /dsh-archived-chats/.test(b));
ok(r1.removed === 1, `删除了 1 个条目（实际 ${r1.removed}）`);
ok(r1.text.includes('better-sidebar'), '保留 better-sidebar');
ok(r1.text.includes('dsh-super-injector'), '保留 dsh-super-injector');
ok(r1.text.includes('keep-me'), '保留 keep-me（不会跨条目误删）');
ok(r1.text.includes('# 注释行'), '保留注释行');
ok(!r1.text.includes('dsh-archived-chats'), '目标条目已移除');

console.log('\n=== B. 插件名含正则元字符也不误伤 ===');
const SAMPLE2 = '- id: keep-a\n  disabled: true\n- insert:\n    - id: dsh-market\n- id: keep-b\n  disabled: true\n';
const r2 = removePatchEntries(SAMPLE2, (b) => b.includes('dsh-market'));
ok(r2.removed === 1 && r2.text.includes('keep-a') && r2.text.includes('keep-b'), '元字符/相似名不误删');

console.log('\n=== C. 空内容/无命中 ===');
const r3 = removePatchEntries('[]\n', () => true);
ok(r3.removed === 0, '非条目内容不做删除');
const r4 = removePatchEntries(SAMPLE, () => false);
ok(r4.removed === 0 && r4.text === SAMPLE, '无命中时内容不变');

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
