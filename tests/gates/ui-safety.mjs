#!/usr/bin/env node
/**
 * ui-safety.mjs — Static security and hygiene gate for gateway/public/ui/js/** and templates/**.
 *
 * Enforces:
 *   - Zero dangerous DOM sink APIs (innerHTML / outerHTML / insertAdjacentHTML / document.write)
 *   - Zero dynamic code execution (eval / new Function)
 *   - Zero inline on*= event attributes in HTML templates
 *   - Zero hardcoded legacy DSH version arrays/literals (0.1.x / 0.2.x) in UI code or templates
 *
 * Usage: node tests/gates/ui-safety.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

function walkFiles(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full, exts));
    else if (exts.some((ext) => ent.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

let pass = 0;
let fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) {
    console.log('   ✔ ' + msg);
    pass++;
  } else {
    console.log('   ❌ ' + msg + (detail ? '  → ' + detail : ''));
    fail++;
  }
};

const jsFiles = walkFiles(path.join(root, 'gateway/public/ui/js'), ['.js']);
const templateFiles = walkFiles(path.join(root, 'gateway/public/templates'), ['.html']);

console.log('\n=== A. 前端 JS 与模板 DOM 注入安全门禁 ===');
ok(jsFiles.length > 0, `已发现前端 JS 模块 (${jsFiles.length} 个)`);
ok(templateFiles.length > 0, `已发现 HTML 模板 (${templateFiles.length} 个)`);

const FORBIDDEN_SINKS = [
  { name: 'innerHTML', re: /\.\s*innerHTML\b/ },
  { name: 'outerHTML', re: /\.\s*outerHTML\b/ },
  { name: 'insertAdjacentHTML', re: /\.\s*insertAdjacentHTML\b/ },
  { name: 'document.write', re: /\bdocument\.write\s*\(/ },
  { name: 'eval()', re: /\beval\s*\(/ },
  { name: 'new Function()', re: /\bnew\s+Function\s*\(/ }
];

for (const sink of FORBIDDEN_SINKS) {
  const hits = [];
  for (const abs of [...jsFiles, ...templateFiles]) {
    const rel = path.relative(root, abs);
    const raw = fs.readFileSync(abs, 'utf8');
    const cleaned = abs.endsWith('.js') ? stripJsComments(raw) : raw;
    cleaned.split('\n').forEach((line, idx) => {
      if (sink.re.test(line)) {
        hits.push(`${rel}:${idx + 1}`);
      }
    });
  }
  ok(hits.length === 0, `禁止使用 ${sink.name}`, hits.join(', '));
}

console.log('\n=== B. HTML 模板禁止内联 on*= 事件属性 ===');
const inlineHandlerHits = [];
for (const abs of templateFiles) {
  const rel = path.relative(root, abs);
  const html = fs.readFileSync(abs, 'utf8');
  // Strip inline <script> blocks before scanning HTML tags
  const tagsOnly = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  for (const tagM of tagsOnly.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const evM = tagM[0].match(/\s(on[a-z]{2,})\s*=/i);
    if (evM) {
      inlineHandlerHits.push(`${rel}: ${evM[1]}`);
    }
  }
}
ok(inlineHandlerHits.length === 0, 'HTML 模板不含任何内联 on*= 事件属性', inlineHandlerHits.join(', '));

console.log('\n=== C. 前端禁止硬编码旧 DSH 版本矩阵 (0.1.x / 0.2.x) ===');
const legacyVerHits = [];
const LEGACY_VER_RE = /['"]v?0\.[12]\.\d+(?:-[0-9A-Za-z.-]+)?['"]/g;
for (const abs of [...jsFiles, ...templateFiles]) {
  const rel = path.relative(root, abs);
  const raw = fs.readFileSync(abs, 'utf8');
  const cleaned = abs.endsWith('.js') ? stripJsComments(raw) : raw;
  cleaned.split('\n').forEach((line, idx) => {
    const m = line.match(LEGACY_VER_RE);
    if (m) legacyVerHits.push(`${rel}:${idx + 1} (${m.join(', ')})`);
  });
}
ok(legacyVerHits.length === 0, '前端 JS 与模板无硬编码旧版 DSH 0.1.x/0.2.x 版本号', legacyVerHits.slice(0, 8).join(' | '));

console.log('\n────────────────────────────────────────');
console.log(
  fail === 0
    ? `✅ UI 安全与静态卫生门禁通过（${pass}/${pass + fail}）`
    : `❌ UI 安全门禁失败：${fail} 项未通过 / 共 ${pass + fail} 项`
);
process.exit(fail === 0 ? 0 : 1);
