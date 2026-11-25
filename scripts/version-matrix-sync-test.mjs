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
import { createRequire } from 'node:module';
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
const range = meta?.compatibility?.supportedDshRange;
const adapted = meta?.compatibility?.adaptedVersions || [];
const dshSrc = fs.readFileSync(path.join(root, 'gateway/dsh-manager.js'), 'utf8');
const vsSrc = fs.readFileSync(path.join(root, 'gateway/version-service.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(root, 'gateway/public/admin.html'), 'utf8');

const uniq = (a) => [...new Set(a)];

console.log('\n=== A. version.json 自身一致性 ===');
ok(typeof recommended === 'string' && recommended.length > 0, `recommendedDsh 已定义 (${recommended})`);
ok(adapted.includes(recommended), `adaptedVersions 包含 recommendedDsh (${recommended})`);
ok(adapted[0] === recommended, `adaptedVersions 置顶项为 recommendedDsh (${adapted[0]})`);
ok(adapted.includes('0.2.1-rc.2'), 'adaptedVersions 包含 0.2.1-rc.2');
ok(adapted.includes('0.2.1-alpha.5'), 'adaptedVersions 保留上一版 0.2.1-alpha.5');
ok(adapted.includes('0.2.1-alpha.4'), 'adaptedVersions 保留 0.2.1-alpha.4');
ok(adapted.includes('0.2.1-alpha.3'), 'adaptedVersions 保留 0.2.1-alpha.3');
ok(adapted.includes('0.2.1-alpha.2'), 'adaptedVersions 保留上一版 0.2.1-alpha.2');
ok(adapted.includes('0.2.1-alpha.1'), 'adaptedVersions 保留 0.2.1-alpha.1');
ok(adapted.includes('0.2.0-rc.2'), 'adaptedVersions 保留 0.2.0-rc.2');
ok(adapted.includes('0.1.7-rc.2') && adapted.includes('0.1.7-rc.1') && adapted.includes('0.1.7-alpha.2') && adapted.includes('0.1.7-alpha.1'), 'adaptedVersions 包含 0.1.7-rc.2 / 0.1.7-rc.1 / 0.1.7-alpha.2 / 0.1.7-alpha.1');
ok(meta?.supply?.dshVersion && adapted.includes(meta.supply.dshVersion), `supply.dshVersion 在已适配列表内 (${meta?.supply?.dshVersion})`);

console.log('\n=== B. dsh-manager.js 兜底清单必须与 version.json 同步 ===');
const dmBlock = dshSrc.match(/const DEFAULT_ADAPTED_VERSIONS = \[([\s\S]*?)\];/);
ok(Boolean(dmBlock), '找到 DEFAULT_ADAPTED_VERSIONS 定义');
const dmList = dmBlock ? uniq([...dmBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
for (const v of adapted) ok(dmList.includes(v), `dsh-manager 兜底包含 ${v}`);
ok(dmList.includes(recommended), `dsh-manager 兜底包含 recommendedDsh (${recommended})`);
ok(JSON.stringify(dmList) === JSON.stringify(adapted), 'dsh-manager 兜底清单与 version.json 逐字节一致');

console.log('\n=== C. version-service.js 兜底清单必须与 version.json 同步 ===');
const vsBlock = vsSrc.match(/adaptedVersions:\s*\[([\s\S]*?)\]/);
const vsList = vsBlock ? uniq([...vsBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
ok(vsList.includes(recommended), `version-service getLocalMeta 兜底包含 recommendedDsh (${recommended})`);
ok(!vsList.length || vsList.every(v => adapted.includes(v)), 'version-service getLocalMeta 兜底无多余版本');
ok(JSON.stringify(vsList) === JSON.stringify(adapted), 'version-service getLocalMeta 兜底清单与 version.json 逐字节一致');

// 同一对象里的两个标量：过去只比对数组，导致"数组抬了、recommendedDsh/supportedDshRange 没抬"
// 这类漏改全绿通过（本次升级就踩到了，是子代理审核抓出来的）。
// 先剥掉行注释再取值：否则把真字段改错、上面加一行 `// recommendedDsh: '正确值'` 就能骗过门禁。
const vsNoComment = vsSrc.replace(/^\s*\/\/.*$/gm, '');
const vsRec = (vsNoComment.match(/recommendedDsh:\s*'([^']+)'/) || [])[1];
const vsRange = (vsNoComment.match(/supportedDshRange:\s*'([^']+)'/) || [])[1];
ok(vsRec === recommended, `version-service 兜底 recommendedDsh 与 version.json 一致 (${vsRec} vs ${recommended})`);
ok(vsRange === range, `version-service 兜底 supportedDshRange 与 version.json 一致 (${vsRange} vs ${range})`);

const vsEvalBlock = vsSrc.match(/const adapted = m\.compatibility\?\.adaptedVersions \|\| \[([\s\S]*?)\];/);
const vsEvalList = vsEvalBlock ? uniq([...vsEvalBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])) : [];
ok(vsEvalList.includes(recommended), `version-service evaluateTargetVersion 兜底包含 recommendedDsh (${recommended})`);
ok(JSON.stringify(vsEvalList) === JSON.stringify(adapted), 'version-service evaluateTargetVersion 兜底清单与 version.json 逐字节一致');

console.log('\n=== D. admin.html 前端兜底 / 静态默认值 ===');
const fbLists = [
  ...[...adminSrc.matchAll(/const adaptedList = compat\.adaptedVersions \|\| \[([^\]]*)\]/g)].map(m => m[1]),
  ...[...adminSrc.matchAll(/availableAdaptedVersions = data\.adaptedVersions \|\| \[([^\]]*)\]/g)].map(m => m[1]),
];
ok(fbLists.length >= 3, `找到 ${fbLists.length} 处 adaptedVersions 兜底数组 (期望 ≥3)`);
for (const [i, raw] of fbLists.entries()) {
  const list = uniq([...raw.matchAll(/'([^']+)'/g)].map(m => m[1]));
  ok(list.includes(recommended), `admin.html 兜底#${i + 1} 包含 recommendedDsh`);
  ok(JSON.stringify(list) === JSON.stringify(adapted), `admin.html 兜底#${i + 1} 与 version.json 逐字节一致`);
}
for (const re of [/recommendedDsh \|\| '([^']+)'/, /supportedDshRange \|\| '([^']+)'/]) {
  const all = [...adminSrc.matchAll(new RegExp(re.source, 'g'))].map(m => m[1]);
  ok(all.length > 0 && all.every(v => !v.includes('0.2.0-rc.2') && !v.includes('<=0.2.0-rc.2')), `前端兜底不含上一版推荐值或旧区间 (命中 ${all.length} 处)`);
}
const recPattern = new RegExp(`compat\\.recommendedDsh \\|\\| '(?!${recommended.replace(/\\./g, '\\.')})`);
ok(!recPattern.test(adminSrc), `recommendedDsh 兜底为 ${recommended}`);
const chipCount = (adminSrc.match(new RegExp(`>${recommended.replace(/\./g, '\\.')}</span>`, 'g')) || []).length;
ok(chipCount >= 2, `静态适配 chips 含 ${recommended} (${chipCount} 处)`);
// 静态"兼容支持范围"文案：JS 起来后会被接口数据覆盖，但首屏 / 接口失败时会露出，
// 必须与 version.json 一致（此前只检查"不含旧区间"，漏掉了 <=0.2.2-rc.5 这种中间态）。
// 注意：区间文案里的 "<=" 是未转义的小于号，用 [^<]+ 会在 "<" 处截断，必须一路取到 </code>
// 同理：注释掉的标记不该被算作"存在"，先剥 HTML 注释再断言。
const adminNoComment = adminSrc.replace(/<!--[\s\S]*?-->/g, '');
const staticRange = [...adminNoComment.matchAll(/id="(?:popoverCompatRange|hubCompatRange)"[^>]*>([\s\S]*?)<\/code>/g)].map(m => m[1].trim());
ok(staticRange.length >= 2, `找到 ${staticRange.length} 处静态兼容范围文案 (期望 ≥2)`);
for (const [i, v] of staticRange.entries()) {
  ok(v === range, `静态兼容范围#${i + 1} 与 version.json 一致 (${v} vs ${range})`);
}

// 静态 chips 必须是完整清单（不是"包含推荐项"就够）：升级前每块只有 22 项，缺 3 项
// 因为门禁只抽检了两个版本号，全量差异一直没被发现。
for (const id of ['popoverCompatChips', 'hubCompatChips']) {
  const m = adminNoComment.match(new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)</div>'));
  // 不能用 uniq：重复项渲染出来就是两个相同 chip，属于真实缺陷，必须能断言出来。
  const chips = m ? [...m[1].matchAll(/badge-chip chip-(?:green|gray)">([^<]+)</g)].map(x => x[1]) : [];
  ok(JSON.stringify(chips) === JSON.stringify(adapted), `静态 chips #${id} 与 version.json 完整一致（含顺序、无重复）(${chips.length} vs ${adapted.length} 项)`);
}

// JS 侧「区间兜底字面量」也要精确比对：之前只排除 `<=0.2.0-rc.2`，像 <=0.2.2-rc.5 这种中间态抓不到。
const rangeFallbacks = [...adminNoComment.matchAll(/compat\.supportedDshRange \|\| '([^']+)'/g)].map(m => m[1]);
ok(rangeFallbacks.length >= 2, `找到 ${rangeFallbacks.length} 处 JS 区间兜底 (期望 ≥2)`);
for (const [i, v] of rangeFallbacks.entries()) {
  ok(v === range, `JS 区间兜底#${i + 1} 与 version.json 一致 (${v} vs ${range})`);
}

// 回归：升级推荐核心时必须「置顶新增」而不是「替换掉」上一版推荐，
// 否则冷启动静态页面（API 返回前）会漏展示上一版已深度适配的核心。
// 上一版推荐 = 适配清单里的第二项（写死会在每次升版后变成两版前的值，测不到真正的问题）。
const prevRecommended = adapted[1];
const prevChipCount = (adminSrc.match(new RegExp(`>${prevRecommended.replace(/\./g, '\\.')}</span>`, 'g')) || []).length;
ok(prevChipCount >= 2, `静态适配 chips 保留上一推荐版本 ${prevRecommended} (${prevChipCount} 处)`);

console.log('\n=== D2. 版本语义不变量：推荐/出厂/适配集合必须都落在兼容区间内 ===');
const vsvc = createRequire(import.meta.url)('../gateway/version-service.js');
ok(vsvc.satisfiesRange(recommended, range), `recommendedDsh 落在兼容区间内 (${recommended} ∈ ${range})`);
ok(vsvc.satisfiesRange(meta.supply.dshVersion, range), `supply.dshVersion 落在兼容区间内 (${meta.supply.dshVersion})`);
const outOfRange = adapted.filter((v) => !vsvc.satisfiesRange(v, range));
ok(outOfRange.length === 0, `adaptedVersions 全部落在兼容区间内${outOfRange.length ? '（越界: ' + outOfRange.join(', ') + '）' : ''}`);

console.log('\n=== D3. SemVer 比较器必须只有一份实现（历史上有三份副本各修各的） ===');
const SEMVER_PROBE = [
  ['0.2.3-alpha.10', '0.2.3-alpha.2'],
  ['0.2.3-alpha.9', '0.2.3-alpha.20'],
  ['0.2.3-alpha', '0.2.3-alpha.1'],
  ['0.2.3-rc.1', '0.2.3-alpha.2'],
  ['0.2.3', '0.2.3-alpha.99'],
  ['0.2.2-rc.5', '0.2.3-alpha.2']
];
const vsvc2 = createRequire(import.meta.url)('../gateway/version-service.js');
const smvc = createRequire(import.meta.url)('../gateway/snapshot-manifest.js');
ok(typeof vsvc2.compareSemver === 'function', 'version-service 导出 compareSemver');
ok(typeof smvc.compareSemver === 'function', 'snapshot-manifest 导出 compareSemver');
const diverge = SEMVER_PROBE.filter(([a, b]) => Math.sign(vsvc2.compareSemver(a, b)) !== Math.sign(smvc.compareSemver(a, b)));
ok(diverge.length === 0, `version-service 与 snapshot-manifest 比较结果一致${diverge.length ? '（分歧: ' + diverge.map(([a, b]) => a + ' vs ' + b).join('; ') + '）' : ''}`);
ok(Math.sign(vsvc2.compareSemver('0.2.3-alpha.10', '0.2.3-alpha.2')) === 1,
  'alpha.10 > alpha.2（按数值比较，非字典序）');
// 源码层面锁死：不允许任何 gateway/*.js 再自己实现一份 localeCompare 版预发布比较
const gwFiles = fs.readdirSync(path.join(root, 'gateway')).filter((f) => f.endsWith('.js'));
const dupImpl = gwFiles.filter((f) => {
  if (f === 'semver.js') return false;
  const src = fs.readFileSync(path.join(root, 'gateway', f), 'utf8');
  return /pre\.localeCompare\(/.test(src) || /function compareSemver\s*\(/.test(src);
});
ok(dupImpl.length === 0, `除 gateway/semver.js 外无第二份 compareSemver 实现${dupImpl.length ? '（发现: ' + dupImpl.join(', ') + '）' : ''}`);

// 首屏静态「推荐 vX」徽标同样会露出来（运行时才被接口覆盖），此前门禁完全没覆盖。
const recBadges = [...adminNoComment.matchAll(/推荐 v([0-9][^<\s]*)/g)].map(m => m[1]);
ok(recBadges.length >= 1, `找到 ${recBadges.length} 处静态"推荐 vX"徽标`);
for (const [i, v] of recBadges.entries()) {
  ok(v === recommended, `静态推荐徽标#${i + 1} 与 version.json 一致 (${v} vs ${recommended})`);
}
const hubRec = adminNoComment.match(/id="hubCompatRecommended"[^>]*>\s*v([0-9][^<\s]*)/);
ok(Boolean(hubRec) && hubRec[1] === recommended, `hubCompatRecommended 静态值一致 (${hubRec ? hubRec[1] : '未找到'})`);

console.log('\n=== D5. gateway 内部相对 require 必须都能解析（防止新增文件漏提交导致启动即崩） ===');
const gwAll = fs.readdirSync(path.join(root, 'gateway')).filter((f) => f.endsWith('.js'));
const missingReq = [];
for (const f of gwAll) {
  const src = fs.readFileSync(path.join(root, 'gateway', f), 'utf8');
  for (const m of src.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
    let rel = m[1];
    if (!rel.endsWith('.js') && !rel.endsWith('.json')) rel += '.js';
    const target = path.join(root, 'gateway', rel);
    if (!fs.existsSync(target)) missingReq.push(f + ' -> ' + m[1]);
  }
}
ok(missingReq.length === 0, `gateway 内部 require 全部可解析${missingReq.length ? '（缺失: ' + missingReq.join('; ') + '）' : ''}`);
// semver.js 曾经是"已 require 但未纳入版本控制"的未跟踪文件：漏提交就是网关 MODULE_NOT_FOUND 启动即崩。
const gwNew = ['semver.js'];
for (const f of gwNew) {
  ok(fs.existsSync(path.join(root, 'gateway', f)), `gateway/${f} 存在`);
}

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
