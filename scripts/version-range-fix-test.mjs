/**
 * 快速回归测试：gateway/version-service.js 复合区间求值 + 导出面改造。
 *
 * 覆盖：
 *   1. satisfiesRange 对 `>=0.1.2-rc.1 <=0.2.1-alpha.1` 的判定（0.2.1-alpha.1 IN；0.2.0-rc.2 IN；0.2.0-rc.1 IN；0.1.7-rc.2 IN；0.2.1 / 0.2.2 / 0.3.0 OUT）
 *   2. matchSemverPattern 复合 AND 区间修复（0.2.2 / 0.3.0 不再被误判为 true）
 *   3. 单 term 表达式与多空格切分、isSemver 对 pre-release 的支持
 *   4. 向后兼容：单例默认导出（getLiveMeta / evaluateTargetVersion / check 等仍可用）
 *   5. 新增能力：解构导出（{ satisfiesRange, compareSemver } 等）
 *   6. 集成：evaluateTargetVersion('0.3.0') 命中 danger 硬阻断
 *
 * 用法: node scripts/version-range-fix-test.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; }
};
const eq = (actual, expected, msg) => ok(actual === expected, `${msg} (期望 ${expected}，实际 ${actual})`);

const RANGE = '>=0.1.2-rc.1 <=0.2.1-alpha.1';

// ── 单例默认导出（向后兼容路径） ──────────────────────────────────────────
const versionService = require('../gateway/version-service');
// ── 解构具名导出（新增能力路径） ─────────────────────────────────────────
const { parseSemver, isSemver, compareSemver, matchSemverPattern, satisfiesRange } = versionService;

console.log('\n=== A. 单例默认导出向后兼容 ===');
ok(versionService && typeof versionService === 'object', 'require() 返回单例对象');
ok(typeof versionService.getLiveMeta === 'function', 'versionService.getLiveMeta() 可用');
ok(typeof versionService.getLocalProjectVersion === 'function', 'versionService.getLocalProjectVersion() 可用');
ok(typeof versionService.evaluateTargetVersion === 'function', 'versionService.evaluateTargetVersion() 可用');
ok(typeof versionService.isUsingRemoteMeta === 'function', 'versionService.isUsingRemoteMeta() 可用');
ok(typeof versionService.check === 'function', 'versionService.check() 可用');
const live = versionService.getLiveMeta();
ok(live && live.compatibility && live.compatibility.supportedDshRange === RANGE,
  `getLiveMeta() 正常返回，supportedDshRange = ${live?.compatibility?.supportedDshRange}`);

console.log('\n=== B. 解构具名导出 ===');
ok(typeof satisfiesRange === 'function', '解构 satisfiesRange 可用');
ok(typeof parseSemver === 'function', '解构 parseSemver 可用');
ok(typeof isSemver === 'function', '解构 isSemver 可用');
ok(typeof compareSemver === 'function', '解构 compareSemver 可用');
ok(typeof matchSemverPattern === 'function', '解构 matchSemverPattern 可用');
ok(satisfiesRange === versionService.satisfiesRange, '解构函数与单例属性是同一引用（无重复实现）');

console.log('\n=== C. satisfiesRange 复合区间判定（核心修复） ===');
eq(satisfiesRange('0.2.0-rc.1', RANGE), true,  '0.2.0-rc.1 IN');
eq(satisfiesRange('0.2.1-alpha.1', RANGE), true,  '0.2.1-alpha.1 IN（区间上界，闭区间）');
eq(satisfiesRange('0.2.0-rc.2', RANGE), true,  '0.2.0-rc.2 IN（上一版推荐，仍在区间内）');
eq(satisfiesRange('0.1.7-rc.2', RANGE), true,  '0.1.7-rc.2 IN');
eq(satisfiesRange('0.2.0',      RANGE), true,  '0.2.0 IN（<=0.2.1-alpha.1，上界抬升后纳入）');
eq(satisfiesRange('0.2.1',      RANGE), false, '0.2.1 OUT（正式版高于 0.2.1-alpha.1）');
eq(satisfiesRange('0.2.2',      RANGE), false, '0.2.2 OUT');
eq(satisfiesRange('0.3.0',      RANGE), false, '0.3.0 OUT');
// 边界补充
eq(satisfiesRange('0.1.2-rc.1', RANGE), true,  '0.1.2-rc.1 IN（闭区间下界）');
eq(satisfiesRange('0.1.2',      RANGE), true,  '0.1.2 IN（> 0.1.2-rc.1）');
eq(satisfiesRange('0.1.1',      RANGE), false, '0.1.1 OUT（低于下界）');
eq(satisfiesRange('0.1.7-rc.3', RANGE), true,  '0.1.7-rc.3 IN');
eq(satisfiesRange('0.1.8',      RANGE), true,  '0.1.8 IN');
eq(satisfiesRange('v0.2.0-rc.1', RANGE), true, '带 v 前缀 0.2.0-rc.1 IN');
// 非法输入与空值必须安全返回 false
eq(satisfiesRange('not-a-version', RANGE), false, '非法版本号 → false');
eq(satisfiesRange('0.2.0-rc.1', ''), false, '空区间 → false');
eq(satisfiesRange('', RANGE), false, '空版本 → false');

console.log('\n=== D. matchSemverPattern 复合 AND 修复 ===');
eq(matchSemverPattern('0.2.0', RANGE), true, 'matchSemverPattern(0.2.0, 复合区间) = true（上界抬升后纳入）');
eq(matchSemverPattern('0.2.1', RANGE), false, 'matchSemverPattern(0.2.1, 复合区间) 修复为 false');
eq(matchSemverPattern('0.2.2', RANGE), false, 'matchSemverPattern(0.2.2, 复合区间) 修复为 false');
eq(matchSemverPattern('0.3.0', RANGE), false, 'matchSemverPattern(0.3.0, 复合区间) 修复为 false');
eq(matchSemverPattern('0.2.0-rc.1', RANGE), true, 'matchSemverPattern(0.2.0-rc.1, 复合区间) = true');
eq(matchSemverPattern('0.1.7-rc.2', RANGE), true, 'matchSemverPattern(0.1.7-rc.2, 复合区间) = true');
// 单 term 语义不得回归
eq(matchSemverPattern('0.1.4', '<0.1.5-rc.1'), true,  '单 term <0.1.5-rc.1：0.1.4 命中');
eq(matchSemverPattern('0.1.5-rc.1', '<0.1.5-rc.1'), false, '单 term <0.1.5-rc.1：0.1.5-rc.1 不命中');
eq(matchSemverPattern('0.3.0', '>=0.3.0'), true,  '单 term >=0.3.0：0.3.0 命中');
eq(matchSemverPattern('0.2.0', '>=0.3.0'), false, '单 term >=0.3.0：0.2.0 不命中');
eq(matchSemverPattern('0.1.5-rc.2', '=0.1.5-rc.2'), true, '单 term = 精确匹配');
eq(matchSemverPattern('0.1.5-rc.2', '0.1.5-rc.2'), true, '裸版本号精确匹配');
// 多空格 / Tab 切分
eq(matchSemverPattern('0.2.2', '>=0.1.2-rc.1    <=0.2.1-alpha.1'), false, '多空格切分：0.2.2 OUT');
eq(satisfiesRange('0.2.2', '\t>=0.1.2-rc.1\t<=0.2.1-alpha.1\n'), false, 'Tab/换行切分：0.2.2 OUT');
eq(satisfiesRange('0.2.1-alpha.1', '  >=0.1.2-rc.1   <=0.2.1-alpha.1  '), true, '首尾空白容错：0.2.1-alpha.1 IN');

console.log('\n=== E. isSemver 对 pre-release 的支持 ===');
ok(isSemver('0.2.0-rc.1'), 'isSemver("0.2.0-rc.1") = true');
ok(isSemver('0.1.7-rc.2'), 'isSemver("0.1.7-rc.2") = true');
ok(isSemver('v0.2.0-rc.1'), 'isSemver("v0.2.0-rc.1") = true');
ok(isSemver('0.1.7-alpha.10'), 'isSemver("0.1.7-alpha.10") = true');
ok(!isSemver('0.2.0-'), 'isSemver("0.2.0-") = false（空 pre-release 拒绝）');
ok(!isSemver('0.2'), 'isSemver("0.2") = false');
ok(!isSemver('1.2.3+build'), 'isSemver 不支持 build metadata（已知边界，返回 false）');

console.log('\n=== F. 集成：evaluateTargetVersion 硬阻断 ===');
const danger = versionService.evaluateTargetVersion('0.3.0');
eq(danger.level, 'danger', '0.3.0 → danger 规则命中');
eq(danger.action, 'force-docker-pull', '0.3.0 → force-docker-pull');
const okRc1 = versionService.evaluateTargetVersion('0.2.0-rc.1');
eq(okRc1.level, 'success', '0.2.0-rc.1 → 官方深度适配 success');
const okRc17 = versionService.evaluateTargetVersion('0.1.7-rc.2');
eq(okRc17.level, 'success', '0.1.7-rc.2 → 官方深度适配 success');
const okRc2 = versionService.evaluateTargetVersion('0.2.0-rc.2');
eq(okRc2.level, 'success', '0.2.0-rc.2 → 官方深度适配 success');
const okA1 = versionService.evaluateTargetVersion('0.2.1-alpha.1');
eq(okA1.level, 'success', '0.2.1-alpha.1 → 官方深度适配 success');
eq(okA1.isAdapted, true, '0.2.1-alpha.1 → isAdapted=true');
const warnLow = versionService.evaluateTargetVersion('0.1.4');
eq(warnLow.level, 'warning', '0.1.4 → warning（降级格式风险）');

console.log(`\n[version-range-fix] pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
