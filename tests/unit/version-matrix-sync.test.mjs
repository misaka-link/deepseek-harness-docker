#!/usr/bin/env node
/**
 * DSH 版本适配矩阵单一事实源、SemVer 单实现与 gateway/src 内部 require 完整性检查。
 * 用法: node tests/unit/version-matrix-sync.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

function walkJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJs(full));
    else if (ent.name.endsWith('.js') || ent.name.endsWith('.cjs')) out.push(full);
  }
  return out;
}

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg + (detail ? '  → ' + detail : '')); fail++; }
};

const meta = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
const compat = meta.compatibilityV1 || {};
const recommended = compat.recommendedDsh;
const range = compat.supportedDshRange;
const adapted = compat.adaptedVersions || [];

console.log('\n=== A. version.json#compatibilityV1 一致性 ===');
ok(compat.schema === 1, 'compatibilityV1.schema === 1');
ok(compat.minDsh === '0.2.3-alpha.2', `minDsh === 0.2.3-alpha.2 (actual ${compat.minDsh})`);
ok(typeof recommended === 'string' && adapted.includes(recommended) && adapted[0] === recommended, `adaptedVersions 置顶 recommendedDsh (${recommended})`);
ok(meta?.supply?.dshVersion && adapted.includes(meta.supply.dshVersion), `supply.dshVersion (${meta?.supply?.dshVersion}) 在 adaptedVersions 中`);

const vsvc = require(path.join(root, 'gateway/src/dsh/version-service.js'));
const smvc = require(path.join(root, 'gateway/src/backup/snapshot-manifest.js'));
ok(vsvc.satisfiesRange(recommended, range), `recommendedDsh 落在 ${range} 内`);
ok(vsvc.satisfiesRange(meta.supply.dshVersion, range), 'supply.dshVersion 落在兼容区间内');
ok(adapted.every((v) => vsvc.satisfiesRange(v, range)), 'adaptedVersions 全部落在兼容区间内');

console.log('\n=== B. 无重复硬编码版本矩阵副本 & SemVer 单一实现 ===');
const gwFiles = [path.join(root, 'gateway/index.js'), ...walkJs(path.join(root, 'gateway/src'))];
const dupAdapted = gwFiles.filter((f) => /DEFAULT_ADAPTED_VERSIONS/.test(fs.readFileSync(f, 'utf8')));
ok(dupAdapted.length === 0, 'gateway/src 中已彻底移除重复的 DEFAULT_ADAPTED_VERSIONS 副本', dupAdapted.join(', '));

const SEMVER_PROBE = [
  ['0.2.3-alpha.10', '0.2.3-alpha.2'],
  ['0.2.3-alpha.9', '0.2.3-alpha.20'],
  ['0.2.3-alpha', '0.2.3-alpha.1'],
  ['0.2.3-rc.1', '0.2.3-alpha.2'],
  ['0.2.3', '0.2.3-alpha.99'],
  ['0.2.2-rc.5', '0.2.3-alpha.2']
];
const diverge = SEMVER_PROBE.filter(([a, b]) => Math.sign(vsvc.compareSemver(a, b)) !== Math.sign(smvc.compareSemver(a, b)));
ok(diverge.length === 0, 'version-service 与 snapshot-manifest 共用一致 SemVer 比较结果');
ok(Math.sign(vsvc.compareSemver('0.2.3-alpha.10', '0.2.3-alpha.2')) === 1, 'alpha.10 > alpha.2 数值序正确');

const dupSemver = gwFiles.filter((abs) => {
  if (abs.endsWith(path.join('gateway/src/core/semver.js'))) return false;
  const src = fs.readFileSync(abs, 'utf8');
  return /pre\.localeCompare\(/.test(src) || /function compareSemver\s*\(/.test(src);
});
ok(dupSemver.length === 0, '除 gateway/src/core/semver.js 外无第二份 compareSemver 实现', dupSemver.join(', '));

console.log('\n=== C. gateway 内部全部相对 require 可解析 ===');
const missingReq = [];
for (const abs of gwFiles) {
  const src = fs.readFileSync(abs, 'utf8');
  const dir = path.dirname(abs);
  for (const m of src.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    const resolvedBase = path.resolve(dir, spec);
    const exists = fs.existsSync(resolvedBase)
      || fs.existsSync(resolvedBase + '.js')
      || fs.existsSync(resolvedBase + '.cjs')
      || fs.existsSync(resolvedBase + '.json')
      || fs.existsSync(path.join(resolvedBase, 'index.js'));
    if (!exists) missingReq.push(`${path.relative(root, abs)} -> ${spec}`);
  }
}
ok(missingReq.length === 0, 'gateway/index.js 及 gateway/src/** 全部相对 require 可解析', missingReq.join(' | '));

console.log(`\n[version-matrix-sync] pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
