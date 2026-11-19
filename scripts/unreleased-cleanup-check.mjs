/**
 * unreleased-cleanup-check.mjs —— 未发布日志「发布后必须清理」门禁（未发布日志清理规则）。
 *
 * 背景：规则早就写了「发版后清理/归档 doc/UNRELEASED.md 中已发布条目」，但**没有任何机器校验**，
 * 实际结果是文件里长期堆着已发布内容：v0.2.14 发布后，Issue #17 条目、rc.2 适配条目、
 * 以及一整份「全部已勾选」的发布前核对清单都还留在文件里，越积越多，
 * 导致「未发布日志」名不副实，下个版本极易重复记录或漏记。
 *
 * 判定标准（强信号，命中即失败）：
 *   1) 段内出现「已发布 / 已合入 vX / 已随 vX」等字样；
 *   2) 段标题写着「基线 vX」，且该 vX 已出现在 CHANGELOG 的版本小节中；
 *   3) 段内含核对清单（- [x] / - [ ]），且**全部已勾选**；
 * 弱信号（只警告）：段内出现的所有 Issue 编号都已收录进 CHANGELOG。
 *
 * 逃生舱：确属「未发布但需要引用已发布内容」的段落，可在段内加 <!-- unreleased-ok --> 并说明原因。
 *
 * 用法: node scripts/unreleased-cleanup-check.mjs [--json]
 * 退出码: 0 = 干净（或文件不存在，CI 中正常跳过）；1 = 存在未清理的已发布条目
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argv = process.argv.slice(2);
const fileArgIdx = argv.indexOf('--file');
const UNRELEASED = fileArgIdx >= 0 && argv[fileArgIdx + 1]
  ? path.resolve(argv[fileArgIdx + 1])
  : path.join(root, 'doc', 'UNRELEASED.md');
const CHANGELOG = path.join(root, 'CHANGELOG.md');
const jsonOut = argv.includes('--json');

if (!fs.existsSync(UNRELEASED)) {
  // doc/ 不入库（仅图片可上传），因此 CI/干净 checkout 里本来就没有这个文件——正常跳过
  console.log('[unreleased] 未发现 doc/UNRELEASED.md（非本地开发环境），跳过');
  process.exit(0);
}

const unreleased = fs.readFileSync(UNRELEASED, 'utf8');
const changelog = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, 'utf8') : '';

/** CHANGELOG 中已发布的版本号集合（## [v0.2.14] …） */
const releasedVersions = new Set(
  [...changelog.matchAll(/^## \[v?([0-9][^\]]*)\]/gm)].map((m) => m[1].trim())
);
/** CHANGELOG 中出现过的 Issue 编号 */
const changelogIssues = new Set(
  [...changelog.matchAll(/#(\d+)/g)].map((m) => m[1])
);

/** 按 "## " 切段（首个 ## 之前是文件头，忽略） */
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
  if (body.includes('unreleased-ok')) continue; // 显式豁免

  // 1) 段内自述「已发布」
  const releasedMark = body.match(/已发布|已合入[\s`*]*v?\d|已随[\s`*]*v?\d/);
  if (releasedMark) {
    failures.push({ title: s.title, reason: `段内出现已发布标记「${releasedMark[0]}」` });
    continue;
  }

  // 2) 标题写「基线 vX」，且该版本已发布
  const baseline = s.title.match(/基线\s*v?(\d+\.\d+\.\d+)/);
  if (baseline && releasedVersions.has(baseline[1])) {
    failures.push({ title: s.title, reason: `标题基线 v${baseline[1]} 已发布，本段应归档` });
    continue;
  }

  // 3) 核对清单全部勾选
  const checked = (body.match(/^\s*- \[x\]/gim) || []).length;
  const unchecked = (body.match(/^\s*- \[ \]/gim) || []).length;
  if (checked > 0 && unchecked === 0) {
    failures.push({ title: s.title, reason: `核对清单 ${checked} 项全部已勾选（该版本已发版），本段应归档` });
    continue;
  }

  // 弱信号：全部 Issue 编号都已在 CHANGELOG 中出现
  const issues = [...new Set([...body.matchAll(/#(\d+)/g)].map((m) => m[1]))];
  if (issues.length > 0 && issues.every((i) => changelogIssues.has(i))) {
    warnings.push({ title: s.title, reason: `段内 Issue ${issues.map((i) => '#' + i).join(', ')} 均已收录进 CHANGELOG，疑似已发布` });
  }
}

if (jsonOut) {
  process.stdout.write(JSON.stringify({ sections: sections.length, failures, warnings }, null, 2) + '\n');
  process.exit(failures.length === 0 ? 0 : 1);
}

console.log('\n=== 未发布日志清理门禁（未发布日志清理规则） ===');
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
console.log('   处理方式（二选一）：');
console.log('     a) 确认 CHANGELOG.md 已完整收录后，直接删除该段；');
console.log('     b) 移入 doc/archive/unreleased-released-<日期>.md 归档。');
console.log('   见 未发布日志清理规则。');
process.exit(1);
