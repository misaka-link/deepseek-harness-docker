#!/usr/bin/env node
/**
 * 持久化核心版本库（完整性、GC、原子置换、回滚点治理与 v1.0.0 下限拦截）单元测试。
 * 用法: node tests/unit/version-store.test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-store-test-'));
const CORE_PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-core-test-'));
process.env.DSH_VERSIONS_DIR = STORE;
process.env.DSH_HOME = STORE;
process.env.DSH_TEST_CORE_PARENT = CORE_PARENT;
process.env.DSH_TEST_BIN_LINK = path.join(CORE_PARENT, 'fake-dsh-bin');

const mgr = require(path.join(root, 'gateway/src/dsh/index.js'));
const {
  FALLBACK_DSH_VERSION,
  atomicSwapCore,
  assertDiskSpace
} = require(path.join(root, 'gateway/src/dsh/version-store.js'));
const {
  promoteToPreservedRollback,
  disposeRollbackDir,
  restoreFromRollbackDir
} = require(path.join(root, 'gateway/src/dsh/rollback-slot.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`   ✔ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`   ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

function makeReady(version, { abi = process.versions.modules, arch = process.arch } = {}) {
  const dir = path.join(STORE, version);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  fs.writeFileSync(path.join(dir, 'node_modules', 'index.js'), '// dep\n');
  fs.writeFileSync(path.join(dir, '.ready'), JSON.stringify({ version, nodeAbi: abi, arch, imageRevision: 'test' }));
  return dir;
}

function makeHalfBaked(version) {
  const dir = path.join(STORE, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return dir;
}

const LIVE = path.join(CORE_PARENT, 'dsh');
const writeCore = (dir, ver) => {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: ver }));
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), `// ${ver}\n`);
};
const verOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

try {
  // A/B/C: 完整性判定
  makeReady('0.2.3-alpha.2');
  makeHalfBaked('0.2.3-alpha.3');
  makeReady('0.2.4', { abi: '999' });
  makeReady('0.2.5', { arch: 'mips' });
  fs.mkdirSync(path.join(STORE, '.staging', 'junk'), { recursive: true });

  check('A. getCachedVersions 仅返回通过 .ready + ABI + arch 校验的版本', JSON.stringify(mgr.getCachedVersions()) === JSON.stringify(['0.2.3-alpha.2']));
  check('B. versionsCacheDir 指向持久化版本库', mgr.versionsCacheDir === STORE);

  // F: 统计
  mgr.lastKnownVersion = '0.2.3-alpha.2';
  const stats = mgr.getVersionsStoreStats();
  check('C. getVersionsStoreStats 返回 4 个条目、active 与 pinned 标记准确',
    stats.ok && stats.versions.length === 4 && stats.versions.find((v) => v.version === '0.2.3-alpha.2')?.active === true);

  // D: 删除保护
  check('D1. 拒绝删除活动版本', mgr.deleteCachedVersion('0.2.3-alpha.2').ok === false);
  mgr.lastKnownVersion = '0.2.4';
  check('D2. 拒绝删除出厂基准版本 ' + FALLBACK_DSH_VERSION, mgr.deleteCachedVersion(FALLBACK_DSH_VERSION).ok === false);
  check('D3. 拒绝目录穿越版本号', mgr.deleteCachedVersion('../../etc').ok === false);
  check('D4. 允许删除半成品归档', mgr.deleteCachedVersion('0.2.3-alpha.3').ok === true && !fs.existsSync(path.join(STORE, '0.2.3-alpha.3')));

  // E: GC 保留策略
  const baseDir = path.join(STORE, '0.2.3-alpha.2');
  fs.utimesSync(baseDir, new Date(Date.now() - 9000), new Date(Date.now() - 9000));
  for (const [v, ageMs] of [['0.2.6', 4000], ['0.2.7', 3000], ['0.2.8', 2000], ['0.2.9', 1000]]) {
    const dir = makeReady(v);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, t, t);
  }
  const gc = mgr.gcVersions({ keepN: 2, activeVersion: '0.2.6' });
  check('E1. GC 保留 keepN=2 (0.2.9, 0.2.8) + 活动 (0.2.6) + 出厂基准 (0.2.3-alpha.2) 并清理 0.2.7',
    gc.ok && fs.existsSync(path.join(STORE, '0.2.9')) && fs.existsSync(path.join(STORE, '0.2.8')) &&
    fs.existsSync(path.join(STORE, '0.2.6')) && fs.existsSync(path.join(STORE, '0.2.3-alpha.2')) &&
    !fs.existsSync(path.join(STORE, '0.2.7')));
  const gcDry = mgr.gcVersions({ keepN: 1, activeVersion: '0.2.6', dryRun: true });
  check('E2. dryRun 不落盘', fs.existsSync(path.join(STORE, '0.2.8')) && Array.isArray(gcDry.removed));

  // G: 磁盘水位预检
  const logs = [];
  let threwDisk = false;
  try { assertDiskSpace([STORE], 1024 ** 5, (m) => logs.push(m)); } catch (e) { threwDisk = e.errorCode === 'DSH_DISK_LOW'; }
  check('G1. 空间不足抛 DSH_DISK_LOW', threwDisk);
  assertDiskSpace([STORE], 1024, (m) => logs.push(m));
  check('G2. 空间充足通过预检', logs.some((l) => l.includes('磁盘水位检查通过')));

  // H: 并发保护
  mgr.installing = true;
  check('H. 安装进行中拒绝 GC 与删除', mgr.gcVersions({}).ok === false && mgr.deleteCachedVersion('0.2.9').ok === false);
  mgr.installing = false;

  // I: staging 残留清理
  const orphanOld = path.join(STORE, '.staging', 'orphan-old');
  fs.mkdirSync(orphanOld, { recursive: true });
  const oldT = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(orphanOld, oldT, oldT);
  const orphanFresh = path.join(STORE, '.staging', 'orphan-fresh');
  fs.mkdirSync(orphanFresh, { recursive: true });
  mgr.cleanupStagingOrphans();
  check('I. 清理过期 staging 保留新鲜 staging', !fs.existsSync(orphanOld) && fs.existsSync(orphanFresh));

  // J: v1.0.0 硬阻断与早期磁盘失败路径
  const rLegacy = await mgr.installVersion('0.2.2-rc.5');
  check('J1. installVersion 硬阻断低于 0.2.3-alpha.2 的旧引擎', rLegacy.ok === false && rLegacy.errorCode === 'DSH_ENGINE_UNSUPPORTED');
  const rBreak = await mgr.installVersion('0.3.0');
  check('J2. installVersion 硬阻断 >=0.3.0 破坏性版本', rBreak.ok === false && rBreak.errorCode === 'DSH_VERSION_BREAKING');

  const origStatfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0, blocks: 100, bsize: 4096 });
  let rLow;
  try { rLow = await mgr.installVersion('0.2.3-alpha.2'); } finally { fs.statfsSync = origStatfs; }
  check('J3. 磁盘不足早期中止返回 untouched=true 且复位 installing',
    rLow && rLow.ok === false && rLow.untouched === true && rLow.errorCode === 'DSH_DISK_LOW' && mgr.installing === false);

  // L: 原子置换 + EXDEV 降级
  writeCore(LIVE, '0.2.3-alpha.2');
  const stg1 = path.join(CORE_PARENT, '.dsh-staging-t1');
  writeCore(stg1, '0.2.4');
  const rb1 = atomicSwapCore(stg1);
  check('L1. atomicSwapCore 切到新版本并保留旧核心回滚点', verOf(LIVE) === '0.2.4' && verOf(rb1) === '0.2.3-alpha.2');
  restoreFromRollbackDir(rb1);
  check('L2. restoreFromRollbackDir 还原旧核心', verOf(LIVE) === '0.2.3-alpha.2' && !fs.existsSync(rb1));

  const realRename = fs.renameSync;
  let exdevHits = 0;
  fs.renameSync = function (from, to) {
    if (from === LIVE && exdevHits === 0) { exdevHits++; throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); }
    return realRename.apply(fs, arguments);
  };
  let rbEx = null;
  try {
    const stgEx = path.join(CORE_PARENT, '.dsh-staging-exdev');
    writeCore(stgEx, '0.2.5');
    rbEx = atomicSwapCore(stgEx);
  } finally { fs.renameSync = realRename; }
  check('L3. EXDEV 降级 cp+rm 仍成功置换并保留旧核心', exdevHits === 1 && verOf(LIVE) === '0.2.5' && verOf(rbEx) === '0.2.3-alpha.2');
  disposeRollbackDir(rbEx);

  // M: 回滚点单槽位治理 + 下限拦截 + 端到端还原与失败回退
  check('M1. 初始无回滚点', mgr.getRollbackPoint().exists === false);

  const tmpOldEngine = path.join(CORE_PARENT, '.dsh-rollback-tmp-legacy');
  writeCore(tmpOldEngine, '0.2.2-rc.5');
  promoteToPreservedRollback(tmpOldEngine, '0.2.2-rc.5');
  const pLegacy = mgr.getRollbackPoint();
  check('M2. 低于 0.2.3-alpha.2 的回滚点标记 supported=false, canRestore=false',
    pLegacy.exists === true && pLegacy.supported === false && pLegacy.canRestore === false);
  const rRestoreLegacy = await mgr.restoreRollbackPoint();
  check('M3. restoreRollbackPoint 拒绝还原旧引擎 (DSH_ENGINE_UNSUPPORTED)',
    rRestoreLegacy.ok === false && rRestoreLegacy.errorCode === 'DSH_ENGINE_UNSUPPORTED');

  const tmpValid = path.join(CORE_PARENT, '.dsh-rollback-tmp-valid');
  writeCore(tmpValid, '0.2.4');
  promoteToPreservedRollback(tmpValid, '0.2.4');
  const pValid = mgr.getRollbackPoint();
  check('M4. 轮替为合法 0.2.4 回滚点且槽位唯一',
    pValid.exists && pValid.version === '0.2.4' && pValid.supported && pValid.canRestore &&
    fs.readdirSync(CORE_PARENT).filter((n) => n.startsWith('.dsh-rollback-')).length === 1);

  // ABI 不匹配拒还原
  const readyPath = path.join(pValid.path, '.ready');
  const md = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
  md.nodeAbi = '99999';
  fs.writeFileSync(readyPath, JSON.stringify(md));
  check('M5. ABI 不匹配拒绝还原', mgr.getRollbackPoint().canRestore === false && (await mgr.restoreRollbackPoint()).errorCode === 'ROLLBACK_ABI_MISMATCH');
  md.nodeAbi = process.versions.modules;
  fs.writeFileSync(readyPath, JSON.stringify(md));

  // 端到端就地还原 + 失败回退
  writeCore(LIVE, '0.2.5');
  mgr.lastKnownVersion = '0.2.5';
  const origStop = mgr.stop;
  const origRestart = mgr.restart;
  mgr.stop = async () => ({ ok: true });
  mgr.restart = async () => ({ ok: true });
  const rOk = await mgr.restoreRollbackPoint();
  check('M6. 就地还原成功并将原核心轮替为新回滚点', rOk.ok === true && verOf(LIVE) === '0.2.4' && mgr.getRollbackPoint().version === '0.2.5');

  mgr.restart = async () => ({ ok: false });
  const rFail = await mgr.restoreRollbackPoint();
  check('M7. 还原后探活失败自动回退且保留原备件', rFail.ok === false && rFail.rolledBack === true && verOf(LIVE) === '0.2.4' && mgr.getRollbackPoint().version === '0.2.5');
  mgr.stop = origStop;
  mgr.restart = origRestart;

  check('M8. deleteRollbackPoint 成功清理回滚点', mgr.deleteRollbackPoint().ok === true && mgr.getRollbackPoint().exists === false);
} finally {
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.rmSync(CORE_PARENT, { recursive: true, force: true });
}

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
if (fail > 0) { console.log('失败项:\n - ' + failures.join('\n - ')); process.exit(1); }
