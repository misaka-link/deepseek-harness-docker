#!/usr/bin/env node
/**
 * DSH 配置快照与版本兼容性端到端单测。
 * 用法: node tests/unit/backup-version-compatibility.test.mjs
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
const root = path.resolve(here, '../..');

const { isValidVersion } = require(path.join(root, 'gateway/src/dsh/dsh-version.js'));
const { validateArchiveMembers } = require(path.join(root, 'gateway/src/backup/index.js'));

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
  hash.update(fs.existsSync(contentOrPath) ? fs.readFileSync(contentOrPath) : contentOrPath);
  return hash.digest('hex');
}

function parseSafeMetadata(rawString) {
  if (!rawString || typeof rawString !== 'string') throw new Error('元数据内容为空或非字符串');
  if (rawString.length > 512 * 1024) throw new Error('元数据文件大小超出安全上限');
  let parsed;
  try {
    parsed = JSON.parse(rawString, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });
  } catch (err) {
    throw new Error(`元数据 JSON 格式解析损坏: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('元数据根节点必须为合法 JSON 对象');
  }
  if (parsed.dshVersion && !isValidVersion(parsed.dshVersion)) {
    throw new Error(`元数据中包含非法的 DSH 版本号: ${String(parsed.dshVersion).slice(0, 32)}`);
  }
  return parsed;
}

function inferSnapshotStructure(dshDir) {
  const hasCordisPatch = fs.existsSync(path.join(dshDir, 'cordis.patch.yml'));
  const hasSettingsImported = fs.existsSync(path.join(dshDir, 'settings.yaml.imported'));
  const hasProfilesWeb = fs.existsSync(path.join(dshDir, 'profiles', 'web.json')) || fs.existsSync(path.join(dshDir, 'profiles', 'web'));
  const hasLegacySettings = fs.existsSync(path.join(dshDir, 'settings.yaml'));

  if (hasCordisPatch || hasSettingsImported || hasProfilesWeb) {
    return { inferredDshVersion: '>=0.1.7', structureType: 'cordis-patch', confidence: 'high' };
  }
  if (hasLegacySettings && !hasCordisPatch) {
    return { inferredDshVersion: '<=0.1.6', structureType: 'legacy-settings-yaml', confidence: 'high' };
  }
  return { inferredDshVersion: 'unknown', structureType: 'minimal-or-empty', confidence: 'low' };
}

async function runAllTests() {
  try {
    console.log('\n=== 1. 带版本标记快照与敏感文件排除 ===');
    const mockDsh = path.join(TEST_ROOT, 'case1-dsh', '.dsh');
    fs.mkdirSync(path.join(mockDsh, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(mockDsh, 'cordis.patch.yml'), 'services:\n  dshmarket: true\n');
    fs.writeFileSync(path.join(mockDsh, 'gateway.config.json'), '{"authToken":"secret"}\n');
    fs.writeFileSync(path.join(mockDsh, '.session_secret'), 'secret\n');
    const meta = { snapshotVersion: 1, dshVersion: '0.2.3-alpha.2', projectVersion: '1.0.0', backupType: 'full' };
    fs.writeFileSync(path.join(mockDsh, '.snapshot-meta.json'), JSON.stringify(meta, null, 2));

    const archiveTar = path.join(TEST_ROOT, 'case1.tar.gz');
    const tarRes = runTar([
      '-czf', archiveTar,
      '--exclude=.dsh/gateway.config.json',
      '--exclude=.dsh/.session_secret',
      '-C', path.dirname(mockDsh), '.dsh'
    ], TEST_ROOT);
    assert(tarRes.status === 0, '快照归档 tar.gz 成功生成');
    assert(calcSha256(archiveTar).length === 64, '归档 SHA-256 计算正常');
    const validated = await validateArchiveMembers(archiveTar);
    assert(validated.members >= 3, '归档通过成员白名单预检');
    const members = runTar(['-tzf', archiveTar], TEST_ROOT).stdout.split('\n');
    assert(members.includes('.dsh/.snapshot-meta.json'), '包含 .snapshot-meta.json');
    assert(!members.includes('.dsh/gateway.config.json'), '排除 gateway.config.json');
    assert(!members.includes('.dsh/.session_secret'), '排除 .session_secret');

    console.log('\n=== 2. 无版本标记旧快照结构智能推断 ===');
    const legacyDsh = path.join(TEST_ROOT, 'case2', '.dsh');
    fs.mkdirSync(legacyDsh, { recursive: true });
    fs.writeFileSync(path.join(legacyDsh, 'settings.yaml'), 'defaultModel: deepseek-chat\n');
    const inference = inferSnapshotStructure(legacyDsh);
    assert(inference.inferredDshVersion === '<=0.1.6', '识别为 <=0.1.6 架构');
    assert(inference.structureType === 'legacy-settings-yaml', '识别为 legacy-settings-yaml');

    console.log('\n=== 3. 防御性元数据解析 ===');
    let badJson = false;
    try { parseSafeMetadata('{ broken'); } catch (e) { badJson = e.message.includes('JSON 格式解析损坏'); }
    assert(badJson, '畸形 JSON 被拦截');

    const obj = parseSafeMetadata('{"__proto__": {"isAdmin": true}, "dshVersion": "0.2.3-alpha.2"}');
    assert(({}).isAdmin === undefined && obj.dshVersion === '0.2.3-alpha.2', '阻断原型污染并提取合法版本');

    let badVer = false;
    try { parseSafeMetadata('{"dshVersion": "../../etc/passwd"}'); } catch (e) { badVer = e.message.includes('非法的 DSH 版本号'); }
    assert(badVer, '路径穿越版本号被 isValidVersion 拦截');
  } finally {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }

  console.log(`\n===== 汇总: 通过 ${passCount} / 失败 ${failCount} =====`);
  process.exit(failCount > 0 ? 1 : 0);
}

runAllTests().catch((err) => { console.error('测试异常:', err); process.exit(1); });
