#!/usr/bin/env node
/**
 * scripts/lib/patch-yaml.cjs 外科手术式条目删除与安全闸回归测试。
 * 用法: node tests/unit/patch-protect.test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const {
  removePatchEntries,
  assertPatchSafe,
  topLevelEntryIds,
  protectedPatchIds,
  looksLikePatchDocument
} = require(path.join(root, 'scripts/lib/patch-yaml.cjs'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const REAL_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-08-13.1',
  '',
  '- id: ui-theme',
  '  name: "@deepseek-ai/dsh-client-ui-theme"',
  '  config:',
  '    preference: light',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      newapi:',
  '        displayName: NewAPI',
  '        models:',
  '          - id: hy4-preview',
  '',
  '- id: dsh-browser-desktop',
  '  name: "@dsh-custom/dsh-browser-desktop"',
  '  config:',
  '    enabled: true',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  ''
].join('\n');

const rA = removePatchEntries(REAL_PATCH, (b) => b.includes('dsh-browser-desktop'));
const expectedA = REAL_PATCH.replace(
  '- id: dsh-browser-desktop\n  name: "@dsh-custom/dsh-browser-desktop"\n  config:\n    enabled: true\n',
  ''
);
ok(rA.removed === 1 && rA.text === expectedA, 'A. 外科手术式删除与预期逐字节一致');

const rB = removePatchEntries(REAL_PATCH, () => false);
ok(rB.removed === 0 && rB.text === REAL_PATCH, 'B. 无命中原文不变');
ok(removePatchEntries('', () => true).text === '', 'B2. 空内容安全返回');

const crlf = '# c\r\n- id: keep\r\n  disabled: true\r\n- insert:\r\n    - id: drop-me\r\n      name: drop-me\r\n- id: tail\r\n';
const rCrlf = removePatchEntries(crlf, (b) => b.includes('drop-me'));
ok(rCrlf.removed === 1 && rCrlf.text.includes('\r\n') && !rCrlf.text.includes('drop-me'), 'B3. CRLF 与嵌套 insert 正确处理');

const idsAfter = topLevelEntryIds(rA.text);
ok(JSON.stringify(idsAfter) === JSON.stringify(['ui-settings-general', 'ui-theme', 'llm-pi-ai', 'agent-default-model']), 'C. 顶层条目 id 完整');
ok(!throws(() => assertPatchSafe({ before: REAL_PATCH, after: rA.text, removedIds: ['dsh-browser-desktop'] })), 'C2. 安全闸放行正常结果');

const brokenD = REAL_PATCH.replace(/- id: ui-theme[\s\S]*?preference: light\n/, '');
ok(/ui-theme/.test(String(throws(() => assertPatchSafe({ before: REAL_PATCH, after: brokenD, removedIds: ['dsh-browser-desktop'] })))), 'D. 安全闸拦截非目标条目丢失');

const brokenE = REAL_PATCH.replace(/- id: llm-pi-ai[\s\S]*?hy4-preview\n/, '');
ok(/llm-pi-ai/.test(String(throws(() => assertPatchSafe({ before: REAL_PATCH, after: brokenE, removedIds: ['dsh-browser-desktop'] })))), 'E. 安全闸拦截受保护条目 llm-pi-ai 丢失');
ok(protectedPatchIds().includes('llm-pi-ai'), 'E2. 默认保护清单包含 llm-pi-ai');

ok(Boolean(throws(() => assertPatchSafe({ before: REAL_PATCH, after: 'this: is a mapping\n', removedIds: [] }))), 'F. 安全闸拦截非法非序列文档');
ok(looksLikePatchDocument('[]') && looksLikePatchDocument('- id: a\n') && !looksLikePatchDocument('a: b\n'), 'F2. looksLikePatchDocument 判定准确');

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
