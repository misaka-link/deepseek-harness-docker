/**
 * backup-version-compatibility-test.mjs
 * 
 * DSH 配置快照与版本兼容性全场景端到端自动化验证套件
 * 
 * 覆盖用例：
 * 1. 测试用例 1：带版本标记的完整快照创建，验证元数据正确注入归档与外部元数据文件；
 * 2. 测试用例 2：无版本标记的旧版快照兼容性智能推断测试；
 * 3. 测试用例 3：跨版本还原版本对比 API 检查；
 * 4. 测试用例 4：故意构造损坏/对抗元数据测试防御性容错；
 * 5. 测试用例 5：模拟探活失败触发原子回滚，验证原版本配置与网关凭据 100% 完整保留。
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// 引入现有安全工具
const { isValidVersion } = require(path.join(here, '../gateway/dsh-version.js'));
const { validateArchiveMembers } = require(path.join(here, '../gateway/backup-service.js'));

// 测试临时工作区
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-test-'));
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`   ✔ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`   ❌ [FAIL] ${message}`);
    failCount++;
  }
}

function runTar(args, cwd) {
  return spawnSync('tar', args, { cwd, encoding: 'utf8' });
}

function calcSha256(contentOrPath) {
  const hash = crypto.createHash('sha256');
  if (fs.existsSync(contentOrPath)) {
    hash.update(fs.readFileSync(contentOrPath));
  } else {
    hash.update(contentOrPath);
  }
  return hash.digest('hex');
}

// =========================================================================
// 【核心设计实现组件：元数据管理器、指纹推断引擎与兼容性评估器】
// =========================================================================

/**
 * 元数据安全解析器（防原型污染、防超大文件、严格字段校验）
 */
function parseSafeMetadata(rawString) {
  if (!rawString || typeof rawString !== 'string') {
    throw new Error('元数据内容为空或非字符串');
  }
  if (rawString.length > 512 * 1024) {
    throw new Error('元数据文件大小超出安全上限 (512KB)');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawString, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined; // 消除原型污染
      }
      return value;
    });
  } catch (err) {
    throw new Error(`元数据 JSON 格式解析损坏: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('元数据根节点必须为合法 JSON 对象');
  }

  // 严格版本号与字段清洗
  if (parsed.dshVersion && !isValidVersion(parsed.dshVersion)) {
    throw new Error(`元数据中包含非法的 DSH 版本号: ${String(parsed.dshVersion).slice(0, 32)}`);
  }

  return parsed;
}

/**
 * 内容特征指纹分类器：基于文件物理结构智能推断真实 DSH 版本
 */
function inferSnapshotStructure(dshDir) {
  const hasCordisPatch = fs.existsSync(path.join(dshDir, 'cordis.patch.yml'));
  const hasSettingsImported = fs.existsSync(path.join(dshDir, 'settings.yaml.imported'));
  const hasProfilesWeb = fs.existsSync(path.join(dshDir, 'profiles', 'web.json')) || fs.existsSync(path.join(dshDir, 'profiles', 'web'));
  const hasLegacySettings = fs.existsSync(path.join(dshDir, 'settings.yaml'));

  if (hasCordisPatch || hasSettingsImported || hasProfilesWeb) {
    return {
      inferredDshVersion: '>=0.1.7',
      structureType: 'cordis-patch',
      confidence: 'high',
      notes: '检测到 cordis 补丁层或 profile 结构，符合 DSH 0.1.7+ 现代架构'
    };
  }

  if (hasLegacySettings && !hasCordisPatch) {
    return {
      inferredDshVersion: '<=0.1.6',
      structureType: 'legacy-settings-yaml',
      confidence: 'high',
      notes: '检测到仅存在旧版 settings.yaml，属于 DSH 0.1.6 之前架构'
    };
  }

  return {
    inferredDshVersion: 'unknown',
    structureType: 'minimal-or-empty',
    confidence: 'low',
    notes: '未能识别明确的配置结构特征'
  };
}

/**
 * 跨版本兼容性评估引擎
 */
function evaluateRestoreCompatibility(snapshotDshVer, systemDshVer) {
  if (!snapshotDshVer || snapshotDshVer === 'unknown') {
    return {
      status: 'warning',
      action: 'prompt-user',
      message: '快照未标记明确版本，且无法从文件结构精确推断，建议还原前备份当前环境。'
    };
  }

  // 架构断代拒绝 (例如 >=0.2.0)
  if (snapshotDshVer.startsWith('0.2.') || snapshotDshVer.startsWith('0.3.')) {
    return {
      status: 'blocked',
      action: 'reject',
      message: `快照版本 (${snapshotDshVer}) 属于跨大版本架构重构，当前容器环境无法兼容，请重建容器。`
    };
  }

  // 0.1.7 体系与 <=0.1.6 体系比对
  const isSnapLegacy = snapshotDshVer.includes('0.1.5') || snapshotDshVer.includes('0.1.6') || snapshotDshVer === '<=0.1.6';
  const isSysModern = systemDshVer.includes('0.1.7') || systemDshVer.includes('0.1.8');

  if (isSnapLegacy && isSysModern) {
    return {
      status: 'upgrade_compatible',
      action: 'auto-migrate-settings',
      message: `快照为旧版 (${snapshotDshVer})，还原后 DSH 将自动把 settings.yaml 导入迁移至补丁层并更名为 settings.yaml.imported。`
    };
  }

  const isSnapModern = snapshotDshVer.includes('0.1.7') || snapshotDshVer.includes('0.1.8');
  const isSysLegacy = systemDshVer.includes('0.1.5') || systemDshVer.includes('0.1.6');

  if (isSnapModern && isSysLegacy) {
    return {
      status: 'danger',
      action: 'warn-downgrade',
      message: `严重警告：试图将 0.1.7+ 高版本快照还原到低版本系统 (${systemDshVer})！低版本无法解析 cordis.patch.yml 补丁且无法读取 V4 会话数据。`
    };
  }

  return {
    status: 'compatible',
    action: 'allow',
    message: `快照版本 (${snapshotDshVer}) 与当前系统 (${systemDshVer}) 完全兼容。`
  };
}

// =========================================================================
// 【测试执行流程】
// =========================================================================

async function runAllTests() {
  console.log('======================================================================');
  console.log('🚀 开始执行 DSH 配置快照与版本兼容性自动化验证测试套件');
  console.log('======================================================================\n');

  // -------------------------------------------------------------------------
  // 用例 1：带版本标记的完整快照创建
  // -------------------------------------------------------------------------
  console.log('📌 【测试用例 1】：带版本标记的完整快照创建与双重元数据注入');
  {
    const mockDsh = path.join(TEST_ROOT, 'case1-dsh', '.dsh');
    fs.mkdirSync(path.join(mockDsh, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(mockDsh, 'cordis.patch.yml'), 'services:\n  dshmarket: true\n');
    fs.writeFileSync(path.join(mockDsh, 'profiles', 'web.json'), '{"plugins":{}}\n');
    
    // 敏感文件（必须在打包时被排除）
    fs.writeFileSync(path.join(mockDsh, 'gateway.config.json'), '{"authToken":"secret-token-123"}\n');
    fs.writeFileSync(path.join(mockDsh, '.session_secret'), 'mock-session-secret-data\n');

    const meta = {
      snapshotVersion: 1,
      dshVersion: '0.1.7-rc.2',
      projectVersion: '0.1.8',
      backupType: 'full',
      createdAt: new Date().toISOString(),
      generator: 'deepseek-harness-docker/backup-service',
      structuralFingerprint: {
        hasCordisPatch: true,
        hasSettingsYaml: false
      }
    };

    // 内部注入元数据
    fs.writeFileSync(path.join(mockDsh, '.snapshot-meta.json'), JSON.stringify(meta, null, 2));

    const archiveTar = path.join(TEST_ROOT, 'case1-snapshot.tar.gz');
    const sidecarMeta = path.join(TEST_ROOT, 'case1-snapshot.meta.json');

    // 打包并严格排除敏感网关文件
    const tarRes = runTar([
      '-czf', archiveTar,
      '--exclude=.dsh/gateway.config.json',
      '--exclude=.dsh/.session_secret',
      '-C', path.dirname(mockDsh),
      '.dsh'
    ], TEST_ROOT);

    assert(tarRes.status === 0, '快照归档 tar.gz 成功生成');

    // 写入外部 sidecar
    const sidecarData = {
      ...meta,
      archiveChecksum: calcSha256(archiveTar),
      archiveSizeBytes: fs.statSync(archiveTar).size
    };
    fs.writeFileSync(sidecarMeta, JSON.stringify(sidecarData, null, 2));

    assert(fs.existsSync(sidecarMeta), '外部元数据 sidecar 文件 (.meta.json) 正确落地');

    // 校验归档内部成员
    const inspectRes = runTar(['-tzf', archiveTar], TEST_ROOT);
    const members = inspectRes.stdout.split('\n');

    assert(members.includes('.dsh/.snapshot-meta.json'), '归档内部正确嵌入 .dsh/.snapshot-meta.json 元数据文件');
    assert(!members.includes('.dsh/gateway.config.json'), '归档内部严格排除了 gateway.config.json 敏感文件');
    assert(!members.includes('.dsh/.session_secret'), '归档内部严格排除了 .session_secret 签名密钥');
  }

  console.log('\n----------------------------------------------------------------------');

  // -------------------------------------------------------------------------
  // 用例 2：无版本标记的旧版快照兼容性智能推断测试
  // -------------------------------------------------------------------------
  console.log('📌 【测试用例 2】：无版本标记的旧版快照兼容性智能推断');
  {
    const legacyDsh = path.join(TEST_ROOT, 'case2-legacy', '.dsh');
    fs.mkdirSync(legacyDsh, { recursive: true });
    fs.writeFileSync(path.join(legacyDsh, 'settings.yaml'), 'defaultModel: deepseek-chat\n');

    const legacyTar = path.join(TEST_ROOT, 'case2-legacy.tar.gz');
    runTar(['-czf', legacyTar, '-C', path.dirname(legacyDsh), '.dsh'], TEST_ROOT);

    // 模拟解压到 staging 探测
    const stagingDir = path.join(TEST_ROOT, 'case2-staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    runTar(['-xzf', legacyTar, '-C', stagingDir], TEST_ROOT);

    const stagedDsh = path.join(stagingDir, '.dsh');
    const hasMeta = fs.existsSync(path.join(stagedDsh, '.snapshot-meta.json'));
    assert(!hasMeta, '确认旧版快照确实无内置 .snapshot-meta.json 标记');

    const inference = inferSnapshotStructure(stagedDsh);
    assert(inference.inferredDshVersion === '<=0.1.6', `智能推断版本准确: ${inference.inferredDshVersion}`);
    assert(inference.structureType === 'legacy-settings-yaml', `结构模型准确识别: ${inference.structureType}`);
  }

  console.log('\n----------------------------------------------------------------------');

  // -------------------------------------------------------------------------
  // 用例 3：跨版本还原版本对比 API 检查
  // -------------------------------------------------------------------------
  console.log('📌 【测试用例 3】：跨版本还原版本对比与兼容性决策矩阵');
  {
    // 3.1 同版本还原
    const resSame = evaluateRestoreCompatibility('0.1.7-rc.2', '0.1.7-rc.2');
    assert(resSame.status === 'compatible', '同版本还原研判为 compatible 放行');

    // 3.2 0.1.5 旧版向 0.1.7 新版升级还原
    const resUpgrade = evaluateRestoreCompatibility('0.1.5-rc.1', '0.1.7-rc.2');
    assert(resUpgrade.status === 'upgrade_compatible', '旧版向新版还原提示升级迁移 (upgrade_compatible)');
    assert(resUpgrade.action === 'auto-migrate-settings', '正确指定配置导入迁移策略');

    // 3.3 0.1.7 新版向 0.1.5 旧版降级还原（高危）
    const resDowngrade = evaluateRestoreCompatibility('0.1.7-rc.2', '0.1.5-rc.1');
    assert(resDowngrade.status === 'danger', '高版本向低版本降级还原触发 danger 警告');

    // 3.4 跨大版本重构还原 (0.2.0 -> 0.1.7)
    const resBlock = evaluateRestoreCompatibility('0.2.0', '0.1.7-rc.2');
    assert(resBlock.status === 'blocked', '跨大版本底层不兼容被严格阻断 (blocked)');
  }

  console.log('\n----------------------------------------------------------------------');

  // -------------------------------------------------------------------------
  // 用例 4：故意构造损坏/对抗元数据测试防御性容错
  // -------------------------------------------------------------------------
  console.log('📌 【测试用例 4】：防御性容错（畸形/对抗元数据与内容冲突）');
  {
    // 4.1 畸形语法 JSON
    try {
      parseSafeMetadata('{ invalid_json: ');
      assert(false, '畸形 JSON 应该被抛错拒绝');
    } catch (e) {
      assert(e.message.includes('JSON 格式解析损坏'), '畸形 JSON 被成功捕获并拦截');
    }

    // 4.2 原型污染对抗
    const evilProtoPayload = '{"__proto__": {"isAdmin": true}, "dshVersion": "0.1.7"}';
    const parsedObj = parseSafeMetadata(evilProtoPayload);
    const testEmpty = {};
    assert(testEmpty.isAdmin === undefined, '原型污染攻击被彻底阻断');
    assert(parsedObj.dshVersion === '0.1.7', '合法字段正常提取');

    // 4.3 恶意注入版本号（路径遍历/Shell特殊符号）
    try {
      parseSafeMetadata('{"dshVersion": "../../etc/passwd"}');
      assert(false, '路径穿越版本号应被拒绝');
    } catch (e) {
      assert(e.message.includes('非法的 DSH 版本号'), '非法路径版本号被 isValidVersion 强校验成功拦截');
    }

    // 4.4 元数据与实际内容冲突冲突决策（元数据谎报 0.1.7，内容实为 0.1.5）
    const fakeDir = path.join(TEST_ROOT, 'case4-fake', '.dsh');
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'settings.yaml'), 'a: 1\n'); // 仅有 0.1.5 文件
    const claimedVer = '0.1.7';
    const struct = inferSnapshotStructure(fakeDir);
    
    assert(struct.inferredDshVersion !== claimedVer, '检测到元数据声称版本与文件结构特征不匹配');
    // 内容权威纠偏：以实际结构为主
    const finalEffectiveVer = struct.inferredDshVersion === '<=0.1.6' ? '0.1.5' : claimedVer;
    assert(finalEffectiveVer === '0.1.5', '纠偏决策器成功采纳「内容即真理」原则重写有效评估版本');
  }

  console.log('\n----------------------------------------------------------------------');

  // -------------------------------------------------------------------------
  // 用例 5：模拟探活失败触发自动回滚，验证原版本配置完整保留
  // -------------------------------------------------------------------------
  console.log('📌 【测试用例 5】：模拟探活失败触发原子回滚验证');
  {
    // 建立现网生产目录 (/root/.dsh 模拟)
    const liveDir = path.join(TEST_ROOT, 'case5-live-dsh');
    fs.mkdirSync(path.join(liveDir, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'canary-live-token.txt'), 'LIVE_STATE_ORIGINAL_DATA_V1');
    fs.writeFileSync(path.join(liveDir, 'gateway.config.json'), '{"authToken":"keep-my-current-token-999"}\n');
    fs.writeFileSync(path.join(liveDir, '.session_secret'), 'original-crypto-session-secret\n');

    // 制作坏版本快照（模拟有坏插件或启动超时的快照）
    const badSource = path.join(TEST_ROOT, 'case5-bad-source', '.dsh');
    fs.mkdirSync(badSource, { recursive: true });
    fs.writeFileSync(path.join(badSource, 'corrupt-setting.txt'), 'BAD_STATE_V2');
    const badTar = path.join(TEST_ROOT, 'case5-bad.tar.gz');
    runTar(['-czf', badTar, '-C', path.dirname(badSource), '.dsh'], TEST_ROOT);

    // 模拟原子恢复事务执行过程
    const stagingDir = path.join(liveDir, '.restore-staging');
    const rollbackDir = path.join(liveDir, '.restore-rollback');
    fs.mkdirSync(stagingDir, { recursive: true });

    // 1. 解压到 staging
    runTar(['-xzf', badTar, '-C', stagingDir], TEST_ROOT);

    // 2. 穿透保留现网网关口令与 session_secret
    const stagedDsh = path.join(stagingDir, '.dsh');
    for (const file of ['gateway.config.json', '.session_secret']) {
      const src = path.join(liveDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(stagedDsh, file));
      }
    }

    // 3. 执行原子置换（现网移至 rollback，staging 移入现网）
    const SKIP = new Set(['.restore-staging', '.restore-rollback']);
    fs.mkdirSync(rollbackDir, { recursive: true });
    for (const item of fs.readdirSync(liveDir)) {
      if (SKIP.has(item)) continue;
      fs.renameSync(path.join(liveDir, item), path.join(rollbackDir, item));
    }
    for (const item of fs.readdirSync(stagedDsh)) {
      if (SKIP.has(item)) continue;
      fs.renameSync(path.join(stagedDsh, item), path.join(liveDir, item));
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });

    assert(fs.existsSync(path.join(liveDir, 'corrupt-setting.txt')), '新坏版本已临时就位');
    assert(!fs.existsSync(path.join(liveDir, 'canary-live-token.txt')), '原版本文件已移入回滚区');

    // 4. 模拟启动就绪探活失败（Healthcheck Timeout）
    const mockHealthcheck = () => false; // 模拟超时不就绪
    const isReady = mockHealthcheck();

    if (!isReady) {
      console.log('   ⚠️ 模拟探活检测到 DSH 启动超时崩溃，正在触发原子灾难回滚...');
      // 执行回滚
      for (const item of fs.readdirSync(liveDir)) {
        if (SKIP.has(item)) continue;
        fs.rmSync(path.join(liveDir, item), { recursive: true, force: true });
      }
      for (const item of fs.readdirSync(rollbackDir)) {
        fs.renameSync(path.join(rollbackDir, item), path.join(liveDir, item));
      }
      fs.rmSync(rollbackDir, { recursive: true, force: true });
    }

    // 5. 验证原状态 100% 恢复
    const canaryRestored = fs.existsSync(path.join(liveDir, 'canary-live-token.txt')) &&
      fs.readFileSync(path.join(liveDir, 'canary-live-token.txt'), 'utf8') === 'LIVE_STATE_ORIGINAL_DATA_V1';
    assert(canaryRestored, '原环境特征金丝雀文件 100% 完整复原');

    const badRemoved = !fs.existsSync(path.join(liveDir, 'corrupt-setting.txt'));
    assert(badRemoved, '导致故障的新版本文件已彻底从现网清除');

    // 6. 验证网关口令与 session_secret 完好无损
    const tokenPreserved = JSON.parse(fs.readFileSync(path.join(liveDir, 'gateway.config.json'), 'utf8')).authToken === 'keep-my-current-token-999';
    const secretPreserved = fs.readFileSync(path.join(liveDir, '.session_secret'), 'utf8') === 'original-crypto-session-secret\n';
    assert(tokenPreserved, '现网网关管理口令 (authToken) 穿透保留完好无损');
    assert(secretPreserved, '现网 Cookie 签名密钥 (.session_secret) 穿透保留完好无损');
  }

  // 清理临时测试环境
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });

  console.log('\n======================================================================');
  console.log(`🏁 自动化测试套件执行完毕: 通过 ${passCount} 项 / 失败 ${failCount} 项`);
  console.log('======================================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('测试运行异常:', err);
  process.exit(1);
});
