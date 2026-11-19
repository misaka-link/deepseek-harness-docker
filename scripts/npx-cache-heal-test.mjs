/**
 * npx 缓存自愈回归测试（Issue #18）。
 *
 * 覆盖「安装被打断 → 缓存缺 package.json 签名 → npx 永久 ENOENT」的修复路径，
 * 以及评审实测出的关键反例：**闭包不完整时补签名会制造「假已安装」**（永久 MODULE_NOT_FOUND）。
 *
 *   A. 闭包完整 → 补写签名（lock 优先 / 回退 node_modules 扫描 / scoped / 损坏签名）
 *   B. 闭包不完整 → 删除目录让 npx 重装（缺失依赖 / 缺 .bin）；optional 依赖缺失不算缺口
 *   C. 健康目录不改写；持有新鲜 concurrency.lock 的目录绝不插手
 *   D. 静默期（含空目录）与 --dry-run
 *   E. 空目录清理、无法修复时跳过
 *   F. 签名格式契约 + 原子写顺序（临时文件先写、rename 后可见）
 *   G. node_modules 扫描边界与状态体积口径
 *
 * 用法: node scripts/npx-cache-heal-test.mjs
 * 退出码: 0 = 全部通过；1 = 存在失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { healNpxCache, getNpxCacheStatus, listInstalledPackages } = require(path.join(here, '../gateway/npx-cache.js'));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg + (detail ? '  → ' + detail : '')); fail++; }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'npx-heal-test-'));
const NPX = path.join(ROOT, '_npx');
fs.mkdirSync(NPX, { recursive: true });

/** 造 node_modules：pkgs = [{name, version, bin?}]；bin 为 true 时同时建 .bin 链接文件 */
function makeNodeModules(dir, pkgs, opts = {}) {
  const nm = path.join(dir, 'node_modules');
  for (const p of pkgs) {
    const pkgDir = path.join(nm, p.name);
    fs.mkdirSync(pkgDir, { recursive: true });
    const manifest = { name: p.name, version: p.version, main: './index.js' };
    if (p.bin) manifest.bin = typeof p.bin === 'object' ? p.bin : { [p.name.split('/').pop()]: 'cli.js' };
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest));
    // 真实安装一定有入口文件；缺了就是「解包中断」的半成品（文件级完整性校验的判据）
    if (p.noMainFile !== true) fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = 1;\n');
    if (p.bin) {
      const names = typeof manifest.bin === 'object' ? Object.keys(manifest.bin) : [p.name];
      fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
      for (const n of names) fs.writeFileSync(path.join(nm, '.bin', n), '#!/bin/sh\n');
    }
  }
  // npm 在 reify 结束时写 node_modules/.package-lock.json；健康缓存必有，被 kill 的没有。
  if (opts.hiddenLock !== false) {
    const packages = { '': { dependencies: {} } };
    for (const p of pkgs) {
      packages['node_modules/' + p.name] = { version: p.version };
      packages[''].dependencies[p.name] = p.version;
    }
    fs.writeFileSync(path.join(nm, '.package-lock.json'), JSON.stringify({ name: 'npx-cache', lockfileVersion: 3, packages }));
  }
  return nm;
}

function makeDir(name) {
  const d = path.join(NPX, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

function writeLock(dir, deps, nodes) {
  const packages = { '': { dependencies: deps } };
  for (const [k, v] of Object.entries(nodes || {})) packages[k] = v;
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'npx-cache', lockfileVersion: 3, packages }));
}

// ── A. 闭包完整 → 补写签名 ───────────────────────────────────────────
console.log('\n=== A. 闭包完整：补写签名 ===');
const a1 = makeDir('aaaaaaaaaaaaaaaa');
makeNodeModules(a1, [{ name: 'semver', version: '7.6.0' }]);
writeLock(a1, { semver: '^7.6.0' }, { 'node_modules/semver': { version: '7.6.0' } });

let res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(res.repaired === 1, '缺签名的半成品目录被修复', JSON.stringify({ repaired: res.repaired, skipped: res.skipped }));
const p1 = readPkg(a1);
ok(p1 && p1.dependencies && p1.dependencies.semver === '^7.6.0',
  '优先依据 package-lock.json 还原「用户请求的原始范围」（^7.6.0 而非 7.6.0）', JSON.stringify(p1 && p1.dependencies));
ok(p1 && Array.isArray(p1._npx && p1._npx.packages) && p1._npx.packages.includes('semver@7.6.0'),
  '写入 _npx.packages（与 npx 自身维护的字段同构）', JSON.stringify(p1 && p1._npx));

const a2 = makeDir('bbbbbbbbbbbbbbbb');
makeNodeModules(a2, [{ name: 'rea-agents', version: '6.7.0' }]);
healNpxCache({ cacheDir: ROOT, quietMs: 0 });
const p2 = readPkg(a2);
ok(p2 && p2.dependencies && p2.dependencies['rea-agents'] === '6.7.0',
  '无 lock 时回退 node_modules 扫描并补写签名', JSON.stringify(p2 && p2.dependencies));

const a3 = makeDir('cccccccccccccccc');
makeNodeModules(a3, [{ name: '@scope/tool', version: '1.2.3' }]);
healNpxCache({ cacheDir: ROOT, quietMs: 0 });
const p3 = readPkg(a3);
ok(p3 && p3.dependencies && p3.dependencies['@scope/tool'] === '1.2.3',
  'scoped 包（@scope/name）正确还原', JSON.stringify(p3 && p3.dependencies));

const a4 = makeDir('dddddddddddddddd');
makeNodeModules(a4, [{ name: 'broken', version: '0.0.1' }]);
fs.writeFileSync(path.join(a4, 'package.json'), '{ this is not json');
healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(Boolean(readPkg(a4) && readPkg(a4).dependencies.broken), '损坏的 package.json 被重建');

// ── B. 闭包不完整 → 删目录（评审 P0 反例）──────────────────────────
console.log('\n=== B. 闭包不完整：删目录而不是补假签名（P0） ===');
const b0 = makeDir('0000000000000001');
makeNodeModules(b0, [{ name: 'root-pkg', version: '1.0.0' }]);
// lock 声明了传递依赖但磁盘上没有 → 闭包缺口
writeLock(b0, { 'root-pkg': '^1.0.0' }, {
  'node_modules/root-pkg': { version: '1.0.0' },
  'node_modules/missing-dep': { version: '2.0.0' }
});
res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(!fs.existsSync(b0), '依赖闭包不完整 → 整个目录被删除（让 npx 重装）', JSON.stringify(res.actions.find((a) => a.dir === b0)));
ok(!readPkg(b0), '绝不写入「假已安装」的签名');

const b1 = makeDir('0000000000000002');
makeNodeModules(b1, [{ name: 'cli-tool', version: '1.0.0', bin: true }]);
fs.rmSync(path.join(b1, 'node_modules', '.bin'), { recursive: true, force: true }); // reify 最后一步被中断
res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
// 语义变更（子代理 P2-8）：.bin 链接缺失只告警不删目录。
// 理由：用户 .npmrc 若设 bin-links=false，健康缓存会被每 60s 删一次，MCP 反而陷入反复重装；
// 缺链接的表现是「command not found」，响亮且可重装。
ok(fs.existsSync(b1), '缺 .bin 链接 → 保留目录（不误杀 bin-links=false 的健康缓存）',
  JSON.stringify(res.actions.find((a) => a.dir === b1)));
ok(Number(res.warnings) > 0, '缺 .bin 链接计入非致命告警', String(res.warnings));

const b2 = makeDir('0000000000000003');
makeNodeModules(b2, [{ name: 'main-pkg', version: '1.0.0' }]);
// fsevents 这类平台可选依赖在 Linux 上本就不会安装，不能据此判定缓存损坏
writeLock(b2, { 'main-pkg': '^1.0.0' }, {
  'node_modules/main-pkg': { version: '1.0.0' },
  'node_modules/fsevents': { version: '2.3.3', optional: true }
});
healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(fs.existsSync(b2) && Boolean(readPkg(b2)), 'optional 依赖缺失不算缺口（避免 Linux 上误删健康缓存）');

// A1（子代理对抗验证 P1）：**文件级**完整性才是判据 —— 包目录存在但入口文件缺失时，
// 只补签名会让 npx 永久 MODULE_NOT_FOUND（实测 cowsay 删 index.js 复现）。
const b3 = makeDir('0000000000000004');
makeNodeModules(b3, [{ name: 'truncated-pkg', version: '1.0.0' }], { hiddenLock: true });
fs.unlinkSync(path.join(b3, 'node_modules/truncated-pkg/index.js')); // 模拟解包中断：入口文件没落盘
res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(!fs.existsSync(b3), '包目录在但入口文件缺失（解包中断）→ 删除目录而非补签名',
  JSON.stringify(res.actions.find((a) => a.dir === b3)));

// 反例：入口文件存在但被清空（0 字节）同样视为损坏
const b3b = makeDir('0000000000000005');
makeNodeModules(b3b, [{ name: 'empty-pkg', version: '1.0.0' }], { hiddenLock: true });
fs.writeFileSync(path.join(b3b, 'node_modules/empty-pkg/index.js'), '');
res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(!fs.existsSync(b3b), '入口文件为 0 字节 → 删除目录',
  JSON.stringify(res.actions.find((a) => a.dir === b3b)));

// 回归：仅缺隐藏锁（文件齐全）不再删目录 —— 旧 npm 不写隐藏锁时不该反复重装
const b3c = makeDir('0000000000000006');
makeNodeModules(b3c, [{ name: 'nolock-pkg', version: '1.0.0' }], { hiddenLock: false });
res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(fs.existsSync(b3c), '仅缺隐藏锁、文件齐全 → 保留目录（不白丢缓存）',
  JSON.stringify(res.actions.find((a) => a.dir === b3c)));

// ── C. 不越权：健康目录与活跃安装 ──────────────────────────────────
console.log('\n=== C. 不越权：健康目录与活跃安装 ===');
const c1 = makeDir('eeeeeeeeeeeeeeee');
makeNodeModules(c1, [{ name: 'ok-pkg', version: '1.0.0' }]);
fs.writeFileSync(path.join(c1, 'package.json'), JSON.stringify({ dependencies: { 'ok-pkg': '^1.0.0' }, _npx: { packages: ['ok-pkg@1.0.0'] } }));
const before = fs.readFileSync(path.join(c1, 'package.json'), 'utf8');
res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(fs.readFileSync(path.join(c1, 'package.json'), 'utf8') === before, '健康目录的签名不被改写');
ok(res.healthy >= 1, '健康目录被计入 healthy', String(res.healthy));

const c2 = makeDir('ffffffffffffffff');
makeNodeModules(c2, [{ name: 'downloading', version: '2.0.0' }]);
fs.mkdirSync(path.join(c2, 'concurrency.lock'));
res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(fs.existsSync(c2) && !readPkg(c2), '持有新鲜 concurrency.lock 的目录绝不被写入或删除');
ok(res.skipped >= 1, '活跃锁目录被计入 skipped', String(res.skipped));

// ── D. 静默期与 dry-run ─────────────────────────────────────────────
console.log('\n=== D. 静默期判定与演练模式 ===');
const d1 = makeDir('1111111111111111');
makeNodeModules(d1, [{ name: 'just-started', version: '3.0.0' }]);
res = healNpxCache({ cacheDir: ROOT, quietMs: 120000 });
ok(!readPkg(d1), 'node_modules 刚被写入（静默期未到）时不修复，避免打断进行中的安装');

const d2 = makeDir('2222222222222222'); // 刚 mkdir、还没取锁的空目录
res = healNpxCache({ cacheDir: ROOT, quietMs: 120000 });
ok(fs.existsSync(d2), '静默期内的空目录不被删除（npx 会先 mkdir 再取锁）');

const d3 = makeDir('3333333333333333');
makeNodeModules(d3, [{ name: 'dry-run-pkg', version: '4.0.0' }]);
const old = new Date(Date.now() - 10 * 60 * 1000);
fs.utimesSync(path.join(d3, 'node_modules'), old, old);
fs.utimesSync(d3, old, old); // 目录 mtime 同样老化：两者取 max 作为「最近活动」
res = healNpxCache({ cacheDir: ROOT, quietMs: 120000, dryRun: true });
ok(res.repaired >= 1 && !readPkg(d3), '--dry-run 只报告不落盘', JSON.stringify({ repaired: res.repaired, wrote: Boolean(readPkg(d3)) }));
healNpxCache({ cacheDir: ROOT, quietMs: 120000 });
ok(Boolean(readPkg(d3) && readPkg(d3).dependencies['dry-run-pkg']), '静默期已过后正常修复');

// ── E. 清理与跳过 ───────────────────────────────────────────────────
console.log('\n=== E. 空目录清理与无法修复的情况 ===');
const e1 = makeDir('4444444444444444'); // 完全空、已静默
const e2 = makeDir('5555555555555555'); // 只有文件、没有 node_modules
fs.writeFileSync(path.join(e2, 'stray.txt'), 'x');
const e3 = makeDir('6666666666666666'); // node_modules 里没有可识别的包
fs.mkdirSync(path.join(e3, 'node_modules'), { recursive: true });
const old2 = new Date(Date.now() - 10 * 60 * 1000);
fs.utimesSync(e1, old2, old2);
fs.utimesSync(path.join(e3, 'node_modules'), old2, old2);
res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
ok(fs.existsSync(e1), '空目录保持原样（npm 的 mkdir→取锁 窗口可能很长，删除风险大于收益）');
ok(fs.existsSync(e2), '无 node_modules 的非空目录保持原样，不误删用户数据');
ok(!readPkg(e3), 'node_modules 中无有效包时不写空签名');

// ── F. 签名格式与原子写 ────────────────────────────────────────────
console.log('\n=== F. 签名格式契约与原子写顺序 ===');
const f1 = makeDir('7777777777777777');
makeNodeModules(f1, [{ name: 'shape-check', version: '9.9.9' }]);
healNpxCache({ cacheDir: ROOT, quietMs: 0 });
const pf = readPkg(f1);
ok(typeof pf.dependencies === 'object' && Object.keys(pf.dependencies).length > 0, 'dependencies 为非空对象');
ok(pf._npx && Array.isArray(pf._npx.packages), '_npx.packages 为数组（npx 会读回该字段）');
ok(Object.values(pf.dependencies).every((v) => typeof v === 'string' && v.length > 0), 'dependencies 值均为非空字符串');

// 原子性：临时文件写好后、rename 之前，目标文件必须还不存在（否则读者可能读到半截）
const f2 = makeDir('8888888888888888');
makeNodeModules(f2, [{ name: 'atomic-pkg', version: '1.0.0' }]);
let sawTmp = false;
let targetAbsentDuringWrite = false;
healNpxCache({
  cacheDir: ROOT,
  quietMs: 0,
  _onTempWritten: (tmp, target) => {
    sawTmp = fs.existsSync(tmp);
    targetAbsentDuringWrite = !fs.existsSync(target);
    JSON.parse(fs.readFileSync(tmp, 'utf8')); // 临时文件此刻已是完整 JSON
  }
});
ok(sawTmp, '写入过程确实经过临时文件（原子替换的前置条件）');
ok(targetAbsentDuringWrite, 'rename 之前目标 package.json 尚未出现（读者不会读到半截 JSON）');
ok(!fs.readdirSync(f2).some((n) => n.endsWith('.tmp')), '完成后无 .tmp 残留');

// ── G. 扫描边界与状态口径 ──────────────────────────────────────────
console.log('\n=== G. 扫描边界与状态体积口径 ===');
const g1 = makeDir('9999999999999999');
const nm = makeNodeModules(g1, [{ name: 'real', version: '1.0.0' }]);
fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}');
fs.mkdirSync(path.join(nm, 'no-manifest'), { recursive: true });
const listed = listInstalledPackages(nm);
ok(listed.length === 1 && listed[0].name === 'real', '跳过 .bin / .package-lock.json / 无 manifest 的目录', JSON.stringify(listed));

const status = getNpxCacheStatus({ cacheDir: ROOT });
ok(status.sizeBytes > 0, '状态返回 _npx 体积', String(status.sizeBytes));
fs.mkdirSync(path.join(ROOT, '_cacache'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '_cacache', 'big.bin'), Buffer.alloc(64 * 1024));
const status2 = getNpxCacheStatus({ cacheDir: ROOT });
ok(status2.sizeBytes === status.sizeBytes, '体积口径只统计 _npx，不含 _cacache',
  status.sizeBytes + ' vs ' + status2.sizeBytes);

// ── H. 状态缓存失效 / 隐藏锁兜底 / 计数口径（评审 P2-1、P2-2、P2-4）──
console.log('\n=== H. 状态缓存与计数口径 ===');
const HROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'npx-heal-h-'));
const HNPX = path.join(HROOT, '_npx');
fs.mkdirSync(HNPX, { recursive: true });

// H1：修好之后状态必须立刻变绿（缓存要失效）
const h1 = path.join(HNPX, 'aaaaaaaaaaaaaaa1');
fs.mkdirSync(h1, { recursive: true });
makeNodeModules(h1, [{ name: 'cache-pkg', version: '1.0.0' }]);
const stBefore = getNpxCacheStatus({ cacheDir: HROOT });
ok(stBefore.broken === 1, '修复前状态显示 1 个待修复', JSON.stringify({ broken: stBefore.broken }));
healNpxCache({ cacheDir: HROOT, quietMs: 0 });
const stAfter = getNpxCacheStatus({ cacheDir: HROOT });
ok(stAfter.broken === 0 && stAfter.healthy === 1,
  '修复后状态缓存已失效，立即反映为健康（不出现「刚修好却显示 broken」）',
  JSON.stringify({ broken: stAfter.broken, healthy: stAfter.healthy }));

// H2：根 lock 丢失时，用 node_modules/.package-lock.json 兜底做闭包校验
const h2 = path.join(HNPX, 'aaaaaaaaaaaaaaa2');
fs.mkdirSync(h2, { recursive: true });
makeNodeModules(h2, [{ name: 'root-pkg', version: '1.0.0' }]);
fs.writeFileSync(path.join(h2, 'node_modules', '.package-lock.json'), JSON.stringify({
  name: 'npx-cache',
  lockfileVersion: 3,
  packages: {
    'node_modules/root-pkg': { version: '1.0.0' },
    'node_modules/ghost-dep': { version: '2.0.0' }
  }
}));
res = healNpxCache({ cacheDir: HROOT, quietMs: 0 });
ok(!fs.existsSync(h2), '无根 lock 时依据隐藏锁识别出缺失依赖并删除目录', JSON.stringify(res.actions.find((a) => a.dir === h2)));

// H3：incomplete 与 emptyRemoved 分开计数
const h3 = path.join(HNPX, 'aaaaaaaaaaaaaaa3'); // 空目录
fs.mkdirSync(h3, { recursive: true });
const oldH = new Date(Date.now() - 10 * 60 * 1000);
fs.utimesSync(h3, oldH, oldH);
const h4 = path.join(HNPX, 'aaaaaaaaaaaaaaa4'); // 闭包不完整
fs.mkdirSync(h4, { recursive: true });
makeNodeModules(h4, [{ name: 'only-root', version: '1.0.0' }]);
fs.writeFileSync(path.join(h4, 'node_modules', '.package-lock.json'), JSON.stringify({
  packages: { 'node_modules/only-root': { version: '1.0.0' }, 'node_modules/absent': { version: '9.9.9' } }
}));
const stCount = getNpxCacheStatus({ cacheDir: HROOT });
ok(stCount.incomplete === 1 && stCount.emptyRemoved === 0,
  'incomplete 只统计闭包不完整；空目录不再被删除（emptyRemoved 恒为 0）',
  JSON.stringify({ incomplete: stCount.incomplete, emptyRemoved: stCount.emptyRemoved }));

fs.rmSync(HROOT, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });
console.log('\n────────────────────────────────────────');
console.log(fail === 0
  ? '✅ npx 缓存自愈测试通过（' + pass + '/' + (pass + fail) + '）'
  : '❌ npx 缓存自愈测试失败：' + fail + ' 项未通过 / 共 ' + (pass + fail) + ' 项');
process.exit(fail === 0 ? 0 : 1);
