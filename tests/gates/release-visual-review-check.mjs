#!/usr/bin/env node
/**
 * release-visual-review-check.mjs — Pre-release browser visual review evidence check.
 *
 * Verifies local visual review PNG evidence under doc/release/v<version>/ (not committed to git)
 * before pushing release tags.
 *
 * Usage:
 *   node tests/gates/release-visual-review-check.mjs
 *   node tests/gates/release-visual-review-check.mjs --version 1.0.0
 *   RELEASE_EVIDENCE_DIR=/tmp/evidence node tests/gates/release-visual-review-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const argv = process.argv.slice(2);
const vi = argv.indexOf('--version');
let version = vi >= 0 ? String(argv[vi + 1] || '').trim() : '';
if (!version) {
  const buildSh = fs.readFileSync(path.join(root, 'build.sh'), 'utf8');
  version = (buildSh.match(/^PROJ_VER="([^"]+)"/m) || [])[1] || '';
}
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error('[visual-review] 无法确定工程版本号（build.sh#PROJ_VER 缺失或非法）');
  process.exit(1);
}

const dir = process.env.RELEASE_EVIDENCE_DIR
  ? path.resolve(process.env.RELEASE_EVIDENCE_DIR)
  : path.join(root, 'doc', 'release', 'v' + version);
const relDir = path.relative(root, dir) || dir;

const REQUIRED = [
  { file: '01-admin-overview.png', what: '管理后台总览（套件 / DSH 核心双版本展示）' },
  { file: '02-admin-version-hub.png', what: '版本中心弹窗（本地运行版本 vs 远端最新发布）' },
  { file: '03-dsh-web.png', what: 'DSH Web GUI 主界面（登录后首屏）' },
  { file: '04-vnc-desktop.png', what: 'noVNC 桌面（中文与字体渲染）' },
  { file: '05-snapshot-list.png', what: '快照列表（环境版本列）' }
];

const MIN_BYTES = 15 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) {
    console.log('   ✔ ' + msg);
  } else {
    console.log('   ❌ ' + msg + (detail ? '  → ' + detail : ''));
    fail++;
  }
};

console.log('\n=== 发版前浏览器视觉审核证据（v' + version + '） ===');
console.log('   证据目录: ' + relDir);

if (!fs.existsSync(dir)) {
  console.log('\n❌ 证据目录不存在 —— 请先完成浏览器视觉审核并保存本地截图证据。\n');
  process.exit(1);
}

for (const item of REQUIRED) {
  const p = path.join(dir, item.file);
  if (!fs.existsSync(p)) {
    ok(false, `${item.file} —— ${item.what}`, '文件缺失');
    continue;
  }
  const stat = fs.statSync(p);
  const head = Buffer.alloc(4);
  const fd = fs.openSync(p, 'r');
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  const isPng = head.equals(PNG_MAGIC);
  ok(
    stat.size >= MIN_BYTES && isPng,
    `${item.file} —— ${item.what}`,
    !isPng ? '不是合法 PNG' : `体积仅 ${stat.size} 字节（阈值 ${MIN_BYTES}）`
  );
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const sectionStart = changelog.indexOf('## [v' + version + ']');
ok(sectionStart >= 0, `CHANGELOG.md 存在 v${version} 小节`, '缺失对应版本小节');

console.log('\n' + '─'.repeat(40));
if (fail === 0) {
  console.log(`✅ 视觉审核证据齐全（${REQUIRED.length} 张截图）`);
  process.exit(0);
}
console.log(`❌ 视觉审核证据不合规：${fail} 项未通过`);
process.exit(1);
