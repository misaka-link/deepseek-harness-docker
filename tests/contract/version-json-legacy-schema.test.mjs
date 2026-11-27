#!/usr/bin/env node
/**
 * version-json-legacy-schema.test.mjs — Dual-schema compatibility contract for version.json.
 *
 * Verifies:
 *   1) Frozen legacy `compatibility` block in version.json still parses cleanly under the exact
 *      v0.2.16 `evaluateTargetVersion` algorithm (neither 0.2.3-alpha.2 nor 0.2.2-rc.5 becomes danger).
 *   2) v1.0.0 `version-service.js` reads `compatibilityV1` and enforces hard ENGINE_FLOOR >= 0.2.3-alpha.2
 *      (even if a remote meta tries to lower minDsh).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const versionJson = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
const versionService = require(path.join(root, 'gateway/src/dsh/version-service.js'));
const { matchSemverPattern } = require(path.join(root, 'gateway/src/core/semver.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log('   ✔ ' + name);
    pass++;
  } catch (err) {
    console.log('   ❌ ' + name + '  → ' + (err && err.message));
    fail++;
  }
}

/** Exact v0.2.16 evaluator reading legacy version.json#compatibility block. */
function evaluateLegacyV0216(targetVersion, meta) {
  const rules = (meta.compatibility && meta.compatibility.rules) || [];
  const adapted = (meta.compatibility && meta.compatibility.adaptedVersions) || [];
  const isAdapted = adapted.includes(targetVersion);
  const severityWeights = { danger: 3, warning: 2, info: 1 };
  const sortedRules = [...rules].sort((a, b) => (severityWeights[b.level] || 0) - (severityWeights[a.level] || 0));

  for (const rule of sortedRules) {
    if (matchSemverPattern(targetVersion, rule.pattern)) {
      return {
        level: rule.level || 'warning',
        title: rule.title || '版本兼容性提示',
        message: rule.message || '',
        action: rule.action || 'confirm',
        isAdapted
      };
    }
  }
  if (!isAdapted) {
    return { level: 'warning', action: 'confirm', isAdapted: false };
  }
  return { level: 'success', action: 'online-switch', isAdapted: true };
}

console.log('\n=== A. 存量 v0.2.16 容器拉取本仓 version.json 的前向兼容契约 ===');
check('version.json 同时包含 legacy compatibility 块与 compatibilityV1 块', () => {
  assert.ok(versionJson.compatibility && Array.isArray(versionJson.compatibility.adaptedVersions));
  assert.ok(versionJson.compatibilityV1 && versionJson.compatibilityV1.schema === 1);
});

check('v0.2.16 解析器将 0.2.3-alpha.2 判定为 success（绝不误报 danger）', () => {
  const res = evaluateLegacyV0216('0.2.3-alpha.2', versionJson);
  assert.equal(res.level, 'success');
  assert.equal(res.isAdapted, true);
});

check('v0.2.16 解析器将 0.2.2-rc.5 判定为 success（绝不误报 danger）', () => {
  const res = evaluateLegacyV0216('0.2.2-rc.5', versionJson);
  assert.equal(res.level, 'success');
  assert.equal(res.isAdapted, true);
});

check('v0.2.16 解析器仍将 >=0.3.0 判定为 danger (force-docker-pull)', () => {
  const res = evaluateLegacyV0216('0.3.0', versionJson);
  assert.equal(res.level, 'danger');
  assert.equal(res.action, 'force-docker-pull');
});

console.log('\n=== B. v1.0.0 version-service 引擎下限硬门槛契约 ===');
check('ENGINE_FLOOR 固定为 0.2.3-alpha.2', () => {
  assert.equal(versionService.ENGINE_FLOOR, '0.2.3-alpha.2');
});

check('所有低于 0.2.3-alpha.2 的旧引擎均返回 danger + engine-unsupported + blocked-legacy', () => {
  for (const oldVer of ['0.2.3-alpha.1', '0.2.2-rc.5', '0.2.2-rc.1', '0.1.7-rc.2', '0.1.2-rc.1']) {
    const res = versionService.evaluateTargetVersion(oldVer, versionJson);
    assert.equal(res.level, 'danger', `${oldVer} level should be danger`);
    assert.equal(res.kind, 'engine-unsupported', `${oldVer} kind should be engine-unsupported`);
    assert.equal(res.action, 'blocked-legacy', `${oldVer} action should be blocked-legacy`);
  }
});

check('0.2.3-alpha.2 判定为 success + adapted；更高 0.2.x 未收录版本判定为 warning + unadapted', () => {
  const adapted = versionService.evaluateTargetVersion('0.2.3-alpha.2', versionJson);
  assert.equal(adapted.level, 'success');
  assert.equal(adapted.kind, 'adapted');
  assert.equal(adapted.isAdapted, true);

  const futureMinor = versionService.evaluateTargetVersion('0.2.4', versionJson);
  assert.equal(futureMinor.level, 'warning');
  assert.equal(futureMinor.kind, 'unadapted');
  assert.equal(futureMinor.isAdapted, false);
});

check('>=0.3.0 判定为 danger + breaking-major + force-docker-pull', () => {
  const res = versionService.evaluateTargetVersion('0.3.0', versionJson);
  assert.equal(res.level, 'danger');
  assert.equal(res.kind, 'breaking-major');
  assert.equal(res.action, 'force-docker-pull');
});

check('远端元数据试图放宽 minDsh 至 0.1.2-rc.1 时，代码硬下限仍强制拦截 0.2.2-rc.5', () => {
  const tamperedMeta = {
    compatibilityV1: {
      schema: 1,
      minDsh: '0.1.2-rc.1',
      adaptedVersions: ['0.2.3-alpha.2', '0.2.2-rc.5'],
      rules: []
    }
  };
  const res = versionService.evaluateTargetVersion('0.2.2-rc.5', tamperedMeta);
  assert.equal(res.level, 'danger');
  assert.equal(res.kind, 'engine-unsupported');
});

check('远端元数据收紧 minDsh 至 0.2.4 时生效（只可收紧不可放松）', () => {
  const tightenedMeta = {
    compatibilityV1: {
      schema: 1,
      minDsh: '0.2.4',
      adaptedVersions: ['0.2.4'],
      rules: []
    }
  };
  const res = versionService.evaluateTargetVersion('0.2.3-alpha.2', tightenedMeta);
  assert.equal(res.level, 'danger');
  assert.equal(res.kind, 'engine-unsupported');
});

console.log('\n────────────────────────────────────────');
console.log(
  fail === 0
    ? `✅ version-json-legacy-schema 契约通过（${pass}/${pass + fail}）`
    : `❌ version-json-legacy-schema 契约失败：${fail} 项`
);
process.exit(fail === 0 ? 0 : 1);
