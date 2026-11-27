#!/usr/bin/env node
/**
 * pnpm dlx 缓存自愈回归测试。
 * 用法: node tests/unit/pnpm-dlx-cache.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { healPnpmDlxCache, readDepsFromLock } = require(path.join(root, 'gateway/src/maintenance/pnpm-dlx-cache.js'));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg + (detail ? '  → ' + detail : '')); fail++; }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-dlx-test-'));
const DLX = path.join(ROOT, 'dlx');
fs.mkdirSync(DLX, { recursive: true });

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
  const lines = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:'];
  for (const [n, v] of Object.entries(deps)) {
    lines.push(`      ${n}:`, `        specifier: ${v}`, `        version: ${v}`);
  }
  lines.push('', 'packages:', '');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lines.join('\n'));
}

const readManifest = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } };

try {
  const a1 = makeBuild('h1', 'b1', [{ name: 'semver', version: '7.6.0', bin: true }]);
  writeLock(a1, { semver: '7.6.0' });
  let res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
  const m1 = readManifest(a1);
  ok(res.repaired === 1 && m1?.name === 'dlx' && m1?.version === '0.0.0' && m1?.dependencies?.semver === '7.6.0', 'A. 依据 pnpm-lock.yaml 补写清单');

  const b1 = makeBuild('h2', 'b2', [{ name: 'rea-agents', version: '6.7.0' }]);
  const b2 = makeBuild('h3', 'b3', [{ name: '@scope/tool', version: '1.2.3', bin: true }]);
  healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(Boolean(readManifest(b1)?.dependencies?.['rea-agents']) && Boolean(readManifest(b2)?.dependencies?.['@scope/tool']), 'B. 无 lock 回退扫描 node_modules（含 scoped 包）');

  const c1 = makeBuild('h4', 'b4', [{ name: 'root-pkg', version: '1.0.0' }]);
  writeLock(c1, { 'root-pkg': '1.0.0', 'ghost-dep': '2.0.0' });
  healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(!fs.existsSync(c1), 'C1. 缺直接依赖删除目录');

  const c2 = makeBuild('h5', 'b5', [{ name: 'cli-tool', version: '1.0.0', bin: true }]);
  fs.rmSync(path.join(c2, 'node_modules', '.bin'), { recursive: true, force: true });
  healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(fs.existsSync(c2), 'C2. 缺 .bin 链接保留目录');

  const c3 = makeBuild('h6', 'b6', [{ name: 'nm-only', version: '1.0.0' }], { modulesYaml: false });
  healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(fs.existsSync(c3) && Boolean(readManifest(c3)), 'C3. 缺 .modules.yaml 仍补写清单');

  const orphanHash = path.join(DLX, 'h-orphan');
  const orphanGood = makeBuild('h-orphan', 'build-good', [{ name: 'good-pkg', version: '1.0.0' }]);
  const orphanBad = makeBuild('h-orphan', 'build-stale', [{ name: 'stale-pkg', version: '1.0.0' }]);
  fs.writeFileSync(path.join(orphanGood, 'package.json'), JSON.stringify({ name: 'dlx', version: '0.0.0', dependencies: { 'good-pkg': '1.0.0' } }));
  fs.writeFileSync(path.join(orphanBad, 'package.json'), JSON.stringify({ name: 'dlx', version: '0.0.0', dependencies: { 'stale-pkg': '1.0.0' } }));
  fs.symlinkSync('build-good', path.join(orphanHash, 'pkg'));
  healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(!fs.existsSync(orphanBad) && fs.existsSync(orphanGood), 'C4. 孤儿 build 回收，有效 build 保留');

  const d1 = makeBuild('h7', 'b7', [{ name: 'ok-pkg', version: '1.0.0' }]);
  fs.writeFileSync(path.join(d1, 'package.json'), JSON.stringify({ name: 'dlx', version: '0.0.0', dependencies: { 'ok-pkg': '1.0.0' } }));
  const before = fs.readFileSync(path.join(d1, 'package.json'), 'utf8');
  res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(fs.readFileSync(path.join(d1, 'package.json'), 'utf8') === before && res.healthy >= 1, 'D1. 健康目录不改写');

  const d2 = makeBuild('h8', 'b8', [{ name: 'fresh', version: '2.0.0' }]);
  healPnpmDlxCache({ cacheDir: ROOT, quietMs: 120000 });
  ok(!readManifest(d2), 'D2. 静默期内跳过');

  const d3 = makeBuild('h9', 'b9', [{ name: 'dry', version: '3.0.0' }]);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(path.join(d3, 'node_modules'), old, old);
  fs.utimesSync(d3, old, old);
  res = healPnpmDlxCache({ cacheDir: ROOT, quietMs: 120000, dryRun: true });
  ok(res.repaired >= 1 && !readManifest(d3), 'D3. --dry-run 不落盘');

  const e1 = makeBuild('h10', 'b10', [{ name: 'atomic', version: '1.0.0' }]);
  fs.utimesSync(path.join(e1, 'node_modules'), old, old);
  fs.utimesSync(e1, old, old);
  let sawTmp = false, targetAbsent = false;
  healPnpmDlxCache({
    cacheDir: ROOT, quietMs: 120000,
    _onTempWritten: (tmp, target) => { sawTmp = fs.existsSync(tmp); targetAbsent = !fs.existsSync(target); }
  });
  ok(sawTmp && targetAbsent && Boolean(readManifest(e1)), 'E1. 原子写顺序正确');

  const e2 = path.join(DLX, 'h11', 'b11');
  fs.mkdirSync(e2, { recursive: true });
  fs.utimesSync(e2, old, old);
  healPnpmDlxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(!fs.existsSync(e2), 'E2. 空 build 目录被清理');

  const parsed = readDepsFromLock(["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', '      semver:', '        specifier: ^7.6.0', '        version: 7.6.0', '      @scope/x:', '        specifier: 1.0.0', '        version: 1.0.0', '', 'packages:', ''].join('\n'));
  ok(parsed?.semver === '^7.6.0' && parsed?.['@scope/x'] === '1.0.0' && readDepsFromLock('') === null, 'F. pnpm-lock 解析器正确');
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
