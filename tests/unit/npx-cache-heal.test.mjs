#!/usr/bin/env node
/**
 * npx 缓存自愈回归测试。
 * 用法: node tests/unit/npx-cache-heal.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { healNpxCache, getNpxCacheStatus, listInstalledPackages } = require(path.join(root, 'gateway/src/maintenance/npx-cache.js'));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg + (detail ? '  → ' + detail : '')); fail++; }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'npx-heal-test-'));
const NPX = path.join(ROOT, '_npx');
fs.mkdirSync(NPX, { recursive: true });

function makeNodeModules(dir, pkgs, opts = {}) {
  const nm = path.join(dir, 'node_modules');
  for (const p of pkgs) {
    const pkgDir = path.join(nm, p.name);
    fs.mkdirSync(pkgDir, { recursive: true });
    const manifest = { name: p.name, version: p.version, main: './index.js' };
    if (p.bin) manifest.bin = typeof p.bin === 'object' ? p.bin : { [p.name.split('/').pop()]: 'cli.js' };
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest));
    if (p.noMainFile !== true) fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = 1;\n');
    if (p.bin) {
      const names = typeof manifest.bin === 'object' ? Object.keys(manifest.bin) : [p.name];
      fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
      for (const n of names) fs.writeFileSync(path.join(nm, '.bin', n), '#!/bin/sh\n');
    }
  }
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

const makeDir = (name) => { const d = path.join(NPX, name); fs.mkdirSync(d, { recursive: true }); return d; };
const readPkg = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } };
const writeLock = (dir, deps, nodes) => {
  const packages = { '': { dependencies: deps } };
  for (const [k, v] of Object.entries(nodes || {})) packages[k] = v;
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'npx-cache', lockfileVersion: 3, packages }));
};

const HROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'npx-heal-h-'));
try {
  console.log('\n=== A. 闭包完整：补写签名 ===');
  const a1 = makeDir('aaaaaaaaaaaaaaaa');
  makeNodeModules(a1, [{ name: 'semver', version: '7.6.0' }]);
  writeLock(a1, { semver: '^7.6.0' }, { 'node_modules/semver': { version: '7.6.0' } });
  let res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(res.repaired === 1, '缺签名的半成品目录被修复');
  const p1 = readPkg(a1);
  ok(p1?.dependencies?.semver === '^7.6.0', '优先依据 package-lock.json 还原原始范围');
  ok(Array.isArray(p1?._npx?.packages) && p1._npx.packages.includes('semver@7.6.0'), '写入 _npx.packages');

  const a2 = makeDir('bbbbbbbbbbbbbbbb');
  makeNodeModules(a2, [{ name: 'rea-agents', version: '6.7.0' }]);
  healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(readPkg(a2)?.dependencies?.['rea-agents'] === '6.7.0', '无 lock 时回退 node_modules 扫描');

  const a3 = makeDir('cccccccccccccccc');
  makeNodeModules(a3, [{ name: '@scope/tool', version: '1.2.3' }]);
  healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(readPkg(a3)?.dependencies?.['@scope/tool'] === '1.2.3', 'scoped 包正确还原');

  const a4 = makeDir('dddddddddddddddd');
  makeNodeModules(a4, [{ name: 'broken', version: '0.0.1' }]);
  fs.writeFileSync(path.join(a4, 'package.json'), '{ invalid');
  healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(Boolean(readPkg(a4)?.dependencies?.broken), '损坏的 package.json 被重建');

  console.log('\n=== B. 闭包不完整：删目录而非补假签名 ===');
  const b0 = makeDir('0000000000000001');
  makeNodeModules(b0, [{ name: 'root-pkg', version: '1.0.0' }]);
  writeLock(b0, { 'root-pkg': '^1.0.0' }, { 'node_modules/root-pkg': { version: '1.0.0' }, 'node_modules/missing-dep': { version: '2.0.0' } });
  healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(!fs.existsSync(b0), '缺失依赖闭包 → 删除目录');

  const b1 = makeDir('0000000000000002');
  makeNodeModules(b1, [{ name: 'cli-tool', version: '1.0.0', bin: true }]);
  fs.rmSync(path.join(b1, 'node_modules', '.bin'), { recursive: true, force: true });
  res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(fs.existsSync(b1) && Number(res.warnings) > 0, '缺 .bin 链接只告警不删目录');

  const b2 = makeDir('0000000000000003');
  makeNodeModules(b2, [{ name: 'main-pkg', version: '1.0.0' }]);
  writeLock(b2, { 'main-pkg': '^1.0.0' }, { 'node_modules/main-pkg': { version: '1.0.0' }, 'node_modules/fsevents': { version: '2.3.3', optional: true } });
  healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(fs.existsSync(b2) && Boolean(readPkg(b2)), 'optional 依赖缺失不算缺口');

  const b3 = makeDir('0000000000000004');
  makeNodeModules(b3, [{ name: 'truncated-pkg', version: '1.0.0' }], { hiddenLock: true });
  fs.unlinkSync(path.join(b3, 'node_modules/truncated-pkg/index.js'));
  healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(!fs.existsSync(b3), '入口文件缺失 → 删除目录');

  const b3b = makeDir('0000000000000005');
  makeNodeModules(b3b, [{ name: 'empty-pkg', version: '1.0.0' }], { hiddenLock: true });
  fs.writeFileSync(path.join(b3b, 'node_modules/empty-pkg/index.js'), '');
  healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(!fs.existsSync(b3b), '入口文件 0 字节 → 删除目录');

  console.log('\n=== C/D/E/F/G/H. 健康保护、静默期、原子写与状态缓存 ===');
  const c1 = makeDir('eeeeeeeeeeeeeeee');
  makeNodeModules(c1, [{ name: 'ok-pkg', version: '1.0.0' }]);
  fs.writeFileSync(path.join(c1, 'package.json'), JSON.stringify({ dependencies: { 'ok-pkg': '^1.0.0' }, _npx: { packages: ['ok-pkg@1.0.0'] } }));
  const before = fs.readFileSync(path.join(c1, 'package.json'), 'utf8');
  res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(fs.readFileSync(path.join(c1, 'package.json'), 'utf8') === before && res.healthy >= 1, '健康目录不被改写');

  const c2 = makeDir('ffffffffffffffff');
  makeNodeModules(c2, [{ name: 'downloading', version: '2.0.0' }]);
  fs.mkdirSync(path.join(c2, 'concurrency.lock'));
  res = healNpxCache({ cacheDir: ROOT, quietMs: 0 });
  ok(fs.existsSync(c2) && !readPkg(c2) && res.skipped >= 1, '持有活跃锁时跳过');

  const d1 = makeDir('1111111111111111');
  makeNodeModules(d1, [{ name: 'just-started', version: '3.0.0' }]);
  healNpxCache({ cacheDir: ROOT, quietMs: 120000 });
  ok(!readPkg(d1), '静默期内跳过');

  const d3 = makeDir('3333333333333333');
  makeNodeModules(d3, [{ name: 'dry-run-pkg', version: '4.0.0' }]);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(path.join(d3, 'node_modules'), old, old);
  fs.utimesSync(d3, old, old);
  res = healNpxCache({ cacheDir: ROOT, quietMs: 120000, dryRun: true });
  ok(res.repaired >= 1 && !readPkg(d3), '--dry-run 不落盘');
  healNpxCache({ cacheDir: ROOT, quietMs: 120000 });
  ok(Boolean(readPkg(d3)?.dependencies?.['dry-run-pkg']), '静默期后正常修复');

  const f2 = makeDir('8888888888888888');
  makeNodeModules(f2, [{ name: 'atomic-pkg', version: '1.0.0' }]);
  let sawTmp = false, targetAbsent = false;
  healNpxCache({
    cacheDir: ROOT, quietMs: 0,
    _onTempWritten: (tmp, target) => { sawTmp = fs.existsSync(tmp); targetAbsent = !fs.existsSync(target); }
  });
  ok(sawTmp && targetAbsent && !fs.readdirSync(f2).some((n) => n.endsWith('.tmp')), '原子写顺序正确无 .tmp 残留');

  const g1 = makeDir('9999999999999999');
  const nm = makeNodeModules(g1, [{ name: 'real', version: '1.0.0' }]);
  fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
  fs.mkdirSync(path.join(nm, 'no-manifest'), { recursive: true });
  const listed = listInstalledPackages(nm);
  ok(listed.length === 1 && listed[0].name === 'real', 'listInstalledPackages 跳过特殊条目');

  const HNPX = path.join(HROOT, '_npx');
  const h1 = path.join(HNPX, 'aaaaaaaaaaaaaaa1');
  fs.mkdirSync(h1, { recursive: true });
  makeNodeModules(h1, [{ name: 'cache-pkg', version: '1.0.0' }]);
  ok(getNpxCacheStatus({ cacheDir: HROOT }).broken === 1, '修复前 broken=1');
  healNpxCache({ cacheDir: HROOT, quietMs: 0 });
  const stAfter = getNpxCacheStatus({ cacheDir: HROOT });
  ok(stAfter.broken === 0 && stAfter.healthy === 1, '修复后状态缓存立即刷新');
} finally {
  fs.rmSync(HROOT, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
