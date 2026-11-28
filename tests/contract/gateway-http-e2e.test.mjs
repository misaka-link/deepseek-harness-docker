#!/usr/bin/env node
/**
 * gateway-http-e2e.test.mjs — Real HTTP end-to-end contract test for the modular gateway.
 *
 * Exercises:
 *   1) Empty config -> GET / redirects 302 /setup; weak password rejected 400; strong password succeeds + cookie
 *   2) 8-language & theme negotiation (Accept-Language + dsh_ui cookie) + versioned /__ui/<rev>/ immutable asset
 *   3) Upstream proxy:
 *      - JS response with Content-Encoding: gzip passes through raw compressed bytes without decompression/buffering
 *      - HTML response receives __DSH_TRANSPORT__ & crypto.randomUUID shim injection
 *   4) API contracts: /healthz, /__ui/prefs, /admin/api/status, POST /admin/api/dsh/registry,
 *      POST /admin/api/dsh/install rejecting <0.2.3-alpha.2 with DSH_ENGINE_UNSUPPORTED
 *   5) Fail-closed locked mode: GET /login -> 503 locked page, POST /__auth/setup -> 423 SETUP_LOCKED_UNREADABLE_CONFIG
 *   6) mini variant capability contract: GET /vnc -> 404, POST /admin/api/desktop/start -> 403 CAPABILITY_UNAVAILABLE
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gateway-e2e-'));
const dshDir = path.join(tmpRoot, '.dsh');
fs.mkdirSync(dshDir, { recursive: true });

process.env.DSH_HOME = tmpRoot;
process.env.DSH_DIR = dshDir;
process.env.DSH_SNAPSHOTS_DIR = path.join(tmpRoot, '.dsh-snapshots');
process.env.DSH_VERSIONS_DIR = path.join(tmpRoot, '.dsh-versions');
process.env.GATEWAY_CONFIG_FILE = path.join(dshDir, 'gateway.config.json');
process.env.SESSION_SECRET_FILE = path.join(dshDir, '.session_secret');
process.env.DSH_SKIP_PM_CONFIG_SYNC = '1';
delete process.env.AUTH_TOKEN;
delete process.env.ACCESS_CODE;
delete process.env.ADMIN_PATH;
delete process.env.VNC_PATH;
delete process.env.PROXY_PORT;

const { createApp } = require(path.join(root, 'gateway/src/bootstrap.js'));
const { computeCapabilities } = require(path.join(root, 'gateway/src/core/capabilities.js'));
const versionService = require(path.join(root, 'gateway/src/dsh/version-service.js'));
const { isValidVersion } = require(path.join(root, 'gateway/src/dsh/dsh-version.js'));

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
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer: buf,
            text: buf.toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function listenServer(srv) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

function closeServer(srv) {
  return new Promise((resolve) => {
    if (!srv) return resolve();
    srv.close(() => resolve());
  });
}

// Mock upstream DSH HTTP server
const rawJsBody = 'console.log("hello from compressed upstream bundle");\n'.repeat(40);
const gzippedJsBuf = zlib.gzipSync(Buffer.from(rawJsBody, 'utf8'));
let lastJsReqAcceptEncoding = '';

const mockUpstream = http.createServer((req, res) => {
  if (req.url === '/assets/bundle.js') {
    lastJsReqAcceptEncoding = req.headers['accept-encoding'] || '';
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': String(gzippedJsBuf.length)
    });
    res.end(gzippedJsBuf);
    return;
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    const html = '<!DOCTYPE html><html><head><title>Mock DSH</title></head><body><h1>DSH</h1></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

function createStubServices(extraDsh = {}) {
  let registry = 'https://registry.npmmirror.com';
  const dshManager = {
    getStatus: () => ({
      version: '0.2.3-alpha.2',
      running: true,
      ready: true,
      installing: false,
      stopping: false,
      manualStopped: false,
      pid: 4242,
      startTime: Date.now() - 1000,
      npmRegistry: registry,
      cachedVersions: ['0.2.3-alpha.2'],
      lastExitInfo: null,
      recentLogs: [],
      autoHealEnabled: true,
      autoHealMaxPerBoot: 5,
      autoHealCountInCurrentBoot: 0,
      autoIsolatedEvents: [],
      needleResidue: 0
    }),
    getCurrentVersion: () => '0.2.3-alpha.2',
    getNpmRegistry: () => registry,
    setNpmRegistry: (url) => {
      registry = String(url).replace(/\/+$/, '');
      return registry;
    },
    setAutoHeal: () => {},
    isValidVersion,
    ensureValidUpstreamCookie: async () => '',
    invalidateUpstreamCookie: () => {},
    boot: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    restart: async () => ({ ok: true }),
    ...extraDsh
  };

  const desktopManager = {
    isEnabled: () => true,
    updateConfig: () => {},
    getStatus: () => ({
      enabled: true,
      running: false,
      width: 1440,
      height: 900,
      enableCdp: true,
      cdpPort: 9222,
      idleTimeoutMinutes: 30,
      enableSidebarTab: false,
      screenshotQuality: 'high',
      screenshotDir: ''
    }),
    start: async () => ({ ok: true }),
    stop: async () => ({ ok: true })
  };

  const backupService = {
    listBackups: () => ({ ok: true, snapshots: [] }),
    isBusy: () => false,
    getActiveTask: () => null,
    getBackupJob: () => null
  };

  const pluginManager = {
    listPlugins: () => ({ ok: true, plugins: [] })
  };

  return {
    dshManager,
    desktopManager,
    versionService,
    backupService,
    pluginManager,
    DshCoreWatchdog: null,
    ToolCacheHealer: null
  };
}

let upstreamPort = 0;
let mainApp = null;
let mainPort = 0;
let lockedApp = null;
let lockedPort = 0;
let miniApp = null;
let miniPort = 0;
let authCookiePair = '';

try {
  upstreamPort = await listenServer(mockUpstream);

  mainApp = createApp({
    capabilities: computeCapabilities({ DSH_VARIANT: 'full' }),
    services: createStubServices(),
    env: { ...process.env, DSH_PORT: String(upstreamPort), PROXY_PORT: '0' },
    persisted: {},
    configState: { locked: false, reason: null, files: [] }
  });
  mainPort = await listenServer(mainApp.server);

  console.log('\n=== 1. 空配置初始化流程 (/ -> /setup -> /__auth/setup) ===');
  await test('空配置访问 GET / (Accept: text/html) 返回 302 重定向至 /setup', async () => {
    const r = await rawRequest(mainPort, '/', { headers: { accept: 'text/html' } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/setup');
  });

  await test('POST /__auth/setup 弱口令 admin 返回 400 + SETUP_PASSWORD_BLACKLISTED', async () => {
    const body = JSON.stringify({ password: 'admin', confirm: 'admin' });
    const r = await rawRequest(mainPort, '/__auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body
    });
    assert.equal(r.status, 400);
    const j = JSON.parse(r.text);
    assert.equal(j.ok, false);
    assert.equal(j.errorCode, 'SETUP_PASSWORD_BLACKLISTED');
  });

  await test('POST /__auth/setup 强口令返回 200 并签发 dsh_auth_session Cookie', async () => {
    const body = JSON.stringify({ password: 'Strong-E2E-Password#2026', confirm: 'Strong-E2E-Password#2026' });
    const r = await rawRequest(mainPort, '/__auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body
    });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.text);
    assert.equal(j.ok, true);
    const setCookie = Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0] : r.headers['set-cookie'];
    assert.ok(setCookie && setCookie.startsWith('dsh_auth_session='));
    authCookiePair = setCookie.split(';')[0];
  });

  console.log('\n=== 2. 8 语言 + 主题协商与静态资源缓存 ===');
  await test('GET /login 携带 Accept-Language: ja 渲染 lang="ja"', async () => {
    const r = await rawRequest(mainPort, '/login', {
      headers: { accept: 'text/html', 'accept-language': 'ja,en;q=0.8' }
    });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('lang="ja"'), 'Expected lang="ja" in /login HTML');
  });

  await test('GET /admin/ 携带 dsh_ui=l:fr|t:dark 渲染 lang="fr"、dark 主题与 /__ui/<rev>/ 资源', async () => {
    const r = await rawRequest(mainPort, '/admin/', {
      headers: {
        accept: 'text/html',
        cookie: `${authCookiePair}; dsh_ui=l:fr|t:dark`
      }
    });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('lang="fr"'), 'Expected lang="fr"');
    assert.ok(r.text.includes('data-ds-theme-source="dark"'), 'Expected dark theme source');
    assert.ok(r.text.includes('data-ds-dark-theme'), 'Expected dark theme attribute');

    const assetMatch = r.text.match(/\/__ui\/[a-zA-Z0-9._-]+\/css\/app-tokens\.css/);
    assert.ok(assetMatch, 'Expected versioned /__ui/<rev>/css/app-tokens.css reference');
    const assetRes = await rawRequest(mainPort, assetMatch[0]);
    assert.equal(assetRes.status, 200);
    assert.ok(String(assetRes.headers['cache-control'] || '').includes('immutable'));
  });

  console.log('\n=== 3. 上游反向代理：JS 压缩字节原样透传 + HTML 垫片注入 ===');
  await test('GET /assets/bundle.js 保留 Accept-Encoding 并逐字节透传 gzip 压缩载荷', async () => {
    const r = await rawRequest(mainPort, '/assets/bundle.js', {
      headers: {
        cookie: authCookiePair,
        'accept-encoding': 'gzip, br'
      }
    });
    assert.equal(r.status, 200);
    assert.ok(lastJsReqAcceptEncoding.includes('gzip'), `upstream saw accept-encoding=${lastJsReqAcceptEncoding}`);
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(Buffer.compare(r.buffer, gzippedJsBuf), 0, 'gzipped JS bytes must match upstream verbatim');
  });

  await test('GET / HTML 响应自动注入 __DSH_TRANSPORT__ 与 crypto.randomUUID 垫片', async () => {
    const r = await rawRequest(mainPort, '/', {
      headers: { cookie: authCookiePair, accept: 'text/html' }
    });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('__DSH_TRANSPORT__'), 'Missing __DSH_TRANSPORT__ injection');
    assert.ok(r.text.includes('randomUUID'), 'Missing crypto.randomUUID polyfill');
  });

  console.log('\n=== 4. 核心 API 契约 (/healthz, /__ui/prefs, status, registry, install 下限) ===');
  const expectedSuiteVer = JSON.parse(fs.readFileSync(path.join(root, 'gateway/package.json'), 'utf8')).version;
  await test(`GET /healthz 返回 200、projectVersion=${expectedSuiteVer} 与 patches.needleResidue=0`, async () => {
    const r = await rawRequest(mainPort, '/healthz');
    assert.equal(r.status, 200);
    const j = JSON.parse(r.text);
    assert.equal(j.ok, true);
    assert.equal(j.projectVersion, expectedSuiteVer);
    assert.equal(j.patches && j.patches.needleResidue, 0);
  });

  await test('GET /__ui/prefs 返回 8 语言列表与主题字段', async () => {
    const r = await rawRequest(mainPort, '/__ui/prefs');
    assert.equal(r.status, 200);
    const j = JSON.parse(r.text);
    assert.equal(j.ok, true);
    assert.equal(j.supportedLocales.length, 8);
  });

  await test('GET /admin/api/status 包含 npmRegistry，POST /admin/api/dsh/registry 可持久化更新', async () => {
    const s1 = await rawRequest(mainPort, '/admin/api/status', { headers: { cookie: authCookiePair } });
    assert.equal(s1.status, 200);
    const j1 = JSON.parse(s1.text);
    assert.ok(j1.npmRegistry);

    const regBody = JSON.stringify({ registry: 'https://registry.npmjs.org/' });
    const p1 = await rawRequest(mainPort, '/admin/api/dsh/registry', {
      method: 'POST',
      headers: {
        cookie: authCookiePair,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(regBody))
      },
      body: regBody
    });
    assert.equal(p1.status, 200);
    const pj = JSON.parse(p1.text);
    assert.equal(pj.ok, true);
    assert.equal(pj.registry, 'https://registry.npmjs.org');

    const persisted = JSON.parse(fs.readFileSync(process.env.GATEWAY_CONFIG_FILE, 'utf8'));
    assert.equal(persisted.npmRegistry, 'https://registry.npmjs.org');
  });

  await test('POST /admin/api/dsh/install 尝试安装旧版 0.2.2-rc.5 返回 400 + DSH_ENGINE_UNSUPPORTED', async () => {
    const body = JSON.stringify({ version: '0.2.2-rc.5' });
    const r = await rawRequest(mainPort, '/admin/api/dsh/install', {
      method: 'POST',
      headers: {
        cookie: authCookiePair,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body))
      },
      body
    });
    assert.equal(r.status, 400);
    const j = JSON.parse(r.text);
    assert.equal(j.ok, false);
    assert.equal(j.errorCode, 'DSH_ENGINE_UNSUPPORTED');
  });

  console.log('\n=== 5. Fail-closed 锁定态保护契约 ===');
  lockedApp = createApp({
    capabilities: computeCapabilities({ DSH_VARIANT: 'full' }),
    services: createStubServices(),
    env: { ...process.env, DSH_PORT: String(upstreamPort), PROXY_PORT: '0' },
    persisted: {},
    configState: {
      locked: true,
      reason: 'EACCES',
      files: [{ path: '/home/dsh/.dsh/gateway.config.json', code: 'EACCES' }]
    }
  });
  lockedPort = await listenServer(lockedApp.server);

  await test('锁定态下 GET /login 返回 503 锁定页，绝不跳转 /setup', async () => {
    const r = await rawRequest(lockedPort, '/login', { headers: { accept: 'text/html' } });
    assert.equal(r.status, 503);
    assert.ok(r.text.includes('/home/dsh/.dsh/gateway.config.json'));
  });

  await test('锁定态下 POST /__auth/setup 返回 423 + SETUP_LOCKED_UNREADABLE_CONFIG', async () => {
    const body = JSON.stringify({ password: 'Takeover-Password#1', confirm: 'Takeover-Password#1' });
    const r = await rawRequest(lockedPort, '/__auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body
    });
    assert.equal(r.status, 423);
    const j = JSON.parse(r.text);
    assert.equal(j.errorCode, 'SETUP_LOCKED_UNREADABLE_CONFIG');
  });

  console.log('\n=== 6. mini 变体能力守卫契约 ===');
  const desktopStub = require(path.join(root, 'gateway/src/desktop/desktop-stub.js'));
  miniApp = createApp({
    capabilities: computeCapabilities({ DSH_VARIANT: 'mini' }),
    services: { ...createStubServices(), desktopManager: desktopStub },
    env: { ...process.env, DSH_VARIANT: 'mini', DSH_PORT: String(upstreamPort), PROXY_PORT: '0' },
    persisted: {},
    configState: { locked: false, reason: null, files: [] }
  });
  miniPort = await listenServer(miniApp.server);

  await test('mini 变体下 GET /vnc 返回 404', async () => {
    const r = await rawRequest(miniPort, '/vnc', { headers: { cookie: authCookiePair } });
    assert.equal(r.status, 404);
  });

  await test('mini 变体下 POST /admin/api/desktop/start 返回 403 + CAPABILITY_UNAVAILABLE', async () => {
    const r = await rawRequest(miniPort, '/admin/api/desktop/start', {
      method: 'POST',
      headers: { cookie: authCookiePair }
    });
    assert.equal(r.status, 403);
    const j = JSON.parse(r.text);
    assert.equal(j.ok, false);
    assert.equal(j.errorCode, 'CAPABILITY_UNAVAILABLE');
    assert.equal(j.code, 'CAPABILITY_UNAVAILABLE');
  });
} finally {
  await closeServer(miniApp && miniApp.server);
  await closeServer(lockedApp && lockedApp.server);
  await closeServer(mainApp && mainApp.server);
  await closeServer(mockUpstream);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('\n────────────────────────────────────────');
console.log(
  fail === 0
    ? `✅ gateway-http-e2e 契约通过（${pass}/${pass + fail}）`
    : `❌ gateway-http-e2e 契约失败：${fail} 项`
);
process.exit(fail === 0 ? 0 : 1);
