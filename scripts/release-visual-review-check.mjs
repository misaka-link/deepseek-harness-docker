#!/usr/bin/env node
/**
 * release-visual-review-check.mjs —— 发版前「浏览器视觉审核」证据门禁
 *
 * 背景：功能 E2E 全绿 ≠ 界面是对的。v0.2.14 的 Issue #19 就是典型：接口、digest、健康检查全部正常，
 * 只有管理面板顶部那行字是错的（「容器套件 v0.2.13 · 发现新版」），而这一行只有人打开浏览器看一眼才发现。
 * 因此把「构建镜像 → 真浏览器访问 → 截图存档 → 逐张审核」定为发版前强制流程，本脚本是它的机器门禁：
 * 没有截图证据 = 没做过视觉审核 = 不允许打 tag 发版。
 *
 * 证据目录：doc/release/v<版本>/ —— **只存本地**。
 * 审核截图属内部验证产物（内部材料不上传）：禁止 git add、禁止上传、禁止写进 Release Notes。
 * 因此本脚本只在本地执行（由 .githooks/pre-push 在推送 tag 时调用），不在 CI 运行。
 *
 * 用法:
 *   node scripts/release-visual-review-check.mjs                # 校验当前 PROJ_VER 的证据
 *   node scripts/release-visual-review-check.mjs --version 0.2.15
 *   RELEASE_EVIDENCE_DIR=/tmp/fake node scripts/release-visual-review-check.mjs   # 演练用
 * 退出码: 0 = 证据齐全；1 = 缺失或不合规
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// ── 版本号：以 build.sh#PROJ_VER 为准（发版时它先递增） ──────────────────
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

/** 发版前必须逐张审核的界面（缺一不可）。命名固定，便于跨版本比对与自动化审计。 */
const REQUIRED = [
  { file: '01-admin-overview.png', what: '管理后台总览（顶部「容器套件 / DSH 核心」双版本胶囊）' },
  { file: '02-admin-version-hub.png', what: '版本中心弹窗（本地运行版本 vs 远端最新发布）' },
  { file: '03-dsh-web.png', what: 'DSH Web GUI 主界面（登录后首屏）' },
  { file: '04-vnc-desktop.png', what: 'noVNC 桌面（含中文/Emoji 渲染）' },
  { file: '05-snapshot-list.png', what: '快照列表（环境版本列）' }
];

const MIN_BYTES = 15 * 1024;   // 空白/纯色/1x1 截图远小于此值，视为无效证据
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log('   ✔ ' + msg); }
  else { console.log('   ❌ ' + msg + (detail ? '  → ' + detail : '')); fail++; }
};

console.log('\n=== 发版前浏览器视觉审核证据（v' + version + '） ===');
console.log('   证据目录: ' + relDir);

if (!fs.existsSync(dir)) {
  console.log('\n❌ 证据目录不存在 —— 本版本尚未做过浏览器视觉审核，禁止发版。\n');
  printHowTo();
  process.exit(1);
}

for (const item of REQUIRED) {
  const p = path.join(dir, item.file);
  if (!fs.existsSync(p)) {
    ok(false, item.file + ' —— ' + item.what, '文件缺失');
    continue;
  }
  const stat = fs.statSync(p);
  const head = Buffer.alloc(4);
  const fd = fs.openSync(p, 'r');
  try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
  const isPng = head.equals(PNG_MAGIC);
  ok(stat.size >= MIN_BYTES && isPng,
    item.file + ' —— ' + item.what,
    !isPng ? '不是合法 PNG' : '体积仅 ' + stat.size + ' 字节，疑似空白截图（阈值 ' + MIN_BYTES + '）');
}

// 额外：不许只放截图不看——审核结论必须落在 CHANGELOG 对应版本的「验证」段里（可审计、可追溯）
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const sectionStart = changelog.indexOf('## [v' + version + ']');
const section = sectionStart >= 0 ? changelog.slice(sectionStart, changelog.indexOf('\n## [v', sectionStart + 5)) : '';
ok(section.length > 0, 'CHANGELOG.md 存在 v' + version + ' 小节', '缺失，无法记录审核结论');
ok(/视觉审核|截图审核/.test(section),
  'CHANGELOG 的 v' + version + ' 小节记录了视觉审核结论（含截图路径）',
  '未找到「视觉审核 / 截图审核」字样');

console.log('\n' + '─'.repeat(40));
if (fail === 0) {
  console.log('✅ 视觉审核证据齐全（' + REQUIRED.length + ' 张截图 + CHANGELOG 结论）');
  process.exit(0);
}
console.log('❌ 视觉审核证据不合规：' + fail + ' 项未通过 —— 发版已阻断');
printHowTo();
process.exit(1);

function printHowTo() {
  console.log('\n如何补齐（在全新构建的镜像 + 全新容器内执行）：');
  console.log('  1) 构建并重建容器：./build.sh --market && docker compose down -v && docker compose up -d');
  console.log('  2) 采集截图（仓库已有截图器，用真实 Chromium 访问，不是拼图）：');
  console.log('       AUTH_TOKEN=<口令> PROXY_PORT=3080 node scripts/remote-shot-admin.mjs tab-dsh      doc/release/v' + version + '/01-admin-overview.png');
  console.log('       AUTH_TOKEN=<口令> PROXY_PORT=3080 node scripts/remote-shot-admin.mjs tab-version   doc/release/v' + version + '/02-admin-version-hub.png');
  console.log('       AUTH_TOKEN=<口令> PROXY_PORT=3080 node scripts/remote-shot-dsh-ui.mjs <steps.json>  # 03/04/05 见 发版视觉审核流程');
  console.log('  3) 逐张打开审核（必须真的看），把结论写进 CHANGELOG 该版本的「🧪 验证」段；');
  console.log('  4) 重跑本脚本确认通过后，才允许打 tag 发版。');
}
