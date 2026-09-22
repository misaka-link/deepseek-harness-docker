/**
 * P6 回归测试：patch-yaml.cjs（外科手术式条目删除 + 安全闸）。
 *
 * 覆盖：
 *   A. 只删命中条目，其余字节**逐字保留**（含注释、空行、CRLF、`!!js` 表达式）
 *   B. 无命中时返回内容与原文字节完全一致
 *   C. 真实场景：删除历史遗留的 dsh-browser-desktop 条目后，llm-pi-ai / ui-theme /
 *      agent-default-model（DSH 设置与模型 provider 配置）必须原样保留
 *   D. 安全闸拦下"会丢失非目标条目"的改写
 *   E. 安全闸拦下"受保护条目（llm-pi-ai）被删"
 *   F. 安全闸拦下"结果不是合法 YAML 序列"
 *
 * 用法: node scripts/patch-protect-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  removePatchEntries,
  assertPatchSafe,
  topLevelEntryIds,
  protectedPatchIds,
  looksLikePatchDocument
} = require(path.join(here, 'patch-yaml.cjs'));

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

console.log('\n=== A. 外科手术式删除：其余字节逐字保留 ===');
const rA = removePatchEntries(REAL_PATCH, (b) => b.includes('dsh-browser-desktop'));
ok(rA.removed === 1, `删除了 1 个条目（实际 ${rA.removed}）`);
ok(!rA.text.includes('dsh-browser-desktop'), '目标条目已移除');
ok(rA.text.includes('llm-pi-ai') && rA.text.includes('hy4-preview'), 'llm-pi-ai / hy4-preview 完整保留');
ok(rA.text.includes('agent-default-model'), '后续条目保留');
ok(rA.text.startsWith('# Your patch layer'), '文件头注释保留');
// 期望结果 = 原文精确减去那 4 行条目
const expectedA = REAL_PATCH.replace(
  '- id: dsh-browser-desktop\n  name: "@dsh-custom/dsh-browser-desktop"\n  config:\n    enabled: true\n',
  ''
);
ok(rA.text === expectedA, '结果与"原文减去该条目"逐字节一致');

console.log('\n=== B. 无命中时字节完全不变 ===');
const rB = removePatchEntries(REAL_PATCH, () => false);
ok(rB.removed === 0 && rB.text === REAL_PATCH, '无命中 ⇒ 原文不变（字节级）');
const rB2 = removePatchEntries('', () => true);
ok(rB2.removed === 0 && rB2.text === '', '空内容不报错且不变');

console.log('\n=== B2. CRLF 与嵌套 insert 结构 ===');
const crlf = '# c\r\n- id: keep\r\n  disabled: true\r\n- insert:\r\n    - id: drop-me\r\n      name: drop-me\r\n- id: tail\r\n';
const rCrlf = removePatchEntries(crlf, (b) => b.includes('drop-me'));
ok(rCrlf.removed === 1 && rCrlf.text.includes('keep') && rCrlf.text.includes('tail'), 'CRLF 下正确删除嵌套 insert 条目');
ok(rCrlf.text.includes('\r\n'), 'CRLF 行尾被保留');
ok(!rCrlf.text.includes('drop-me'), '目标嵌套条目已移除');

console.log('\n=== C. 真实场景：保留 DSH 设置与模型配置 ===');
const rC = removePatchEntries(REAL_PATCH, (b) => b.includes('dsh-browser-desktop'));
const idsAfter = topLevelEntryIds(rC.text);
ok(JSON.stringify(idsAfter) === JSON.stringify(['ui-settings-general', 'ui-theme', 'llm-pi-ai', 'agent-default-model']),
  `顶层条目 id 完整（${idsAfter.join(', ')}）`);
ok(!assertPatchSafeGuarded(rC.text), '安全闸对正常结果放行');

function assertPatchSafeGuarded(after) {
  try { assertPatchSafe({ before: REAL_PATCH, after, removedIds: ['dsh-browser-desktop'] }); return null; } catch (e) { return e.message; }
}

console.log('\n=== D. 安全闸：丢失非目标条目必须拦下 ===');
const brokenD = REAL_PATCH.replace(/- id: ui-theme[\s\S]*?preference: light\n/, '');
const msgD = throws(() => assertPatchSafe({ before: REAL_PATCH, after: brokenD, removedIds: ['dsh-browser-desktop'] }));
ok(Boolean(msgD) && /ui-theme/.test(msgD), `拦下并点名丢失条目（${String(msgD).slice(0, 60)}…）`);

console.log('\n=== E. 安全闸：受保护条目 llm-pi-ai 被删必须拦下 ===');
const brokenE = REAL_PATCH.replace(/- id: llm-pi-ai[\s\S]*?hy4-preview\n/, '');
const msgE = throws(() => assertPatchSafe({ before: REAL_PATCH, after: brokenE, removedIds: ['dsh-browser-desktop'] }));
ok(Boolean(msgE) && /llm-pi-ai/.test(msgE), '拦下 llm-pi-ai 丢失');
ok(protectedPatchIds().includes('llm-pi-ai'), '默认保护清单包含 llm-pi-ai');

console.log('\n=== F. 安全闸：非法文档形态必须拦下 ===');
const msgF = throws(() => assertPatchSafe({ before: REAL_PATCH, after: 'this: is a mapping\n', removedIds: [] }));
ok(Boolean(msgF), '拦下"结果不是顶层序列"');
ok(looksLikePatchDocument('[]') && looksLikePatchDocument('- id: a\n') && !looksLikePatchDocument('a: b\n'), 'looksLikePatchDocument 判定正确');

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
