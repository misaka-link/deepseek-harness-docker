/**
 * 回归测试：DSH 版本适配矩阵的「单一数据源」一致性。
 *
 * 背景：adaptedVersions 曾在 version.json / version-service.js / dsh-manager.js 三处各写一份，
 * 升级到 0.1.7-alpha.1/alpha.2 时漏改 dsh-manager.js，导致管理后台把当前运行版本误判为
 * 「未经特殊适配」；同时 admin.html 里 `hubCompatRecommended` 只被 getElementById 引用、
 * 却没有对应 id，导致「推荐核心」永远停在硬编码旧值。
 *
 * 用法: node scripts/version-matrix-sync-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; }
};

const meta = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
const recommended = meta?.compatibility?.recommendedDsh;
const adapted = meta?.compatibility?.adaptedVersions || [];
const dshSrc = fs.readFileSync(path.join(root, 'gateway/dsh-manager.js'), 'utf8');
const vsSrc = fs.readFileSync(path.join(root, 'gateway/version-service.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(root, 'gateway/public/admin.html'), 'utf8');

const uniq = (a) => [...new Set(a)];

console.log('\n=== A. version.json 自身一致性 ===');
ok(typeof recommended === 'string' && recommended.length > 0, `recommendedDsh 已定义 (${recommended})`);
ok(adapted.includes(recommended), `adaptedVersions 包含 recommendedDsh (${recommended})`);
ok(adapted.includes('0.1.7-rc.1') && adapted.includes('0.1.7-alpha.2') && adapted.includes('0.1.7-alpha.1'), 'adaptedVersions 包含 0.1.7-rc.1 / 0.1.7-alpha.2 / 0.1.7-alpha.1');
ok(meta?.supply?.dshVersion && adapted.includes(meta.supply.dshVersion), `supply.dshVersion 在已适配列表内 (${meta?.supply?.dshVersion})`);

console.log('\n=== B. dsh-manager.js 兜底清单必须与 version.json 同步 ===');
const dmBlock = dshSrc.match(/const DEFAULT_ADAPTED_VERSIONS = \[([\s\S]*?)\];/);
ok(Boolean(dmBlock), '找到 DEFAULT_ADAPTED_VERSIONS 定义');
const dmList = dmBlock ? uniq([...dmBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
for (const v of adapted) ok(dmList.includes(v), `dsh-manager 兜底包含 ${v}`);
ok(dmList.includes(recommended), `dsh-manager 兜底包含 recommendedDsh (${recommended})`);

console.log('\n=== C. version-service.js 兜底清单必须包含 recommendedDsh ===');
const vsBlock = vsSrc.match(/adaptedVersions:\s*\[([\s\S]*?)\]/);
const vsList = vsBlock ? uniq([...vsBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
ok(vsList.includes(recommended), `version-service 兜底包含 recommendedDsh (${recommended})`);
ok(!vsList.length || vsList.every(v => adapted.includes(v)), 'version-service 兜底无多余版本');

console.log('\n=== D. admin.html 前端兜底 / 静态默认值 ===');
const fbLists = [
  ...[...adminSrc.matchAll(/const adaptedList = compat\.adaptedVersions \|\| \[([^\]]*)\]/g)].map(m => m[1]),
  ...[...adminSrc.matchAll(/availableAdaptedVersions = data\.adaptedVersions \|\| \[([^\]]*)\]/g)].map(m => m[1]),
];
ok(fbLists.length >= 3, `找到 ${fbLists.length} 处 adaptedVersions 兜底数组 (期望 ≥3)`);
for (const [i, raw] of fbLists.entries()) {
  const list = uniq([...raw.matchAll(/'([^']+)'/g)].map(m => m[1]));
  ok(list.includes(recommended), `admin.html 兜底#${i + 1} 包含 recommendedDsh`);
}
for (const re of [/recommendedDsh \|\| '([^']+)'/, /supportedDshRange \|\| '([^']+)'/]) {
  const all = [...adminSrc.matchAll(new RegExp(re.source, 'g'))].map(m => m[1]);
  ok(all.length > 0 && all.every(v => !v.includes('0.1.6-alpha.2')), `前端兜底不含旧值 0.1.6-alpha.2 (命中 ${all.length} 处)`);
}
const recPattern = new RegExp(`compat\\.recommendedDsh \\|\\| '(?!${recommended.replace(/\\./g, '\\.')})`);
ok(!recPattern.test(adminSrc), `recommendedDsh 兜底为 ${recommended}`);
const chipCount = (adminSrc.match(new RegExp(`>${recommended.replace(/\./g, '\\.')}</span>`, 'g')) || []).length;
ok(chipCount >= 2, `静态适配 chips 含 ${recommended} (${chipCount} 处)`);
// 回归：升级推荐核心时必须「置顶新增」而不是「替换掉」上一版推荐，
// 否则冷启动静态页面（API 返回前）会漏展示上一版已深度适配的核心。
const prevRecommended = '0.1.7-rc.1';
const prevChipCount = (adminSrc.match(new RegExp(`>${prevRecommended.replace(/\./g, '\\.')}</span>`, 'g')) || []).length;
ok(prevChipCount >= 2, `静态适配 chips 保留上一推荐版本 ${prevRecommended} (${prevChipCount} 处)`);

console.log('\n=== E. admin.html 所有 getElementById 引用必须有对应 id ===');
const ids = new Set([...adminSrc.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const refs = uniq([...adminSrc.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]));
// 允许清单：settingsTab 是 `getElementById('settingsTab') || getElementById('tab-settings')`
// 的有意兜底写法，元素不存在属预期。
const OPTIONAL_IDS = new Set(['settingsTab']);
const missing = refs.filter(r => !ids.has(r) && !OPTIONAL_IDS.has(r));
ok(missing.length === 0, `无悬空引用${missing.length ? ' -> ' + missing.join(', ') : ''}`);
ok(ids.has('hubCompatRecommended'), 'id="hubCompatRecommended" 存在（推荐核心可被更新）');

console.log(`\n[version-matrix-sync] pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
