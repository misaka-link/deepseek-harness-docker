#!/usr/bin/env node
/**
 * unreleased-cleanup-check.mjs — Checks that local doc/UNRELEASED.md contains no already-released entries.
 *
 * Skips cleanly (exit 0) when doc/UNRELEASED.md is absent (e.g., CI / clean checkout).
 *
 * Usage: node tests/gates/unreleased-cleanup-check.mjs [--json] [--file <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const fileArgIdx = argv.indexOf('--file');
const UNRELEASED = fileArgIdx >= 0 && argv[fileArgIdx + 1]
  ? path.resolve(argv[fileArgIdx + 1])
  : path.join(root, 'doc', 'UNRELEASED.md');
const CHANGELOG = path.join(root, 'CHANGELOG.md');
const jsonOut = argv.includes('--json');

if (!fs.existsSync(UNRELEASED)) {
  console.log('[unreleased] 未发现 doc/UNRELEASED.md，跳过');
  process.exit(0);
}

const unreleased = fs.readFileSync(UNRELEASED, 'utf8');
const changelog = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, 'utf8') : '';

const releasedVersions = new Set(
  [...changelog.matchAll(/^## \[v?([0-9][^\]]*)\]/gm)].map((m) => m[1].trim())
);
const changelogIssues = new Set(
  [...changelog.matchAll(/#(\d+)/g)].map((m) => m[1])
);

function splitSections(text) {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (cur) out.push(cur);
      cur = { title: line.replace(/^## /, '').trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const sections = splitSections(unreleased);
const failures = [];
const warnings = [];

for (const s of sections) {
  const body = s.lines.join('\n');
  if (body.includes('unreleased-ok')) continue;

  const releasedMark = body.match(/已发布|已合入[\s`*]*v?\d|已随[\s`*]*v?\d/);
  if (releasedMark) {
    failures.push({ title: s.title, reason: `段内出现已发布标记「${releasedMark[0]}」` });
    continue;
  }

  const baseline = s.title.match(/基线\s*v?(\d+\.\d+\.\d+)/);
  if (baseline && releasedVersions.has(baseline[1])) {
    failures.push({ title: s.title, reason: `标题基线 v${baseline[1]} 已发布，本段应归档` });
    continue;
  }

  const checked = (body.match(/^\s*- \[x\]/gim) || []).length;
  const unchecked = (body.match(/^\s*- \[ \]/gim) || []).length;
  if (checked > 0 && unchecked === 0) {
    failures.push({ title: s.title, reason: `核对清单 ${checked} 项全部已勾选，本段应归档` });
    continue;
  }

  const issues = [...new Set([...body.matchAll(/#(\d+)/g)].map((m) => m[1]))];
  if (issues.length > 0 && issues.every((i) => changelogIssues.has(i))) {
    warnings.push({ title: s.title, reason: `段内 Issue ${issues.map((i) => '#' + i).join(', ')} 均已收录进 CHANGELOG` });
  }
}

if (jsonOut) {
  process.stdout.write(JSON.stringify({ sections: sections.length, failures, warnings }, null, 2) + '\n');
  process.exit(failures.length === 0 ? 0 : 1);
}

console.log('\n=== 未发布日志清理门禁 ===');
console.log(`   段数: ${sections.length}  已发布版本: ${[...releasedVersions].slice(0, 6).join(', ')}${releasedVersions.size > 6 ? ' …' : ''}`);

for (const w of warnings) {
  console.log(`   ⚠ 疑似已发布：${w.title} —— ${w.reason}`);
}

if (failures.length === 0) {
  console.log('   ✔ 无已发布残留条目');
  console.log('\n✅ 未发布日志干净');
  process.exit(0);
}

for (const f of failures) {
  console.log(`   ❌ ${f.title} —— ${f.reason}`);
}
console.log('\n❌ 存在已发布却未清理的条目，禁止推送/发版');
console.log('   请确认 CHANGELOG.md 已完整收录后移除或归档对应段落。');
process.exit(1);
