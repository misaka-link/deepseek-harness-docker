#!/usr/bin/env node
/**
 * i18n-parity.mjs — 8-language parity, placeholder consistency, HTML whitelist,
 * encoding hygiene, and static key-reference integrity gate.
 *
 * Usage: node tests/gates/i18n-parity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const LOCALES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'];

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

function extractPlaceholders(str) {
  return [...new Set([...String(str).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))].sort();
}

function findDisallowedHtml(str) {
  const stripped = String(str)
    .replace(/<\/?(?:b|code)>/g, '')
    .replace(/<a\s+data-href-key="[a-zA-Z0-9_-]+">/g, '')
    .replace(/<\/a>/g, '')
    .replace(/<br\s*\/?>/g, '');
  const m = stripped.match(/<[a-zA-Z/!][^>]*>/);
  return m ? m[0] : null;
}

function flattenFrontendDict(mod) {
  const obj = mod.default && typeof mod.default === 'object' ? mod.default : mod;
  const flat = new Map();
  for (const [ns, entries] of Object.entries(obj)) {
    if (ns === 'default' || !entries || typeof entries !== 'object') continue;
    for (const [k, v] of Object.entries(entries)) {
      flat.set(`${ns}.${k}`, v);
    }
  }
  return flat;
}

console.log('\n=== A. 前端 8 语言词典对等性与卫生检查 ===');
const feDicts = new Map();
for (const lang of LOCALES) {
  const filePath = path.join(root, 'gateway/public/ui/i18n', lang, 'index.js');
  const exists = fs.existsSync(filePath);
  ok(exists, `前端词典存在: ${lang}/index.js`);
  if (!exists) continue;

  const raw = fs.readFileSync(filePath, 'utf8');
  ok(!raw.includes('\uFEFF'), `前端 ${lang} 无 UTF-8 BOM`);
  ok(!raw.includes('\u200B'), `前端 ${lang} 无零宽空格 (U+200B)`);

  const mod = await import(pathToFileURL(filePath).href);
  feDicts.set(lang, flattenFrontendDict(mod));
}

const zhFe = feDicts.get('zh') || new Map();
ok(zhFe.size > 0, `前端基准词典 zh 加载成功 (${zhFe.size} keys)`);

for (const lang of LOCALES) {
  const dict = feDicts.get(lang);
  if (!dict) continue;
  const missing = [...zhFe.keys()].filter((k) => !dict.has(k));
  const extra = [...dict.keys()].filter((k) => !zhFe.has(k));
  const empty = [];
  const placeholderMismatches = [];
  const unsafeHtml = [];

  for (const [k, v] of dict.entries()) {
    if (typeof v !== 'string' || v.trim().length === 0) {
      empty.push(k);
      continue;
    }
    const badTag = findDisallowedHtml(v);
    if (badTag) unsafeHtml.push(`${k}: ${badTag}`);
    if (lang !== 'zh' && zhFe.has(k)) {
      const basePh = extractPlaceholders(zhFe.get(k)).join(',');
      const curPh = extractPlaceholders(v).join(',');
      if (basePh !== curPh) {
        placeholderMismatches.push(`${k} (zh:[${basePh}] vs ${lang}:[${curPh}])`);
      }
    }
  }

  ok(missing.length === 0, `前端 ${lang} 无缺失 key`, missing.slice(0, 6).join(', '));
  ok(extra.length === 0, `前端 ${lang} 无多余 key`, extra.slice(0, 6).join(', '));
  ok(empty.length === 0, `前端 ${lang} 无空字符串`, empty.slice(0, 6).join(', '));
  ok(unsafeHtml.length === 0, `前端 ${lang} 仅含白名单 HTML 标签 (<b>/<code>/<a data-href-key>)`, unsafeHtml.slice(0, 4).join(' | '));
  if (lang !== 'zh') {
    ok(placeholderMismatches.length === 0, `前端 ${lang} 占位符集合与 zh 一致`, placeholderMismatches.slice(0, 4).join(' | '));
  }
}

console.log('\n=== B. 前端静态 t(ns, key) 引用完整性 ===');
const uiJsFiles = walkFiles(path.join(root, 'gateway/public/ui/js'), ['.js']);
const missingFeRefs = [];
let feRefCount = 0;
for (const abs of uiJsFiles) {
  const rel = path.relative(root, abs);
  const src = fs.readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_]+)['"]\s*,\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
    feRefCount++;
    const fullKey = `${m[1]}.${m[2]}`;
    if (!zhFe.has(fullKey)) {
      missingFeRefs.push(`${rel} -> ${fullKey}`);
    }
  }
}
ok(feRefCount > 0, `已扫描前端静态 t() 引用 (${feRefCount} 处)`);
ok(missingFeRefs.length === 0, '前端所有静态 t(ns, key) 均在基准词典中存在', missingFeRefs.slice(0, 8).join(' | '));

console.log('\n=== C. 后端 8 语言错误码/消息词典对等性 ===');
const beDicts = new Map();
for (const lang of LOCALES) {
  const filePath = path.join(root, 'gateway/src/i18n/messages', `${lang}.json`);
  const exists = fs.existsSync(filePath);
  ok(exists, `后端词典存在: messages/${lang}.json`);
  if (!exists) continue;
  const raw = fs.readFileSync(filePath, 'utf8');
  ok(!raw.includes('\uFEFF'), `后端 ${lang}.json 无 UTF-8 BOM`);
  ok(!raw.includes('\u200B'), `后端 ${lang}.json 无零宽空格 (U+200B)`);
  beDicts.set(lang, JSON.parse(raw));
}

const zhBe = beDicts.get('zh') || {};
const zhBeKeys = Object.keys(zhBe);
ok(zhBeKeys.length > 0, `后端基准词典 zh.json 加载成功 (${zhBeKeys.length} keys)`);

for (const lang of LOCALES) {
  const dict = beDicts.get(lang);
  if (!dict) continue;
  const keys = Object.keys(dict);
  const missing = zhBeKeys.filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
  const extra = keys.filter((k) => !Object.prototype.hasOwnProperty.call(zhBe, k));
  const empty = keys.filter((k) => typeof dict[k] !== 'string' || dict[k].trim().length === 0);
  const phDiff = [];
  if (lang !== 'zh') {
    for (const k of zhBeKeys) {
      if (!Object.prototype.hasOwnProperty.call(dict, k)) continue;
      const a = extractPlaceholders(zhBe[k]).join(',');
      const b = extractPlaceholders(dict[k]).join(',');
      if (a !== b) phDiff.push(`${k} (zh:[${a}] vs ${lang}:[${b}])`);
    }
  }
  ok(missing.length === 0, `后端 ${lang}.json 无缺失 key`, missing.slice(0, 6).join(', '));
  ok(extra.length === 0, `后端 ${lang}.json 无多余 key`, extra.slice(0, 6).join(', '));
  ok(empty.length === 0, `后端 ${lang}.json 无空字符串`, empty.slice(0, 6).join(', '));
  if (lang !== 'zh') {
    ok(phDiff.length === 0, `后端 ${lang}.json 占位符集合与 zh 一致`, phDiff.slice(0, 4).join(' | '));
  }
}

console.log('\n=== D. 后端 AppError 与 translateServerMessage 静态键覆盖 ===');
const beFiles = walkFiles(path.join(root, 'gateway/src'), ['.js']);
const unmappedBe = [];
for (const abs of beFiles) {
  const rel = path.relative(root, abs);
  const src = fs.readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/new\s+AppError\(\s*['"]([A-Z0-9_]+)['"]/g)) {
    const code = m[1];
    if (!Object.prototype.hasOwnProperty.call(zhBe, code) && !Object.prototype.hasOwnProperty.call(zhBe, `error.${code}`)) {
      unmappedBe.push(`${rel} -> AppError(${code})`);
    }
  }
  for (const m of src.matchAll(/translateServerMessage\([^,]+,\s*['"]([a-zA-Z0-9_.-]+)['"]/g)) {
    const key = m[1];
    if (!Object.prototype.hasOwnProperty.call(zhBe, key)) {
      unmappedBe.push(`${rel} -> translateServerMessage(${key})`);
    }
  }
}
ok(unmappedBe.length === 0, '后端所有 AppError 与服务端翻译键均已收录在词典中', unmappedBe.slice(0, 8).join(' | '));

console.log('\n────────────────────────────────────────');
console.log(
  fail === 0
    ? `✅ 8 语言 i18n 对等与完整性门禁通过（${pass}/${pass + fail}）`
    : `❌ 8 语言 i18n 门禁失败：${fail} 项未通过 / 共 ${pass + fail} 项`
);
process.exit(fail === 0 ? 0 : 1);
