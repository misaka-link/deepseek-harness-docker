#!/usr/bin/env node
/**
 * 阶段 5（信任边界）本地单测：
 *   M1  限流 IP 不再信任 X-Forwarded-For（除非显式开启 TRUST_PROXY），且限流表有 TTL 清理
 *   M2  WebSocket Origin 校验不再采用 x-forwarded-host
 *   M14 /__internal/desktop/* 需要「回环来源 + 内部共享密钥」
 *
 * 用法: node scripts/trust-boundary-test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

// ── 隔离环境：让 auth.js 把签名密钥写到临时目录，别碰真实 /root/.dsh ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trust-'));
process.env.DSH_DIR = tmp;
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef';
process.env.AUTH_TOKEN = 'unit-test-token';
delete process.env.TRUST_PROXY;
delete process.env.DSH_INTERNAL_TOKEN_FILE;

const auth = require(path.join(ROOT, 'gateway/auth.js'));
const wsOrigin = require(path.join(ROOT, 'gateway/ws-origin.js'));

function fakeReq({ remote = '203.0.113.9', headers = {} } = {}) {
  return { socket: { remoteAddress: remote }, headers };
}

console.log('\n[M1] 限流 IP 解析（默认不信任 XFF）');
check('默认忽略 X-Forwarded-For，采用 socket 对端地址', () => {
  auth.setTrustProxy(false);
  const ip = auth.resolveClientIp(fakeReq({ remote: '203.0.113.9', headers: { 'x-forwarded-for': '1.2.3.4' } }));
  assert.equal(ip, '203.0.113.9');
});
check('伪造 XFF 无法改变限流键（多轮仍同一 IP）', () => {
  auth.setTrustProxy(false);
  const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'].map(x =>
    auth.resolveClientIp(fakeReq({ remote: '198.51.100.7', headers: { 'x-forwarded-for': x } })));
  assert.deepEqual(new Set(ips), new Set(['198.51.100.7']));
});
check('显式开启 TRUST_PROXY 后采用 XFF 最右侧（可信代理写入的那一跳）', () => {
  auth.setTrustProxy(true);
  const ip = auth.resolveClientIp(fakeReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' } }));
  assert.equal(ip, '7.7.7.7');
  auth.setTrustProxy(false);
});
check('TRUST_PROXY 下 XFF 全为垃圾值时回退到 socket 地址', () => {
  auth.setTrustProxy(true);
  const ip = auth.resolveClientIp(fakeReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': 'not-an-ip, ???' } }));
  assert.equal(ip, '127.0.0.1');
  auth.setTrustProxy(false);
});
check('IPv4-mapped IPv6 / 带端口 / 方括号 均被规范化', () => {
  assert.equal(auth.normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(auth.normalizeIp('10.0.0.5:443'), '10.0.0.5');
  assert.equal(auth.normalizeIp('[::1]'), '::1');
  assert.equal(auth.normalizeIp('garbage'), '');
});
check('5 次失败后进入锁定，正确口令可解锁', () => {
  const ip = '192.0.2.1';
  for (let i = 0; i < 5; i++) auth.recordAuthAttempt(ip, false);
  assert.equal(auth.checkRateLimit(ip).allowed, false);
  auth.recordAuthAttempt(ip, true);
  assert.equal(auth.checkRateLimit(ip).allowed, true);
});
check('限流表具备 TTL 清理（大量过期条目不会永久驻留）', () => {
  // 制造 >1000 条"未锁定且早已过期"的条目，再触发一次失败尝试以驱动清理
  const RealNow = Date.now;
  const t0 = RealNow();
  const keys = [];
  for (let i = 0; i < 1200; i++) {
    const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    keys.push(ip);
    auth.recordAuthAttempt(ip, false);
  }
  assert.ok(auth.getRateLimitTableSize() >= 1000, '前置条件：表内应已堆积大量条目');
  // 直接把时间"推后" 20 分钟，让所有条目都超过 TTL
  Date.now = () => t0 + 20 * 60 * 1000;
  try {
    auth.recordAuthAttempt('10.99.99.99', false);
  } finally {
    Date.now = RealNow;
  }
  const size = auth.getRateLimitTableSize();
  assert.ok(size < 100, '过期条目应被 TTL 清理，残留=' + size);
});

console.log('\n[M2] WebSocket Origin 校验（不信任 x-forwarded-host）');
check('同源（Origin == Host）放行', () => {
  const req = fakeReq({ remote: '198.51.100.20', headers: { host: 'dsh.example.com', origin: 'https://dsh.example.com' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), true);
});
check('伪造 x-forwarded-host 不再能骗过校验（核心回归）', () => {
  const req = fakeReq({
    remote: '198.51.100.20',
    headers: { host: 'dsh.example.com', 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' }
  });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), false);
});
check('跨站 Origin 被拒', () => {
  const req = fakeReq({ remote: '198.51.100.20', headers: { host: 'dsh.example.com', origin: 'http://evil.com' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), false);
});
check('配置的对外主机名白名单生效', () => {
  const req = fakeReq({ remote: '198.51.100.20', headers: { host: '127.0.0.1:3080', origin: 'https://dsh.example.com' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), false);
  assert.equal(wsOrigin.isAllowedWsOrigin(req, ['dsh.example.com']), true);
});
check('非 http(s) 协议来源被拒（file:// / null / chrome-extension://）', () => {
  for (const origin of ['file:///etc/passwd', 'chrome-extension://abc', 'null']) {
    const req = fakeReq({ headers: { host: 'dsh.example.com', origin } });
    assert.equal(wsOrigin.isAllowedWsOrigin(req, []), false, origin + ' 应被拒');
  }
});
check('无 Origin（非浏览器客户端）放行', () => {
  const req = fakeReq({ headers: { host: 'dsh.example.com' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(req, []), true);
});
check('回环来源允许 localhost / 127.0.0.1 变体', () => {
  const ok = fakeReq({ remote: '127.0.0.1', headers: { host: '127.0.0.1:3080', origin: 'http://localhost:3080' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(ok, []), true);
  const bad = fakeReq({ remote: '203.0.113.5', headers: { host: 'dsh.example.com', origin: 'http://localhost:3080' } });
  assert.equal(wsOrigin.isAllowedWsOrigin(bad, []), false);
});

console.log('\n[M14] 内部接口共享密钥');
const tokenFile = path.join(tmp, '.internal-api-token');
process.env.DSH_INTERNAL_TOKEN_FILE = tokenFile;
const internalToken = require(path.join(ROOT, 'gateway/internal-token.js'));

check('首次调用生成密钥并以 0600 落盘', () => {
  const t = internalToken.getInternalToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(tokenFile), '密钥文件应存在');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, '权限必须是 0600');
});
check('密钥持久化：重新读取一致（网关重启后插件仍可用）', () => {
  const t1 = internalToken.getInternalToken();
  const t2 = internalToken.readToken();
  assert.equal(t1, t2);
});
check('携带正确密钥的请求通过校验', () => {
  const t = internalToken.getInternalToken();
  assert.equal(internalToken.verifyInternalToken({ headers: { 'x-dsh-internal-token': t } }), true);
});
check('缺失 / 错误 / 空密钥一律拒绝', () => {
  assert.equal(internalToken.verifyInternalToken({ headers: {} }), false);
  assert.equal(internalToken.verifyInternalToken({ headers: { 'x-dsh-internal-token': 'deadbeef' } }), false);
  assert.equal(internalToken.verifyInternalToken({ headers: { 'x-dsh-internal-token': '' } }), false);
  assert.equal(internalToken.verifyInternalToken({}), false);
});

console.log('\n[M14] 网关源码回归：内部接口必须同时要求回环 + 密钥');
check('index.js 不再使用固定字符串列表判定回环', () => {
  const src = fs.readFileSync(path.join(ROOT, 'gateway/index.js'), 'utf8');
  assert.ok(!/includes\(req\.socket\.remoteAddress\)/.test(src), '不应再用 includes(remoteAddress) 判定回环');
  assert.ok(/verifyInternalToken\(req\)/.test(src), '内部接口应校验内部密钥');
});
check('index.js 的 WS Origin 校验已委托给 ws-origin 模块', () => {
  const src = fs.readFileSync(path.join(ROOT, 'gateway/index.js'), 'utf8');
  assert.ok(/wsOrigin\.isAllowedWsOrigin\(req, PUBLIC_HOSTS\)/.test(src));
  assert.ok(!/req\.headers\['x-forwarded-host'\]/.test(src), 'index.js 不应再读取 x-forwarded-host');
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
