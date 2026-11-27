'use strict';

/**
 * Session signing, cookie serialization, and request authentication.
 * Preserves exact wire format and HMAC-SHA256 signing semantics across upgrades:
 *   - Cookie name: dsh_auth_session
 *   - Signature:   HMAC-SHA256(secret, `${ts}:${AUTH_TOKEN}`) -> `${ts}.${hex}`
 *   - Attributes:  Path=/; HttpOnly; SameSite=Strict; Max-Age=<age>[; Secure]
 *   - Headers:     Authorization: Bearer <token>, x-dsh-auth-token
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../core/paths');
const { writeFileAtomicSync } = require('../core/atomic-write');

let AUTH_TOKEN = (process.env.AUTH_TOKEN || process.env.ACCESS_CODE || '').trim();
const COOKIE_NAME = 'dsh_auth_session';
const COOKIE_MAX_AGE = Number(process.env.COOKIE_MAX_AGE) || 30 * 24 * 3600; // 30 days

function initSigningSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16) {
    return process.env.SESSION_SECRET.trim();
  }

  const secretFile = paths.getSessionSecretFile();
  let fileExists = false;
  try {
    fs.lstatSync(secretFile);
    fileExists = true;
  } catch (err) {
    if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      // Directory/file stat blocked (e.g. EACCES): treat as existing & unreadable, never overwrite
      fileExists = true;
      console.warn('[auth] 无法检查 session_secret 权限，保留现有文件不覆盖:', err.message);
    }
  }

  if (fileExists) {
    try {
      const stored = fs.readFileSync(secretFile, 'utf8').trim();
      if (stored.length >= 32) {
        return stored;
      }
    } catch (err) {
      // Fail-closed: do NOT overwrite an existing unreadable secret file
      console.warn('[auth] 读取持久化 session_secret 失败（将由锁定门禁拦截访问）:', err.message);
      return crypto.randomBytes(32).toString('hex');
    }
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    const secretDir = path.dirname(secretFile);
    if (!fs.existsSync(secretDir)) {
      fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    }
    writeFileAtomicSync(secretFile, generated, { mode: 0o600 });
    console.log('[auth] 已初始化并持久化安全 Session 签名密钥至:', secretFile);
  } catch (err) {
    console.warn('[auth] 持久化 session_secret 失败，将临时保存在内存中:', err.message);
  }

  return generated;
}

let SIGNING_SECRET = initSigningSecret();

function getSigningSecret() {
  return SIGNING_SECRET;
}

function reinitSigningSecret(explicitSecret) {
  if (typeof explicitSecret === 'string' && explicitSecret.length >= 16) {
    SIGNING_SECRET = explicitSecret;
  } else {
    SIGNING_SECRET = initSigningSecret();
  }
  return SIGNING_SECRET;
}

function isAuthEnabled() {
  return AUTH_TOKEN.length > 0;
}

function updateAuthToken(newToken) {
  AUTH_TOKEN = (newToken !== undefined ? String(newToken) : '').trim();
  console.log('[auth] 认证口令已更新, 状态:', isAuthEnabled() ? '已启用认证' : '未设置口令');
}

function getAuthToken() {
  return AUTH_TOKEN;
}

// Constant-time comparison via per-process keyed HMAC-SHA256
const COMPARE_KEY = crypto.randomBytes(32);
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHmac('sha256', COMPARE_KEY).update(a, 'utf8').digest();
  const hb = crypto.createHmac('sha256', COMPARE_KEY).update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isSecureRequest(req) {
  if (!req) return false;
  try {
    if (req.socket && req.socket.encrypted) return true;
    const proto = req.headers && req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') return true;
  } catch {}
  return false;
}

function verifyToken(tokenInput) {
  if (!isAuthEnabled()) return true;
  if (!tokenInput || typeof tokenInput !== 'string') return false;
  return safeEqual(tokenInput, AUTH_TOKEN);
}

function signSession(nowMs = Date.now()) {
  const ts = String(nowMs);
  const payload = `${ts}:${AUTH_TOKEN}`;
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
  return `${ts}.${sig}`;
}

function verifySession(sessionCookie) {
  if (!isAuthEnabled()) return true;
  if (!sessionCookie || typeof sessionCookie !== 'string') return false;

  const parts = sessionCookie.split('.');
  if (parts.length !== 2) return false;

  const [ts, sig] = parts;
  const time = Number(ts);
  const now = Date.now();

  if (!Number.isSafeInteger(time) || time <= 0) return false;
  if (time - now > 60000) return false;
  if (now - time > COOKIE_MAX_AGE * 1000) return false;

  const payload = `${ts}:${AUTH_TOKEN}`;
  const expectedSig = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
  return safeEqual(sig, expectedSig);
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const k = parts[0].trim();
      const v = parts.slice(1).join('=').trim();
      try {
        list[k] = decodeURIComponent(v);
      } catch {
        list[k] = v;
      }
    }
  });
  return list;
}

function checkRequestAuth(req) {
  if (!isAuthEnabled()) return true;
  const headers = (req && req.headers) || {};

  // 1. Authorization: Bearer <token>
  const authHeader = headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (verifyToken(bearerToken)) return true;
  }

  // 2. x-dsh-auth-token header
  const customToken = headers['x-dsh-auth-token'];
  if (typeof customToken === 'string' && verifyToken(customToken.trim())) {
    return true;
  }

  // 3. Session cookie
  const cookies = parseCookies(headers.cookie);
  const sessionCookie = cookies[COOKIE_NAME];
  return verifySession(sessionCookie);
}

function setAuthCookie(res, req) {
  const sessionVal = signSession();
  const secureFlag = isSecureRequest(req) ? '; Secure' : '';
  const cookieStr = `${COOKIE_NAME}=${encodeURIComponent(sessionVal)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${secureFlag}`;
  res.setHeader('Set-Cookie', cookieStr);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

module.exports = {
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  isAuthEnabled,
  updateAuthToken,
  getAuthToken,
  getSigningSecret,
  reinitSigningSecret,
  safeEqual,
  isSecureRequest,
  verifyToken,
  signSession,
  verifySession,
  parseCookies,
  checkRequestAuth,
  setAuthCookie,
  clearAuthCookie
};
