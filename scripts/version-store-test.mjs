#!/usr/bin/env node
/**
 * Issue #7 版本库（持久化 / 完整性 / GC）单元测试
 *
 * 覆盖点：
 *   A. 半成品归档（只有 package.json、无 .ready）绝不算「已缓存」
 *   B. .ready 中 Node ABI / 架构不匹配的归档判为失效
 *   C. .staging 等内部目录不被列为版本
 *   D. deleteCachedVersion 保护活动版本与镜像出厂基准版本
 *   E. gcVersions 保留 keepN + 活动版本 + 出厂基准版本，其余按 LRU 清理
 *   F. getVersionsStoreStats 结构正确
 *
 * 用法: node scripts/version-store-test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// 必须在 require 之前设置环境变量（模块级常量在加载时求值）
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-store-test-'));
process.env.DSH_VERSIONS_DIR = STORE;
process.env.DSH_HOME = STORE;
// 测试钩子：把「活动核心父目录 / dsh 软链」指到临时目录，以便覆盖置换与回滚逻辑
const CORE_PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-core-test-'));
process.env.DSH_TEST_CORE_PARENT = CORE_PARENT;
process.env.DSH_TEST_BIN_LINK = path.join(CORE_PARENT, 'fake-dsh-bin');

const mgr = require('../gateway/dsh-manager.js');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`   ✔ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`   ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 造一个「完整可用」的归档目录 */
function makeReady(version, { abi = process.versions.modules, arch = process.arch } = {}) {
  const dir = path.join(STORE, version);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  fs.writeFileSync(path.join(dir, 'node_modules', 'index.js'), '// dep\n');
  fs.writeFileSync(path.join(dir, '.ready'), JSON.stringify({ version, nodeAbi: abi, arch, imageRevision: 'test' }));
  return dir;
}
/** 造一个半成品归档：只落了 package.json（模拟 cp -a 中途被 SIGKILL） */
function makeHalfBaked(version) {
  const dir = path.join(STORE, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return dir;
}

console.log(`\n===== Issue #7 版本库单元测试 (store=${STORE}) =====\n`);

// ── A/B/C: 完整性判定 ────────────────────────────────────────────────
console.log('[A/B/C] 完整性判定');
makeReady('1.0.0');
makeHalfBaked('2.0.0');
makeReady('3.0.0', { abi: '999' });            // ABI 不匹配 → 失效
makeReady('4.0.0', { arch: 'mips' });          // 架构不匹配 → 失效
fs.mkdirSync(path.join(STORE, '.staging', 'junk'), { recursive: true });

eq('getCachedVersions 只返回通过 .ready 校验的版本', mgr.getCachedVersions(), ['1.0.0']);
check('半成品 2.0.0 未被当作已缓存', !mgr.getCachedVersions().includes('2.0.0'));
check('ABI 不匹配的 3.0.0 被判失效', !mgr.getCachedVersions().includes('3.0.0'));
check('架构不匹配的 4.0.0 被判失效', !mgr.getCachedVersions().includes('4.0.0'));
check('.staging 内部目录不出现在版本列表', !mgr.getCachedVersions().some(v => v.startsWith('.')));
check('versionsCacheDir 指向持久化版本库（非 /app）', mgr.versionsCacheDir === STORE, mgr.versionsCacheDir);

// ── F: 统计 ─────────────────────────────────────────────────────────
console.log('\n[F] 版本库统计');
mgr.lastKnownVersion = '1.0.0';
const stats = mgr.getVersionsStoreStats();
check('stats.ok 为真', stats.ok === true);
check('stats.dir 正确', stats.dir === STORE);
check('stats.persisted 为布尔值', typeof stats.persisted === 'boolean');
check('stats 列出 4 个条目（含半成品）', stats.versions.length === 4, `实际 ${stats.versions.length}`);
const v100 = stats.versions.find(v => v.version === '1.0.0');
check('活动版本被标记 active', v100 && v100.active === true);
check('条目携带 ready 标志', stats.versions.find(v => v.version === '2.0.0')?.ready === false);
check('条目携带体积字段', typeof v100.sizeBytes === 'number');

// ── D: 删除保护 ─────────────────────────────────────────────────────
console.log('\n[D] 删除保护');
const dActive = mgr.deleteCachedVersion('1.0.0');
check('拒绝删除正在运行的版本', dActive.ok === false, JSON.stringify(dActive));
const dPinned = mgr.deleteCachedVersion('0.1.7-rc.1');
check('拒绝删除镜像出厂基准版本', dPinned.ok === false, JSON.stringify(dPinned));
const dBad = mgr.deleteCachedVersion('../../etc');
check('拒绝非法版本号（目录穿越）', dBad.ok === false, JSON.stringify(dBad));
const dHalf = mgr.deleteCachedVersion('2.0.0');
check('允许删除半成品归档', dHalf.ok === true, JSON.stringify(dHalf));
check('删除后 2.0.0 已不存在', !fs.existsSync(path.join(STORE, '2.0.0')));

// ── E: GC ───────────────────────────────────────────────────────────
console.log('\n[E] GC 保留策略');
// 活动版本给一个更旧的 mtime，避免它挤占 keepN 名额（活动版本另有独立保护）
const activeDir = path.join(STORE, '1.0.0');
fs.utimesSync(activeDir, new Date(Date.now() - 9000), new Date(Date.now() - 9000));
for (const [v, ageMs] of [['1.1.0', 4000], ['1.2.0', 3000], ['1.3.0', 2000], ['1.4.0', 1000]]) {
  const dir = makeReady(v);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, t, t); // 人为拉开 LRU 时间
}
mgr.lastKnownVersion = '1.0.0';
const gc = mgr.gcVersions({ keepN: 2, activeVersion: '1.0.0' });
check('GC 返回 ok', gc.ok === true);
check('GC 保留了活动版本 1.0.0', fs.existsSync(path.join(STORE, '1.0.0')));
check('GC 保留 keepN=2 个最新版本 (1.4.0 / 1.3.0)', fs.existsSync(path.join(STORE, '1.4.0')) && fs.existsSync(path.join(STORE, '1.3.0')));
check('GC 清理了次新的 1.2.0', !fs.existsSync(path.join(STORE, '1.2.0')));
check('GC 清理了最旧的 1.1.0', !fs.existsSync(path.join(STORE, '1.1.0')));
check('GC 报告释放字节数 > 0', gc.freedBytes > 0, String(gc.freedBytes));
check('GC 清理清单含 1.1.0', gc.removed.some(r => r.version === '1.1.0'));

// 出厂基准版本必须被保护
makeReady('0.1.7-rc.1');
const gc2 = mgr.gcVersions({ keepN: 1, activeVersion: '1.0.0' });
check('GC 永不清理镜像出厂基准版本 0.1.7-rc.1', fs.existsSync(path.join(STORE, '0.1.7-rc.1')), JSON.stringify(gc2.removed));
check('GC 保护清单包含出厂版本', gc2.kept.includes('0.1.7-rc.1'), JSON.stringify(gc2.kept));

// dryRun 不落盘
makeReady('1.9.0');
const before = fs.existsSync(path.join(STORE, '1.9.0'));
const gc3 = mgr.gcVersions({ keepN: 1, activeVersion: '1.0.0', dryRun: true });
check('dryRun 不删除文件', fs.existsSync(path.join(STORE, '1.9.0')) === before);
check('dryRun 仍返回清理预览', Array.isArray(gc3.removed));

// ── G: 磁盘水位预检 / 并发保护 / 残留清理 ────────────────────────────
console.log('\n[G] 磁盘水位预检（ENOSPC 安全闸门）');
const logs = [];
let threw = false;
try { mgr._assertDiskSpace([STORE], 1024 ** 5, (m) => logs.push(m)); }
catch (e) { threw = /磁盘空间不足/.test(e.message); }
check('空间不足时抛错中止（现网核心不受影响）', threw === true);
let passedOk = false;
try { mgr._assertDiskSpace([STORE], 1024, (m) => logs.push(m)); passedOk = true; } catch { passedOk = false; }
check('空间充足时通过并打印水位', passedOk === true && logs.some(l => l.includes('磁盘水位检查通过')));

console.log('\n[H] 并发保护');
mgr.installing = true;
check('切换进行中拒绝 GC', mgr.gcVersions({}).ok === false);
check('切换进行中拒绝删除', mgr.deleteCachedVersion('1.9.0').ok === false);
mgr.installing = false;

console.log('\n[I] staging 残留清理');
const orphanOld = path.join(STORE, '.staging', 'orphan-old');
fs.mkdirSync(orphanOld, { recursive: true });
const oldT = new Date(Date.now() - 2 * 3600 * 1000);
fs.utimesSync(orphanOld, oldT, oldT);
mgr.cleanupStagingOrphans();
check('清理过期 staging 残留', !fs.existsSync(orphanOld));
const orphanFresh = path.join(STORE, '.staging', 'orphan-fresh');
fs.mkdirSync(orphanFresh, { recursive: true });
mgr.cleanupStagingOrphans();
check('保留未过期的 staging', fs.existsSync(orphanFresh));

console.log('\n[J] 早期失败路径回归（catch 块作用域）');
// 曾经的真实缺陷：tmpPrefix 在 try 内声明，catch 块看不到 → 一旦 try 内失败，
// catch 首句 `if (tmpPrefix)` 抛 ReferenceError，把真实的失败原因掩盖掉。
makeReady('9.9.9');
mgr.lastKnownVersion = '1.0.0';
const origAssert = mgr._assertDiskSpace;
mgr._assertDiskSpace = () => { throw new Error('磁盘空间不足：测试注入'); };
let r;
try { r = await mgr.installVersion('9.9.9'); } catch (e) { r = { threw: e.message }; }
mgr._assertDiskSpace = origAssert;
check('早期失败返回错误对象而非抛 ReferenceError', r && r.ok === false && !r.threw, JSON.stringify(r));
check('未触碰现网时标记 untouched', r && r.untouched === true, JSON.stringify(r));
check('失败后 installing 已复位', mgr.installing === false);
check('失败日志包含真实原因（未被掩盖）', mgr.installLog.some(l => l.includes('磁盘空间不足')), mgr.installLog.slice(-2).join(' | '));

console.log('\n[K] 静态作用域守卫（关键变量必须在 try 之外声明，否则 catch 看不到）');
const src = fs.readFileSync(new URL('../gateway/dsh-manager.js', import.meta.url), 'utf8');
const fnStart = src.indexOf('async installVersion(');
const body = src.slice(fnStart);
// 主 try 紧跟在「阶段 1/5」注释之前；用它做锚点（不能直接用 indexOf('try {')，
// 因为 emitProgress 等闭包里也有 try）。
const mainTryAnchor = body.indexOf('// === 阶段 1/5');
check('定位到 installVersion 主 try 块', fnStart > 0 && mainTryAnchor > 0);
for (const v of ['stagingDir', 'tmpPrefix', 'rollbackDir', 'coreMutated']) {
  const decl = body.indexOf(`let ${v}`);
  check(`${v} 在 try 之前声明（catch 可见）`, decl > 0 && decl < mainTryAnchor, `decl@${decl} try@${mainTryAnchor}`);
}
// 归档临时目录：不得在 try 内声明却在 catch 内引用
for (const v of ['archTmp']) {
  const declIdx = body.indexOf(`const ${v} =`);
  if (declIdx < 0) continue;
  const around = body.slice(declIdx, declIdx + 600);
  const catchIdx = around.indexOf('} catch (e) {');
  const useInCatch = catchIdx >= 0 && around.slice(catchIdx).includes(v);
  const declInsideTry = body.slice(Math.max(0, declIdx - 400), declIdx).lastIndexOf('try {') > body.slice(Math.max(0, declIdx - 400), declIdx).lastIndexOf('}');
  check(`${v} 若在 catch 中被引用则必须在 try 之外声明`, !(useInCatch && declInsideTry), `useInCatch=${useInCatch} declInsideTry=${declInsideTry}`);
}

// ── L: 原子置换与回滚点生命周期（用 DSH_TEST_CORE_PARENT 隔离到临时目录） ──
console.log('\n[L] 原子置换与回滚点生命周期');
const LIVE = path.join(CORE_PARENT, 'dsh');
const writeCore = (dir, ver) => {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: ver }));
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), `// ${ver}\n`);
};
const verOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
const makeStaging = (name, ver) => {
  const d = path.join(CORE_PARENT, `.dsh-staging-${name}`);
  writeCore(d, ver);
  return d;
};

writeCore(LIVE, '9.0.0');
const rb = mgr._atomicSwapCore(makeStaging('t1', '9.1.0'));
check('置换返回回滚点路径', !!rb && fs.existsSync(rb), String(rb));
check('回滚点在探活通过前不被删除', !!rb && fs.existsSync(rb));
check('活动核心已切到新版本', verOf(LIVE) === '9.1.0');
check('回滚点里保留的是旧版本', !!rb && verOf(rb) === '9.0.0');

// 模拟「探活失败 → 从回滚点秒级还原」（不依赖归档、不联网）
mgr._restoreFromRollbackDir(rb);
check('从回滚点还原后活动核心回到旧版本', verOf(LIVE) === '9.0.0');
check('还原后回滚点已被消费', !fs.existsSync(rb));

// 模拟「探活通过 → 清理回滚点」
const rb2 = mgr._atomicSwapCore(makeStaging('t2', '9.2.0'));
mgr._disposeRollbackDir(rb2);
check('探活通过后回滚点被清理', !fs.existsSync(rb2));
check('清理回滚点后活动核心仍是新版本', verOf(LIVE) === '9.2.0');

// 模拟 overlayfs 的 EXDEV：让「把活动核心挪到回滚点」的第一次 rename 失败，
// 验证会退化为「复制 + 删除」，且回滚点仍是完整可用的旧核心。
const realRename = fs.renameSync;
let exdevHits = 0;
fs.renameSync = function (from, to) {
  if (from === LIVE && exdevHits === 0) {
    exdevHits++;
    const e = new Error('cross-device link not permitted');
    e.code = 'EXDEV';
    throw e;
  }
  return realRename.apply(fs, arguments);
};
let rb3 = null;
let exdevThrew = null;
try { rb3 = mgr._atomicSwapCore(makeStaging('t3', '9.3.0')); } catch (e) { exdevThrew = e.message; }
fs.renameSync = realRename;
check('EXDEV 触发了一次降级', exdevHits === 1, `hits=${exdevHits}`);
check('EXDEV 下置换仍成功', !exdevThrew && verOf(LIVE) === '9.3.0', exdevThrew || '');
check('EXDEV 下回滚点仍是完整旧核心', !!rb3 && verOf(rb3) === '9.2.0', String(rb3));
mgr._restoreFromRollbackDir(rb3);
check('EXDEV 下从回滚点还原成功', verOf(LIVE) === '9.2.0');

// ── M: 引擎回滚点治理（提升轮替、单槽位约束、防误杀、ABI 校验与还原控制台方法）──
console.log('\n[M] 引擎回滚点治理与就地还原');

// M1: 初始空态
check('初始状态下无回滚点', mgr.getRollbackPoint().exists === false);

// M2: 提升与单槽位约束
const tmp1 = path.join(CORE_PARENT, '.dsh-rollback-tmp-1');
writeCore(tmp1, '8.0.0');
mgr._promoteToPreservedRollback(tmp1, '8.0.0');
const p1 = mgr.getRollbackPoint();
check('提升后回滚点存在', p1.exists === true);
check('提升后版本为 8.0.0', p1.version === '8.0.0');
check('提升后 ABI 匹配', p1.abiMatches === true);
check('临时目录已被移动消费', !fs.existsSync(tmp1));
check('受保护槽位命名为 .dsh-rollback-preserved', path.basename(p1.path) === '.dsh-rollback-preserved');

// M3: 轮替（新换下的核心提升后旧备件被删除，槽位始终 ≤1 份）
const tmp2 = path.join(CORE_PARENT, '.dsh-rollback-tmp-2');
writeCore(tmp2, '8.1.0');
mgr._promoteToPreservedRollback(tmp2, '8.1.0');
const p2 = mgr.getRollbackPoint();
check('轮替后回滚点仍存在', p2.exists === true);
check('轮替后内容变为最近换下的 8.1.0', p2.version === '8.1.0');
const allRollbacks = fs.readdirSync(CORE_PARENT).filter(n => n.startsWith('.dsh-rollback-'));
check('受保护槽位始终 ≤1 份且为 .dsh-rollback-preserved', allRollbacks.length === 1 && allRollbacks[0] === '.dsh-rollback-preserved', JSON.stringify(allRollbacks));

// M4: cleanupStagingOrphans 防误杀与过期清理
const tmpExpired = path.join(CORE_PARENT, '.dsh-rollback-tmp-expired');
writeCore(tmpExpired, '7.9.0');
const pastTime = new Date(Date.now() - 2 * 3600 * 1000);
fs.utimesSync(tmpExpired, pastTime, pastTime);
fs.utimesSync(p2.path, pastTime, pastTime); // 受保护槽位也模拟为 2 小时前
mgr.cleanupStagingOrphans(3600 * 1000);
check('过期临时回滚点 -tmp- 已被清理', !fs.existsSync(tmpExpired));
check('受保护槽位 .dsh-rollback-preserved 未被清理（防误杀）', fs.existsSync(p2.path));

// M5: ABI / 架构校验与拒绝还原
const readyPath = path.join(p2.path, '.ready');
const markerData = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
markerData.nodeAbi = '99999';
fs.writeFileSync(readyPath, JSON.stringify(markerData));
const pMismatched = mgr.getRollbackPoint();
check('ABI 不匹配时 abiMatches 为 false', pMismatched.abiMatches === false);
check('ABI 不匹配时 canRestore 为 false', pMismatched.canRestore === false);

let abiThrew = false;
try { mgr._restoreFromRollbackDir(p2.path); }
catch (e) { abiThrew = /Node ABI.*不匹配/.test(e.message); }
check('_restoreFromRollbackDir 遇到 ABI 不匹配时拒绝还原', abiThrew);

const restoreAbiFail = await mgr.restoreRollbackPoint();
check('restoreRollbackPoint 遇到 ABI 不匹配拒绝还原', restoreAbiFail.ok === false && /Node ABI.*不匹配/.test(restoreAbiFail.error));

// M6: 手动清理回滚点 deleteRollbackPoint
markerData.nodeAbi = process.versions.modules;
fs.writeFileSync(readyPath, JSON.stringify(markerData));
const delRes = mgr.deleteRollbackPoint();
check('deleteRollbackPoint 成功', delRes.ok === true);
check('deleteRollbackPoint 报告释放字节数 > 0', delRes.freedBytes > 0);
check('回滚点目录已被删除', !fs.existsSync(p2.path));
check('清理后状态回到空态', mgr.getRollbackPoint().exists === false);
const delNonExist = mgr.deleteRollbackPoint();
check('删除不存在的回滚点返回失败', delNonExist.ok === false && /不存在/.test(delNonExist.error));

// M7: 并发保护
mgr.installing = true;
const delBusy = mgr.deleteRollbackPoint();
check('切换进行中拒绝删除回滚点', delBusy.ok === false && /进行中/.test(delBusy.error));
const restoreBusy = await mgr.restoreRollbackPoint();
check('切换进行中拒绝还原回滚点', restoreBusy.ok === false && /进行中/.test(restoreBusy.error));
mgr.installing = false;

// M8: 就地还原端到端模拟（成功流程 + 失败回退流程）
writeCore(LIVE, '8.2.0');
const tmpRestore = path.join(CORE_PARENT, '.dsh-rollback-tmp-r1');
writeCore(tmpRestore, '8.1.0');
mgr._promoteToPreservedRollback(tmpRestore, '8.1.0');
check('待还原备件准备就绪 (8.1.0)', mgr.getRollbackPoint().exists && mgr.getRollbackPoint().version === '8.1.0');

const origStop = mgr.stop;
const origRestart = mgr.restart;
mgr.stop = async () => ({ ok: true });
mgr.restart = async () => ({ ok: true });

const restoreSuccess = await mgr.restoreRollbackPoint();
check('restoreRollbackPoint 成功返回', restoreSuccess.ok === true && restoreSuccess.version === '8.1.0');
check('活动核心已就地还原至备件版本 8.1.0', verOf(LIVE) === '8.1.0');
check('前序活动核心 (8.2.0) 被轮替存入受保护槽位', mgr.getRollbackPoint().exists && mgr.getRollbackPoint().version === '8.2.0');

// 模拟还原后探活失败：自动回退至活动核心，原有备件原封不动
mgr.restart = async () => ({ ok: false });
const restoreFail = await mgr.restoreRollbackPoint();
check('探活失败时 restoreRollbackPoint 返回 rolledBack: true', restoreFail.ok === false && restoreFail.rolledBack === true);
check('失败后活动核心自动安全回退至原运行版本 (8.1.0)', verOf(LIVE) === '8.1.0');
check('失败后备件原封不动保留 (8.2.0 未被破坏)', mgr.getRollbackPoint().exists && mgr.getRollbackPoint().version === '8.2.0');

mgr.stop = origStop;
mgr.restart = origRestart;

// ── 清理 ────────────────────────────────────────────────────────────
fs.rmSync(STORE, { recursive: true, force: true });
fs.rmSync(CORE_PARENT, { recursive: true, force: true });

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
if (fail > 0) { console.log('失败项:\n - ' + failures.join('\n - ')); process.exit(1); }
