#!/usr/bin/env node
/**
 * cordis.patch.yml 按条目粒度删除回归测试。
 * 用法: node tests/unit/patch-entry-removal.test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { removePatchEntries } = require(path.join(root, 'gateway/src/plugins/plugin-manager.js'));

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

console.log('\n=== A. 只删命中条目，保留其余条目与注释 ===');
const r1 = removePatchEntries(SAMPLE, (b) => /dsh-archived-chats/.test(b));
ok(r1.removed === 1, `删除了 1 个条目（实际 ${r1.removed}）`);
ok(r1.text.includes('better-sidebar') && r1.text.includes('dsh-super-injector') && r1.text.includes('keep-me') && r1.text.includes('# 注释行'), '保留非目标条目与注释');
ok(!r1.text.includes('dsh-archived-chats'), '目标条目已移除');

console.log('\n=== B. 相似名/空内容边界 ===');
const SAMPLE2 = '- id: keep-a\n  disabled: true\n- insert:\n    - id: dsh-market\n- id: keep-b\n  disabled: true\n';
const r2 = removePatchEntries(SAMPLE2, (b) => b.includes('dsh-market'));
ok(r2.removed === 1 && r2.text.includes('keep-a') && r2.text.includes('keep-b'), '相似名不误伤');
ok(removePatchEntries('[]\n', () => true).removed === 0, '非条目内容不做删除');
const r4 = removePatchEntries(SAMPLE, () => false);
ok(r4.removed === 0 && r4.text === SAMPLE, '无命中时内容不变');

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
