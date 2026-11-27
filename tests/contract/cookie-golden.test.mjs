#!/usr/bin/env node
/**
 * cookie-golden.test.mjs — Golden compatibility contract test for session cookies.
 *
 * Ensures the v1.0.0 session cookie format remains byte-for-byte identical to v0.2.x
 * so existing signed-in browsers stay logged in seamlessly across upgrades.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cookie-golden-'));
process.env.DSH_HOME = tmpDir;
process.env.DSH_DIR = path.join(tmpDir, '.dsh');
process.env.SESSION_SECRET_FILE = path.join(tmpDir, '.dsh/.session_secret');
delete process.env.AUTH_TOKEN;
delete process.env.ACCESS_CODE;
delete process.env.SESSION_SECRET;

const session = require(path.join(root, 'gateway/src/auth/session.js'));

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

/** Reference v0.2.16 signing formula (verbatim). */
function v0216SignSession(secret, token, nowMs) {
  const ts = String(nowMs);
  const payload = `${ts}:${token}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${ts}.${sig}`;
}

const FIXED_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const FIXED_TOKEN = 'Golden-Upgrade-Pass-2026!';
const FIXED_TS = 1764200000000;

try {
  console.log('\n=== Golden Session Cookie 兼容性契约 ===');

  session.reinitSigningSecret(FIXED_SECRET);
  session.updateAuthToken(FIXED_TOKEN);

  check('Cookie 名称保持为 dsh_auth_session', () => {
    assert.equal(session.COOKIE_NAME, 'dsh_auth_session');
  });

  check('固定密钥 + 固定口令 + 固定时间戳签出的 Cookie 值与 v0.2.16 逐字节一致', () => {
    const expected = v0216SignSession(FIXED_SECRET, FIXED_TOKEN, FIXED_TS);
    const actual = session.signSession(FIXED_TS);
    assert.equal(actual, expected);
    assert.match(actual, /^1764200000000\.[0-9a-f]{64}$/);
  });

  check('v1.0.0 verifySession 接受由 v0.2.16 公式签出的当前会话 Cookie', () => {
    const freshTs = Date.now();
    const legacyCookie = v0216SignSession(FIXED_SECRET, FIXED_TOKEN, freshTs);
    assert.equal(session.verifySession(legacyCookie), true);
  });

  check('篡改签名、伪造口令或过期时间戳均被拒绝', () => {
    const freshTs = Date.now();
    const wrongTokenCookie = v0216SignSession(FIXED_SECRET, 'Wrong-Pass', freshTs);
    assert.equal(session.verifySession(wrongTokenCookie), false);

    const expiredTs = freshTs - (session.COOKIE_MAX_AGE + 60) * 1000;
    const expiredCookie = v0216SignSession(FIXED_SECRET, FIXED_TOKEN, expiredTs);
    assert.equal(session.verifySession(expiredCookie), false);

    const futureTs = freshTs + 120 * 1000;
    const futureCookie = v0216SignSession(FIXED_SECRET, FIXED_TOKEN, futureTs);
    assert.equal(session.verifySession(futureCookie), false);
  });

  check('HTTP / HTTPS 下的 Set-Cookie 响应头属性与 v0.2.16 完全一致', () => {
    const headersHttp = {};
    const resHttp = { setHeader: (k, v) => { headersHttp[k] = v; } };
    session.setAuthCookie(resHttp, { headers: {}, socket: {} });
    assert.match(
      headersHttp['Set-Cookie'],
      new RegExp(`^dsh_auth_session=\\d+\\.[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${session.COOKIE_MAX_AGE}$`)
    );

    const headersHttps = {};
    const resHttps = { setHeader: (k, v) => { headersHttps[k] = v; } };
    session.setAuthCookie(resHttps, { headers: { 'x-forwarded-proto': 'https' }, socket: {} });
    assert.match(
      headersHttps['Set-Cookie'],
      new RegExp(`^dsh_auth_session=\\d+\\.[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${session.COOKIE_MAX_AGE}; Secure$`)
    );
  });

  check('checkRequestAuth 识别 v0.2.16 Cookie、Bearer Token 与 x-dsh-auth-token', () => {
    const legacyCookie = v0216SignSession(FIXED_SECRET, FIXED_TOKEN, Date.now());
    assert.equal(session.checkRequestAuth({ headers: { cookie: `dsh_auth_session=${encodeURIComponent(legacyCookie)}` } }), true);
    assert.equal(session.checkRequestAuth({ headers: { authorization: `Bearer ${FIXED_TOKEN}` } }), true);
    assert.equal(session.checkRequestAuth({ headers: { 'x-dsh-auth-token': FIXED_TOKEN } }), true);
    assert.equal(session.checkRequestAuth({ headers: {} }), false);
  });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\n────────────────────────────────────────');
console.log(fail === 0 ? `✅ cookie-golden 契约通过（${pass}/${pass + fail}）` : `❌ cookie-golden 契约失败：${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
