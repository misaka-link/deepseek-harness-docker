const crypto = require('crypto');

let AUTH_TOKEN = (process.env.AUTH_TOKEN || process.env.ACCESS_CODE || '').trim();
const COOKIE_NAME = 'dsh_auth_session';
const COOKIE_MAX_AGE = Number(process.env.COOKIE_MAX_AGE) || 30 * 24 * 3600; // 30 days
let SIGNING_SECRET = process.env.SESSION_SECRET || (AUTH_TOKEN ? crypto.createHmac('sha256', 'dsh-session-salt-v1').update(AUTH_TOKEN).digest('hex') : crypto.randomBytes(32).toString('hex'));

function updateAuthToken(newToken) {
  AUTH_TOKEN = (newToken !== undefined ? String(newToken) : '').trim();
  SIGNING_SECRET = AUTH_TOKEN ? crypto.createHmac('sha256', 'dsh-session-salt-v1').update(AUTH_TOKEN).digest('hex') : crypto.randomBytes(32).toString('hex');
  console.log('[auth] 认证口令已更新, 状态:', isAuthEnabled() ? '已启用认证' : '已禁用认证 (无感直通)');
}

function getAuthToken() {
  return AUTH_TOKEN;
}

// IP-based rate limiting for brute-force protection
const failedAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 60 * 1000; // 1 minute

function isAuthEnabled() {
  return AUTH_TOKEN.length > 0;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkRateLimit(clientIp) {
  const now = Date.now();
  const record = failedAttempts.get(clientIp);
  if (!record) return { allowed: true };

  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return {
      allowed: false,
      error: `登录尝试次数过多，请在 ${remainingSeconds} 秒后重试`
    };
  }

  // Reset if window has passed
  if (record.lockedUntil && now >= record.lockedUntil) {
    failedAttempts.delete(clientIp);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordAuthAttempt(clientIp, success) {
  if (success) {
    failedAttempts.delete(clientIp);
    return;
  }

  const now = Date.now();
  const record = failedAttempts.get(clientIp) || { count: 0, firstAttempt: now, lockedUntil: 0 };
  record.count += 1;

  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_WINDOW_MS;
  }

  failedAttempts.set(clientIp, record);

  // Periodic cleanup of old entries
  if (failedAttempts.size > 10000) {
    for (const [ip, entry] of failedAttempts) {
      if (entry.lockedUntil && entry.lockedUntil < now) failedAttempts.delete(ip);
    }
  }
}

function verifyToken(tokenInput) {
  if (!isAuthEnabled()) return true;
  if (!tokenInput || typeof tokenInput !== 'string') return false;
  return safeEqual(tokenInput, AUTH_TOKEN);
}

function signSession() {
  const ts = Date.now().toString();
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

  // Validate timestamp format and limits (allow 60s clock skew)
  if (!Number.isSafeInteger(time) || time <= 0) return false;
  if (time - now > 60000) return false; // Token from future
  if (now - time > COOKIE_MAX_AGE * 1000) return false; // Expired

  const payload = `${ts}:${AUTH_TOKEN}`;
  const expectedSig = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
  return safeEqual(sig, expectedSig);
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return list;
  cookieHeader.split(';').forEach(cookie => {
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

  // 1. Check Bearer / Token header if API caller
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (verifyToken(bearerToken)) return true;
  }

  // 2. Check custom header
  const customToken = req.headers['x-dsh-auth-token'];
  if (typeof customToken === 'string' && verifyToken(customToken.trim())) {
    return true;
  }

  // 3. Check cookie
  const cookies = parseCookies(req.headers['cookie']);
  const sessionCookie = cookies[COOKIE_NAME];
  return verifySession(sessionCookie);
}

function setAuthCookie(res) {
  const sessionVal = signSession();
  // SameSite=Strict completely prevents CSRF and Cross-Site WebSocket Hijacking (CSWSH)
  const cookieStr = `${COOKIE_NAME}=${encodeURIComponent(sessionVal)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
  res.setHeader('Set-Cookie', cookieStr);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

module.exports = {
  isAuthEnabled,
  verifyToken,
  checkRequestAuth,
  setAuthCookie,
  clearAuthCookie,
  checkRateLimit,
  recordAuthAttempt,
  updateAuthToken,
  getAuthToken,
  COOKIE_NAME
};
