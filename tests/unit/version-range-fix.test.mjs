#!/usr/bin/env node
/**
 * version-service.js 复合区间求值、具名导出与 v1.0.0 引擎下限硬阻断单测。
 * 用法: node tests/unit/version-range-fix.test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('   ✔ ' + msg); pass++; } else { console.log('   ❌ ' + msg); fail++; } };
const eq = (actual, expected, msg) => ok(actual === expected, `${msg} (期望 ${expected}，实际 ${actual})`);

const metaJson = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
const RANGE = metaJson.compatibilityV1.supportedDshRange;
const versionService = require(path.join(root, 'gateway/src/dsh/version-service.js'));
const { parseSemver, isSemver, compareSemver, matchSemverPattern, satisfiesRange } = versionService;

console.log('\n=== A. 单例与具名导出 ===');
ok(typeof versionService.getLiveMeta === 'function' && typeof versionService.evaluateTargetVersion === 'function' && typeof versionService.check === 'function', '单例方法齐全');
ok(typeof parseSemver === 'function' && typeof isSemver === 'function' && typeof compareSemver === 'function' && satisfiesRange === versionService.satisfiesRange, '具名导出与单例一致');

console.log('\n=== B. satisfiesRange / matchSemverPattern 复合 AND 区间 ===');
eq(satisfiesRange('0.2.3-alpha.2', RANGE), true, '0.2.3-alpha.2 IN');
eq(satisfiesRange('v0.2.3-alpha.2', RANGE), true, 'v0.2.3-alpha.2 IN');
eq(satisfiesRange('0.2.3-alpha.1', RANGE), false, '0.2.3-alpha.1 OUT（低于下限）');
eq(satisfiesRange('0.2.2-rc.5', RANGE), false, '0.2.2-rc.5 OUT（低于下限）');
eq(satisfiesRange('0.2.3-alpha.3', RANGE), false, '0.2.3-alpha.3 OUT（高于当前上界）');
eq(satisfiesRange('0.3.0', RANGE), false, '0.3.0 OUT');
eq(satisfiesRange('not-a-version', RANGE), false, '非法版本号 -> false');
eq(satisfiesRange('', RANGE), false, '空版本 -> false');

eq(matchSemverPattern('0.1.4', '<0.1.5-rc.1'), true, '单 term <0.1.5-rc.1');
eq(matchSemverPattern('0.1.5-rc.1', '<0.1.5-rc.1'), false, '边界不命中 <');
eq(matchSemverPattern('0.3.0', '>=0.3.0'), true, '单 term >=0.3.0');
eq(matchSemverPattern('0.2.2', '>=0.1.2-rc.1    <=0.2.1-rc.2'), false, '多空格复合 AND');
eq(satisfiesRange('0.2.1-rc.2', '  >=0.1.2-rc.1   <=0.2.1-rc.2  '), true, '首尾空白容错');

console.log('\n=== C. isSemver 边界 ===');
ok(isSemver('0.2.3-alpha.2') && isSemver('v0.2.3-alpha.2') && isSemver('0.1.7-alpha.10'), '合法 SemVer 通过');
ok(!isSemver('0.2.0-') && !isSemver('0.2') && !isSemver('1.2.3+build'), '非法/带 build metadata 拒绝');

console.log('\n=== D. v1.0.0 evaluateTargetVersion 决策 ===');
const rFloor = versionService.evaluateTargetVersion('0.2.3-alpha.2');
eq(rFloor.level, 'success', '0.2.3-alpha.2 -> success');
eq(rFloor.isAdapted, true, '0.2.3-alpha.2 -> isAdapted=true');

const rUnadapted = versionService.evaluateTargetVersion('0.2.4');
eq(rUnadapted.level, 'warning', '0.2.4 -> warning (unadapted)');
eq(rUnadapted.kind, 'unadapted', '0.2.4 -> kind=unadapted');

for (const oldVer of ['0.2.3-alpha.1', '0.2.2-rc.5', '0.2.1-rc.2', '0.1.7-rc.2', '0.1.4']) {
  const rOld = versionService.evaluateTargetVersion(oldVer);
  eq(rOld.level, 'danger', `${oldVer} -> danger (低于 ENGINE_FLOOR)`);
  eq(rOld.kind, 'engine-unsupported', `${oldVer} -> kind=engine-unsupported`);
}

const rBreak = versionService.evaluateTargetVersion('0.3.0');
eq(rBreak.level, 'danger', '0.3.0 -> danger');
eq(rBreak.action, 'force-docker-pull', '0.3.0 -> force-docker-pull');

console.log(`\n[version-range-fix] pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
