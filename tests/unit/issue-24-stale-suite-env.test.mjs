#!/usr/bin/env node
/**
 * issue-24-stale-suite-env.test.mjs — Regression test for Issue #24:
 * Container recreation tools (dpanel / Portainer recreate) clone `Config.Env` from
 * the old container, leaving a stale `DSH_SUITE_VERSION` (e.g. `0.2.15`) inside a
 * new `1.0.0` container image.
 *
 * Verifies:
 *   1) Cross-validation rejects stale `DSH_SUITE_VERSION` when it disagrees with
 *      image-baked `gateway/package.json#version` (or `version.json#latest.version`),
 *      adopting the image version instead of falsely reporting "Update Available".
 *   2) `describeProjectVersion()` exposes `versionMismatch`, `envConflict`,
 *      `envVersion`, `imageVersion`, and per-source `conflict: boolean`.
 *   3) `/admin/api/status`, `/admin/api/version/check`, `/healthz`, and snapshot
 *      metadata (`backup/state.js#getCurrentProjectVersion()`) all reflect the
 *      cross-validated image version while surfacing `versionMismatch: true`.
 *   4) Clean container recreation (`DSH_SUITE_VERSION === package.json`) clears
 *      `versionMismatch` and `conflict` back to `false`.
 *   5) Fallback when both image files are unreadable still accepts valid ENV, and
 *      returns `null` when all three sources are unavailable.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const gatewayPkg = JSON.parse(fs.readFileSync(path.join(root, 'gateway/package.json'), 'utf8'));
const IMAGE_VER = gatewayPkg.version;
const STALE_ENV_VER = IMAGE_VER === '0.2.15' ? '0.2.14' : '0.2.15';

const pv = require(path.join(root, 'gateway/src/core/project-version.js'));
const versionService = require(path.join(root, 'gateway/src/dsh/version-service.js'));
const backupState = require(path.join(root, 'gateway/src/backup/state.js'));
const { createApp } = require(path.join(root, 'gateway/src/bootstrap.js'));
const { computeCapabilities } = require(path.join(root, 'gateway/src/core/capabilities.js'));

const savedEnv = process.env.DSH_SUITE_VERSION;
function restoreEnv() {
  if (savedEnv === undefined) delete process.env.DSH_SUITE_VERSION;
  else process.env.DSH_SUITE_VERSION = savedEnv;
  pv.resetWarnings();
}

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('   ✔ ' + name);
    pass++;
  } catch (err) {
    console.log('   ❌ ' + name + '  → ' + (err && err.stack ? err.message : String(err)));
    fail++;
  } finally {
    restoreEnv();
  }
}

function withCapturedWarnings(fn) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = origWarn;
  }
}

function rawRequest(port, reqPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

console.log('\n=== Issue #24 回归测试：陈旧容器 ENV DSH_SUITE_VERSION 交叉校验与告警 ===');

await test('1) 克隆旧容器遗留陈旧 DSH_SUITE_VERSION 时降级采用镜像内 package.json 版本并标记 conflict', () => {
  process.env.DSH_SUITE_VERSION = STALE_ENV_VER;
  pv.resetWarnings();

  const { result: desc, warnings } = withCapturedWarnings(() => pv.describeProjectVersion());
  assert.equal(desc.version, IMAGE_VER);
  assert.equal(pv.resolveProjectVersion(), IMAGE_VER);
  assert.equal(desc.versionMismatch, true);
  assert.equal(desc.envConflict, true);
  assert.equal(desc.envVersion, STALE_ENV_VER);
  assert.equal(desc.imageVersion, IMAGE_VER);

  const envSrc = desc.sources.find((s) => s.source === 'env');
  const pkgSrc = desc.sources.find((s) => s.source === 'package.json');
  const verSrc = desc.sources.find((s) => s.source === 'version.json');

  assert.deepEqual(envSrc, {
    source: 'env',
    label: '${DSH_SUITE_VERSION}',
    raw: STALE_ENV_VER,
    valid: true,
    adopted: false,
    conflict: true
  });
  assert.equal(pkgSrc.adopted, true);
  assert.equal(pkgSrc.conflict, false);
  assert.equal(verSrc.adopted, true);
  assert.equal(verSrc.conflict, false);

  assert.equal(warnings.length, 1, 'mismatch warning should be emitted once');
  assert.ok(warnings[0].includes(`DSH_SUITE_VERSION=${STALE_ENV_VER}`));
  assert.ok(warnings[0].includes('force-recreate'));
});

await test('2) 反向回退镜像（容器遗留更高版本 ENV）同样采信镜像内真实版本', () => {
  process.env.DSH_SUITE_VERSION = '99.0.0';
  pv.resetWarnings();
  const { result: desc } = withCapturedWarnings(() => pv.describeProjectVersion());
  assert.equal(desc.version, IMAGE_VER);
  assert.equal(desc.versionMismatch, true);
  assert.equal(desc.envConflict, true);
  assert.equal(desc.envVersion, '99.0.0');
  assert.equal(desc.imageVersion, IMAGE_VER);
});

await test('3) docker compose up -d --force-recreate 后 ENV 与镜像一致，冲突状态消除', () => {
  process.env.DSH_SUITE_VERSION = IMAGE_VER;
  pv.resetWarnings();
  const { result: desc, warnings } = withCapturedWarnings(() => pv.describeProjectVersion());
  assert.equal(desc.version, IMAGE_VER);
  assert.equal(desc.versionMismatch, false);
  assert.equal(desc.envConflict, false);
  assert.equal(warnings.length, 0);
  for (const s of desc.sources) {
    assert.equal(s.adopted, true);
    assert.equal(s.conflict, false);
  }
});

await test('4) 快照 sidecar 元数据读取 (backup/state.js) 不被陈旧 ENV 污染', () => {
  process.env.DSH_SUITE_VERSION = STALE_ENV_VER;
  pv.resetWarnings();
  const { result: snapVer } = withCapturedWarnings(() => backupState.getCurrentProjectVersion());
  assert.equal(snapVer, IMAGE_VER);
});

await test('5) VersionService.check(): 陈旧 ENV 下不再误报 hasUpdate=true，但返回 versionMismatch=true 与 warning 级别', async () => {
  process.env.DSH_SUITE_VERSION = STALE_ENV_VER;
  pv.resetWarnings();

  const svc = new versionService.VersionService();
  svc.cachedMeta = svc.getLocalMeta();
  svc.lastFetched = Date.now();

  const origWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await svc.check(false, null);
  } finally {
    console.warn = origWarn;
  }

  assert.equal(res.project.current, IMAGE_VER);
  assert.equal(res.project.latest, IMAGE_VER);
  assert.equal(res.project.hasUpdate, false, 'must NOT falsely report an update when image is already latest');
  assert.equal(res.project.versionMismatch, true);
  assert.equal(res.project.envConflict, true);
  assert.equal(res.project.envVersion, STALE_ENV_VER);
  assert.equal(res.project.imageVersion, IMAGE_VER);
  assert.equal(res.project.level, 'warning');
  assert.equal(res.overallLevel, 'warning');
  assert.ok(res.project.updateTitle.includes(`当前版本 (v${IMAGE_VER})`));
});

await test('6) 远端确实存在更新版本 (99.1.0) 且同时存在陈旧 ENV 时，hasUpdate 与 versionMismatch 同时准确保留', async () => {
  process.env.DSH_SUITE_VERSION = STALE_ENV_VER;
  pv.resetWarnings();

  const svc = new versionService.VersionService();
  const localMeta = svc.getLocalMeta();
  svc.cachedMeta = {
    ...localMeta,
    latest: {
      ...localMeta.latest,
      version: '99.1.0'
    }
  };
  svc.lastFetched = Date.now();

  const origWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = await svc.check(false, null);
  } finally {
    console.warn = origWarn;
  }

  assert.equal(res.project.current, IMAGE_VER);
  assert.equal(res.project.latest, '99.1.0');
  assert.equal(res.project.hasUpdate, true);
  assert.equal(res.project.versionMismatch, true);
  assert.equal(res.project.level, 'warning');
});

await test('7) 极端兜底契约：镜像文件均不可读时回退采用合法 ENV；全源不可用时返回 null', () => {
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = (targetPath, ...rest) => {
    const s = String(targetPath);
    if (s.endsWith('package.json') || s.endsWith('version.json')) {
      const err = new Error('ENOENT mock');
      err.code = 'ENOENT';
      throw err;
    }
    return origReadFileSync.call(fs, targetPath, ...rest);
  };

  try {
    process.env.DSH_SUITE_VERSION = '2.3.4';
    pv.resetWarnings();
    const fallbackDesc = withCapturedWarnings(() => pv.describeProjectVersion()).result;
    assert.equal(fallbackDesc.version, '2.3.4');
    assert.equal(fallbackDesc.versionMismatch, false);
    assert.equal(fallbackDesc.sources.find((s) => s.source === 'env').adopted, true);

    delete process.env.DSH_SUITE_VERSION;
    pv.resetWarnings();
    const allMissing = withCapturedWarnings(() => pv.resolveProjectVersion()).result;
    assert.equal(allMissing, null);
  } finally {
    fs.readFileSync = origReadFileSync;
  }
});

await test('8) 真实 HTTP 网关端到端验证：/healthz、/admin/api/status 与 /admin/api/version/check 契约', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-issue24-http-'));
  const dshDir = path.join(tmpRoot, '.dsh');
  fs.mkdirSync(dshDir, { recursive: true });

  const prevEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_DIR: process.env.DSH_DIR,
    GATEWAY_CONFIG_FILE: process.env.GATEWAY_CONFIG_FILE,
    SESSION_SECRET_FILE: process.env.SESSION_SECRET_FILE,
    AUTH_TOKEN: process.env.AUTH_TOKEN
  };

  process.env.DSH_HOME = tmpRoot;
  process.env.DSH_DIR = dshDir;
  process.env.GATEWAY_CONFIG_FILE = path.join(dshDir, 'gateway.config.json');
  process.env.SESSION_SECRET_FILE = path.join(dshDir, '.session_secret');
  delete process.env.AUTH_TOKEN;
  process.env.DSH_SUITE_VERSION = STALE_ENV_VER;
  pv.resetWarnings();

  const svc = new versionService.VersionService();
  svc.cachedMeta = svc.getLocalMeta();
  svc.lastFetched = Date.now();

  const stubServices = {
    dshManager: {
      getStatus: () => ({ version: '0.2.3-alpha.2', running: true, ready: true }),
      getCurrentVersion: () => '0.2.3-alpha.2',
      fetchAvailableVersions: async () => ({ latest: '0.2.3-alpha.2' }),
      getNpmRegistry: () => 'https://registry.npmmirror.com'
    },
    desktopManager: { getStatus: () => ({ enabled: true, running: false }) },
    versionService: svc,
    backupService: {
      listBackups: () => ({ ok: true, snapshots: [] }),
      isBusy: () => false,
      getActiveTask: () => null,
      getBackupJob: () => null
    },
    pluginManager: { listPlugins: () => ({ ok: true, plugins: [] }) }
  };

  const origWarn = console.warn;
  console.warn = () => {};
  const app = createApp({
    capabilities: computeCapabilities({ DSH_VARIANT: 'market' }),
    services: stubServices,
    env: { ...process.env, PROXY_PORT: '0' },
    persisted: {},
    configState: { locked: false, reason: null, files: [] }
  });

  const port = await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => resolve(app.server.address().port));
  });

  try {
    const setupBody = JSON.stringify({ password: 'Issue24-Strong#Password1', confirm: 'Issue24-Strong#Password1' });
    const setupRes = await rawRequest(port, '/__auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(setupBody)) },
      body: setupBody
    });
    assert.equal(setupRes.status, 200);
    const cookie = setupRes.headers['set-cookie'][0].split(';')[0];

    const healthRes = await rawRequest(port, '/healthz');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.json.projectVersion, IMAGE_VER);

    const statusRes = await rawRequest(port, '/admin/api/status', { headers: { cookie } });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.json.project.version, IMAGE_VER);
    assert.equal(statusRes.json.project.versionMismatch, true);
    assert.equal(statusRes.json.project.envConflict, true);
    assert.equal(statusRes.json.project.envVersion, STALE_ENV_VER);
    assert.equal(statusRes.json.project.imageVersion, IMAGE_VER);
    const envSource = statusRes.json.project.versionSources.find((s) => s.source === 'env');
    assert.equal(envSource.conflict, true);
    assert.equal(envSource.adopted, false);

    const checkRes = await rawRequest(port, '/admin/api/version/check', { headers: { cookie } });
    assert.equal(checkRes.status, 200);
    assert.equal(checkRes.json.project.current, IMAGE_VER);
    assert.equal(checkRes.json.project.latest, IMAGE_VER);
    assert.equal(checkRes.json.project.hasUpdate, false);
    assert.equal(checkRes.json.project.versionMismatch, true);
    assert.equal(checkRes.json.project.level, 'warning');
  } finally {
    console.warn = origWarn;
    await new Promise((resolve) => app.server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

console.log('\n────────────────────────────────────────');
console.log(
  fail === 0
    ? `✅ Issue #24 回归测试通过（${pass}/${pass + fail}）`
    : `❌ Issue #24 回归测试失败：${fail} 项`
);
process.exit(fail === 0 ? 0 : 1);
