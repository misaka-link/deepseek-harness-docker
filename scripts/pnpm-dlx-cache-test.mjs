/**
 * pnpm dlx 缓存自愈回归测试（Issue #18 同款问题）。
 *
 * 覆盖：
 *   A. 缺清单 → 依据 pnpm-lock.yaml 补写（格式与 pnpm 自身一致：name=dlx / version=0.0.0）
 *   B. 无 lock → 回退扫描 node_modules（含 scoped 包）
 *   C. 闭包不完整（缺依赖 / 缺 .bin / 缺 .modules.yaml）→ 删目录而非补假清单
 *   D. 健康目录不改写；静默期内跳过；--dry-run 不落盘
 *   E. 原子写顺序（临时文件先写、rename 后可见）；空目录清理
 *
 * 用法: node scripts/pnpm-dlx-cache-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { healPnpmDlxCache, readDepsFromLock } = require(path.join(here, '../gateway/pnpm-dlx-cache.js'));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg + (detail ? '  → ' + detail : '')); fail++; }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-dlx-test-'));
const DLX = path.join(ROOT, 'dlx');
fs.mkdirSync(DLX, { recursive: true });

/** 造一个 build 目录：<dlx>/<hash>/<build> */
function makeBuild(hash, build, pkgs, opts = {}) {
  const dir = path.join(DLX, hash, build);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.noNodeModules) return dir;
  const nm = path.join(dir, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  if (opts.modulesYaml !== false) fs.writeFileSync(path.join(nm, '.modules.yaml'), '{}\n');
  for (const p of pkgs) {
    const pkgDir = path.join(nm, p.name);
    fs.mkdirSync(pkgDir, { recursive: true });
    const manifest = { name: p.name, version: p.version };
    if (p.bin) manifest.bin = { [p.name.split('/').pop()]: 'cli.js' };
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest));
    if (p.bin) {
      fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
      fs.writeFileSync(path.join(nm, '.bin', p.name.split('/').pop()), '#!/bin/sh\n');
    }
  }
  return dir;
}

function writeLock(dir, deps) {
  const lines = ['lockfileVersion: \'9.0\'', '', 'importers:', '', '  .:', '    dependencies:'];
  for (const [n, v] of Object.entries(deps)) {
    lines.push(`      ${n}:`, `        specifier: ${v}`, `        version: ${v}`);
  }
  lines.push('', 'packages:', '');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lines.join('\n'));
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

// ── A. 缺清单 → 依据 lock 补写 ──────────────────────────────────────
console.log('\n=== A. 依据 pnpm-lock.yaml 补写清单 ===');
const a1 = makeBuild('h1', 'b1', [{ name: 'semver', version: '7.6.0', bin: true }]);
writeLock(a1, { semver: '7.6.0' });
let res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
ok(res.repaired === 1, '缺清单的 dlx 目录被修复', JSON.stringify({ repaired: res.repaired, skipped: res.skipped }));
const m1 = readManifest(a1);
ok(m1 && m1.name === 'dlx' && m1.version === '0.0.0', '清单格式与 pnpm 自身一致（name=dlx / version=0.0.0）', JSON.stringify(m1));
ok(m1 && m1.dependencies && m1.dependencies.semver === '7.6.0', '依赖取自 lock 的 specifier', JSON.stringify(m1 && m1.dependencies));

// ── B. 无 lock → 回退扫描 node_modules ─────────────────────────────
console.log('\n=== B. 无 lock 时回退 node_modules 扫描 ===');
const b1 = makeBuild('h2', 'b2', [{ name: 'rea-agents', version: '6.7.0' }]);
healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
ok(Boolean(readManifest(b1) && readManifest(b1).dependencies['rea-agents']), '无 lock 时依据已装包补写清单');
const b2 = makeBuild('h3', 'b3', [{ name: '@scope/tool', version: '1.2.3', bin: true }]);
healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
ok(Boolean(readManifest(b2) && readManifest(b2).dependencies['@scope/tool']), 'scoped 包正确还原');

// ── C. 闭包不完整 → 删目录 ─────────────────────────────────────────
console.log('\n=== C. 闭包不完整：删目录而不是补假清单 ===');
const c1 = makeBuild('h4', 'b4', [{ name: 'root-pkg', version: '1.0.0' }]);
writeLock(c1, { 'root-pkg': '1.0.0' });
fs.writeFileSync(path.join(c1, 'pnpm-lock.yaml'), ['lockfileVersion: \'9.0\'', '', 'importers:', '', '  .:', '    dependencies:', '      root-pkg:', '        specifier: 1.0.0', '        version: 1.0.0', '      ghost-dep:', '        specifier: 2.0.0', '        version: 2.0.0', '', 'packages:', ''].join('\n'));
res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
ok(!fs.existsSync(c1), '缺直接依赖 → 目录被删除（让 pnpm 重装）', JSON.stringify(res.actions.find((a) => a.dir === c1)));

const c2 = makeBuild('h5', 'b5', [{ name: 'cli-tool', version: '1.0.0', bin: true }]);
fs.rmSync(path.join(c2, 'node_modules', '.bin'), { recursive: true, force: true });
res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
// 语义变更（子代理 P2-8）：.bin 缺失只告警，不删目录
ok(fs.existsSync(c2), '缺 .bin 链接 → 保留目录（不误杀 bin-links=false 的健康缓存）',
  JSON.stringify(res.actions.find((a) => a.dir === c2)));

// .modules.yaml 缺失不构成缺口：实测 pnpm 缺它也能正常运行，删目录只会白丢缓存
const c3 = makeBuild('h6', 'b6', [{ name: 'nm-only', version: '1.0.0' }], { modulesYaml: false });
res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
ok(fs.existsSync(c3) && Boolean(readManifest(c3)),
  '缺 node_modules/.modules.yaml 时仍补写清单（不白丢缓存）',
  JSON.stringify(res.actions.find((a) => a.dir === c3)));

// N2（运行时审计 P1）：被中断过的 hash 会累积多个 build，只有 pkg 指向的那个有效
const orphanHash = path.join(DLX, 'h-orphan');
const orphanGood = path.join(orphanHash, 'build-good');
const orphanBad = path.join(orphanHash, 'build-stale');
makeBuild('h-orphan', 'build-good', [{ name: 'good-pkg', version: '1.0.0' }]);
makeBuild('h-orphan', 'build-stale', [{ name: 'stale-pkg', version: '1.0.0' }]);
fs.writeFileSync(path.join(orphanGood, 'package.json'), JSON.stringify({ name: 'dlx', version: '0.0.0', dependencies: { 'good-pkg': '1.0.0' } }));
fs.writeFileSync(path.join(orphanBad, 'package.json'), JSON.stringify({ name: 'dlx', version: '0.0.0', dependencies: { 'stale-pkg': '1.0.0' } }));
fs.symlinkSync('build-good', path.join(orphanHash, 'pkg'));
res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
ok(!fs.existsSync(orphanBad), '未被 pkg 指向的孤儿 build 目录被回收', JSON.stringify(res.actions.find((a) => a.dir === orphanBad)));
ok(fs.existsSync(orphanGood), 'pkg 指向的有效 build 目录保留');

// ── D. 健康 / 静默期 / dry-run ────────────────────────────────────
console.log('\n=== D. 不越权与演练 ===');
const d1 = makeBuild('h7', 'b7', [{ name: 'ok-pkg', version: '1.0.0' }]);
fs.writeFileSync(path.join(d1, 'package.json'), JSON.stringify({ name: 'dlx', version: '0.0.0', dependencies: { 'ok-pkg': '1.0.0' } }));
const before = fs.readFileSync(path.join(d1, 'package.json'), 'utf8');
res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
ok(fs.readFileSync(path.join(d1, 'package.json'), 'utf8') === before, '健康目录的清单不被改写');
ok(res.healthy >= 1, '健康目录计入 healthy');

const d2 = makeBuild('h8', 'b8', [{ name: 'fresh', version: '2.0.0' }]);
res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 120000 });
ok(!readManifest(d2), '静默期未到时不修复（可能仍在安装）');

const d3 = makeBuild('h9', 'b9', [{ name: 'dry', version: '3.0.0' }]);
const old = new Date(Date.now() - 10 * 60 * 1000);
fs.utimesSync(path.join(d3, 'node_modules'), old, old);
fs.utimesSync(d3, old, old);
res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 120000, dryRun: true });
ok(res.repaired >= 1 && !readManifest(d3), '--dry-run 只报告不落盘');

// ── E. 原子写 + 空目录 ───────────────────────────────────────────
console.log('\n=== E. 原子写顺序与空目录清理 ===');
const e1 = makeBuild('h10', 'b10', [{ name: 'atomic', version: '1.0.0' }]);
const oldE = new Date(Date.now() - 10 * 60 * 1000);
fs.utimesSync(path.join(e1, 'node_modules'), oldE, oldE);
fs.utimesSync(e1, oldE, oldE);
let sawTmp = false, targetAbsent = false;
healPnpmDlxCache({
  cacheDir: ROOT,
  quietMs: 120000,
  _onTempWritten: (tmp, target) => {
    sawTmp = fs.existsSync(tmp);
    targetAbsent = !fs.existsSync(target);
    JSON.parse(fs.readFileSync(tmp, 'utf8'));
  }
});
ok(sawTmp && targetAbsent, '写入走临时文件 + rename（读者不会读到半截 JSON）');
ok(Boolean(readManifest(e1)), '静默期过后正常补写');

const e2 = path.join(DLX, 'h11', 'b11');
fs.mkdirSync(e2, { recursive: true });
const oldE2 = new Date(Date.now() - 10 * 60 * 1000);
fs.utimesSync(e2, oldE2, oldE2);
res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
ok(!fs.existsSync(e2), '空 build 目录被清理');

// ── F. lock 解析器 ───────────────────────────────────────────────
console.log('\n=== F. pnpm-lock 解析器 ===');
const parsed = readDepsFromLock(['lockfileVersion: \'9.0\'', '', 'importers:', '', '  .:', '    dependencies:', '      semver:', '        specifier: ^7.6.0', '        version: 7.6.0', '      @scope/x:', '        specifier: 1.0.0', '        version: 1.0.0', '', 'packages:', ''].join('\n'));
ok(parsed && parsed.semver === '^7.6.0' && parsed['@scope/x'] === '1.0.0', '解析 specifier（保留范围、支持 scoped）', JSON.stringify(parsed));
ok(readDepsFromLock('') === null, '空 lock 返回 null 以触发回退');

fs.rmSync(ROOT, { recursive: true, force: true });
console.log('\n────────────────────────────────────────');
console.log(fail === 0
  ? '✅ pnpm dlx 缓存自愈测试通过（' + pass + '/' + (pass + fail) + '）'
  : '❌ pnpm dlx 缓存自愈测试失败：' + fail + ' 项未通过 / 共 ' + (pass + fail) + ' 项');
process.exit(fail === 0 ? 0 : 1);
