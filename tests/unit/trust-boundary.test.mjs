#!/usr/bin/env node
/**
 * 信任边界单测：登录限流 (XFF/TTL)、WebSocket 同源校验、内部回环接口共享密钥。
 * 用法: node tests/unit/trust-boundary.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { fail++; console.log('  ✗ ' + name + '\n      ' + err.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trust-'));
process.env.DSH_DIR = tmp;
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef';
process.env.AUTH_TOKEN = 'unit-test-token';
delete process.env.TRUST_PROXY;
const tokenFile = path.join(tmp, '.internal-api-token');
process.env.DSH_INTERNAL_TOKEN_FILE = tokenFile;

const rateLimit = require(path.join(ROOT, 'gateway/src/auth/rate-limit.js'));
const wsOrigin = require(path.join(ROOT, 'gateway/src/auth/ws-origin.js'));
const internalToken = require(path.join(ROOT, 'gateway/src/auth/internal-token.js'));
const { buildRuntimeConfig } = require(path.join(ROOT, 'gateway/src/config/runtime-config.js'));

const fakeReq = ({ remote = '203.0.113.9', headers = {} } = {}) => ({ socket: { remoteAddress: remote }, headers });

try {
  console.log('\n[1] 限流 IP 解析与 TTL 清理');
  check('默认忽略 X-Forwarded-For，采用 socket 对端地址', () => {
    rateLimit.setTrustProxy(false);
    assert.equal(rateLimit.resolveClientIp(fakeReq({ remote: '203.0.113.9', headers: { 'x-forwarded-for': '1.2.3.4' } })), '203.0.113.9');
  });
  check('显式开启 TRUST_PROXY 后采用 XFF 最右侧可信跳', () => {
    rateLimit.setTrustProxy(true);
    assert.equal(rateLimit.resolveClientIp(fakeReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' } })), '7.7.7.7');
    assert.equal(rateLimit.resolveClientIp(fakeReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': 'bad, ???' } })), '127.0.0.1');
    rateLimit.setTrustProxy(false);
  });
  check('IP 规范化 + 5 次失败锁定与成功解锁', () => {
    assert.equal(rateLimit.normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(rateLimit.normalizeIp('198.51.100.5:443'), '198.51.100.5');
    assert.equal(rateLimit.normalizeIp('[::1]'), '::1');
    assert.equal(rateLimit.normalizeIp('garbage'), '');
    const ip = '192.0.2.1';
    for (let i = 0; i < 5; i++) rateLimit.recordAuthAttempt(ip, false);
    assert.equal(rateLimit.checkRateLimit(ip).allowed, false);
    rateLimit.recordAuthAttempt(ip, true);
    assert.equal(rateLimit.checkRateLimit(ip).allowed, true);
  });
  check('限流表 TTL 清理防内存泄漏', () => {
    const RealNow = Date.now;
    const t0 = RealNow();
    for (let i = 0; i < 1200; i++) rateLimit.recordAuthAttempt(`198.18.${(i >> 8) & 255}.${i & 255}`, false);
    assert.ok(rateLimit.getRateLimitTableSize() >= 1000);
    Date.now = () => t0 + 20 * 60 * 1000;
    try { rateLimit.recordAuthAttempt('198.51.100.99', false); } finally { Date.now = RealNow; }
    assert.ok(rateLimit.getRateLimitTableSize() < 100);
  });

  console.log('\n[2] WebSocket Origin 校验');
  check('同源放行、伪造 x-forwarded-host 与跨站均拒绝、publicHost 白名单生效', () => {
    assert.equal(wsOrigin.isAllowedWsOrigin(fakeReq({ headers: { host: 'dsh.example.com', origin: 'https://dsh.example.com' } }), []), true);
    assert.equal(wsOrigin.isAllowedWsOrigin(fakeReq({ headers: { host: 'dsh.example.com', 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' } }), []), false);
    assert.equal(wsOrigin.isAllowedWsOrigin(fakeReq({ headers: { host: 'dsh.example.com', origin: 'http://evil.com' } }), []), false);
    assert.equal(wsOrigin.isAllowedWsOrigin(fakeReq({ headers: { host: '127.0.0.1:3080', origin: 'https://dsh.example.com' } }), ['dsh.example.com']), true);
    assert.equal(wsOrigin.isAllowedWsOrigin(fakeReq({ headers: { host: 'dsh.example.com', origin: 'file:///etc/passwd' } }), []), false);
    assert.equal(wsOrigin.isAllowedWsOrigin(fakeReq({ headers: { host: 'dsh.example.com' } }), []), true);
    assert.equal(wsOrigin.isAllowedWsOrigin(fakeReq({ remote: '127.0.0.1', headers: { host: '127.0.0.1:3080', origin: 'http://localhost:3080' } }), []), true);
  });

  console.log('\n[3] 内部接口共享密钥与源码接线');
  check('0600 落盘、持久化读取、正确放行、错误拒绝', () => {
    const t = internalToken.getInternalToken();
    assert.match(t, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(internalToken.readToken(), t);
    assert.equal(internalToken.verifyInternalToken({ headers: { 'x-dsh-internal-token': t } }), true);
    assert.equal(internalToken.verifyInternalToken({ headers: { 'x-dsh-internal-token': 'bad' } }), false);
    assert.equal(internalToken.verifyInternalToken({ headers: {} }), false);
  });
  check('路由接线：internal-desktop 验回环+密钥，ws-upgrade 委托 ws-origin', () => {
    const idSrc = fs.readFileSync(path.join(ROOT, 'gateway/src/routes/internal-desktop.js'), 'utf8');
    assert.ok(/verifyInternalToken\(req\)/.test(idSrc) && /isLoopbackReq/.test(idSrc) && /normalizeIp/.test(idSrc));
    const wsSrc = fs.readFileSync(path.join(ROOT, 'gateway/src/proxy/ws-upgrade.js'), 'utf8');
    assert.ok(/isAllowedWsOrigin/.test(wsSrc) && !/x-forwarded-host/.test(wsSrc));
  });

  console.log('\n[4] 运行时配置环境变量优先级 (TRUST_PROXY / PUBLIC_HOST)');
  check('显式 TRUST_PROXY / PUBLIC_HOST 环境变量优先于持久化配置，留空则回落持久化值', () => {
    const c1 = buildRuntimeConfig({ trustProxy: false, publicHost: 'persisted.example.com' }, { TRUST_PROXY: '1', PUBLIC_HOST: 'env.example.com, alt.example.com' });
    assert.equal(c1.trustProxy, true);
    assert.equal(c1.trustProxySource, 'env');
    assert.deepEqual(c1.publicHosts, ['env.example.com', 'alt.example.com']);
    assert.equal(c1.publicHostSource, 'env');

    const c2 = buildRuntimeConfig({ trustProxy: true, publicHost: 'persisted.example.com' }, { TRUST_PROXY: '0' });
    assert.equal(c2.trustProxy, false);
    assert.equal(c2.trustProxySource, 'env');
    assert.deepEqual(c2.publicHosts, ['persisted.example.com']);
    assert.equal(c2.publicHostSource, 'persisted');

    const c3 = buildRuntimeConfig({ trustProxy: true, publicHost: 'persisted.example.com' }, { TRUST_PROXY: 'false', PUBLIC_HOST: '  ' });
    assert.equal(c3.trustProxy, false);
    assert.deepEqual(c3.publicHosts, ['persisted.example.com']);

    const c4 = buildRuntimeConfig({ trustProxy: true, publicHost: 'persisted.example.com' }, {});
    assert.equal(c4.trustProxy, true);
    assert.equal(c4.trustProxySource, 'persisted');
    assert.deepEqual(c4.publicHosts, ['persisted.example.com']);

    const c5 = buildRuntimeConfig({}, { TRUST_PROXY: 'true', PUBLIC_HOST: 'only-env.example.com' });
    assert.equal(c5.trustProxy, true);
    assert.deepEqual(c5.publicHosts, ['only-env.example.com']);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
