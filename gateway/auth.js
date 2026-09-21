const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

let AUTH_TOKEN = (process.env.AUTH_TOKEN || process.env.ACCESS_CODE || '').trim();
const COOKIE_NAME = 'dsh_auth_session';
const COOKIE_MAX_AGE = Number(process.env.COOKIE_MAX_AGE) || 30 * 24 * 3600; // 30 days

// 初始化签名密钥：优先环境变量 -> 其次持久化存储 -> 首次生成 256 位高强度安全随机数并持久化 (CWE-330)
function initSigningSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16) {
    return process.env.SESSION_SECRET.trim();
  }

  const secretFile = process.env.SESSION_SECRET_FILE || path.join(process.env.DSH_DIR || '/root/.dsh', '.session_secret');
  try {
    if (fs.existsSync(secretFile)) {
      const stored = fs.readFileSync(secretFile, 'utf8').trim();
      if (stored.length >= 32) {
        return stored;
      }
    }
  } catch (e) {
    console.warn('[auth] 读取持久化 session_secret 失败:', e.message);
  }

  // 生成密码学安全的 256 位真随机密钥，彻底解决 CWE-330 可预测密钥问题
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    const secretDir = path.dirname(secretFile);
    if (!fs.existsSync(secretDir)) {
      fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
    console.log('[auth] 已初始化并持久化安全 Session 签名密钥至:', secretFile);
  } catch (e) {
    console.warn('[auth] 持久化 session_secret 失败，将临时保存在内存中:', e.message);
  }

  return generated;
}

let SIGNING_SECRET = initSigningSecret();

function getSigningSecret() {
  return SIGNING_SECRET;
}

function updateAuthToken(newToken) {
  AUTH_TOKEN = (newToken !== undefined ? String(newToken) : '').trim();
  console.log('[auth] 认证口令已更新, 状态:', isAuthEnabled() ? '已启用认证' : '已禁用认证 (无感直通)');
}

function getAuthToken() {
  return AUTH_TOKEN;
}

// IP-based rate limiting for brute-force protection
const failedAttempts = new Map(); // ip -> { count, firstAttempt, lockedUntil, lastSeen }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 60 * 1000; // 1 minute
const ATTEMPT_TTL_MS = 10 * 60 * 1000; // 10 minutes: 过期条目定期清理，避免 Map 无限增长

// 是否信任反向代理转发的 X-Forwarded-For。默认关闭：直接使用 socket 对端地址，
// 否则任何人只要伪造 XFF 头就能为每次尝试"换一个 IP"，让限流形同虚设。
// 仅当网关确实部署在可信反向代理（Nginx/Traefik…）之后时才应显式打开。
let TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

function setTrustProxy(value) {
  TRUST_PROXY = value === true || value === '1' || value === 'true';
}

function getTrustProxy() {
  return TRUST_PROXY;
}

/** 规范化 IP 字符串：去掉 IPv4-mapped IPv6 前缀、端口、方括号，非 IP 一律归为 unknown */
function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let ip = raw.trim();
  if (!ip) return '';
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return net.isIP(ip) ? ip : '';
}

/**
 * 解析用于限流的客户端 IP。
 * 只有 TRUST_PROXY 打开时才采用 X-Forwarded-For；否则一律用 socket 对端地址。
 * 即使信任代理，也只取 XFF 中"最右侧"的可信链路之外的第一跳（这里简化为取最右一个合法 IP），
 * 避免客户端自带的伪造值排在前面被误当作真实来源。
 */
function resolveClientIp(req) {
  const direct = normalizeIp(req && req.socket && req.socket.remoteAddress) || 'unknown';
  if (!TRUST_PROXY) return direct;

  const header = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || !header.trim()) return direct;

  const parts = header.split(',').map(s => normalizeIp(s)).filter(Boolean);
  if (parts.length === 0) return direct;
  // 取最右（最接近本机、由可信代理写入）的一个
  return parts[parts.length - 1];
}

function isAuthEnabled() {
  return AUTH_TOKEN.length > 0;
}

// 未设置访问口令 ⇒ 必须走初始化向导（不再提供"免密直通"模式）
function isSetupRequired() {
  return !isAuthEnabled();
}

// 常见弱口令黑名单（仅作最低限度拦截，配合前端提示）
const WEAK_PASSWORDS = new Set([
  'admin', 'administrator', 'password', 'passw0rd', '12345678', '123456789',
  '1234567890', 'qwertyuiop', '11111111', '00000000', 'deepseek', 'admin123',
  'root', 'letmein', 'changeme'
]);

/** 口令是否过弱（长度 < 8 或命中常见弱口令） */
function isWeakPassword(pwd) {
  if (typeof pwd !== 'string') return true;
  const p = pwd.trim();
  if (p.length < 8 || p.length > 256) return true;
  return WEAK_PASSWORDS.has(p.toLowerCase());
}

// 常量时间比较：先各自 HMAC-SHA256 再比较固定长度摘要，
// 避免"长度不同立即返回"从耗时上泄露口令长度（轻微项）。
const COMPARE_KEY = crypto.randomBytes(32);
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHmac('sha256', COMPARE_KEY).update(a, 'utf8').digest();
  const hb = crypto.createHmac('sha256', COMPARE_KEY).update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 请求是否经由 HTTPS（直连 TLS 或可信代理声明 x-forwarded-proto=https） */
function isSecureRequest(req) {
  if (!req) return false;
  try {
    if (req.socket && req.socket.encrypted) return true;
    const proto = req.headers && req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') return true;
  } catch {}
  return false;
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
  record.lastSeen = now;

  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_WINDOW_MS;
  }

  failedAttempts.set(clientIp, record);
  sweepExpiredAttempts(now);
}

/**
 * 清理过期条目：锁定期已过且超过 TTL 未再出现的记录直接删除。
 * 每次记录失败尝试时顺带清理（O(n) 但仅在失败路径、且有阈值保护），
 * 保证限流表不会随攻击者伪造的海量 IP 无限膨胀（TTL 兜底）。
 */
function sweepExpiredAttempts(now) {
  if (failedAttempts.size < 1000) return;
  for (const [ip, entry] of failedAttempts) {
    const expiredLock = !entry.lockedUntil || entry.lockedUntil < now;
    const stale = !entry.lastSeen || (now - entry.lastSeen) > ATTEMPT_TTL_MS;
    if (expiredLock && stale) failedAttempts.delete(ip);
  }
}

/** 仅供诊断/测试：当前限流表条目数 */
function getRateLimitTableSize() {
  return failedAttempts.size;
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

function setAuthCookie(res, req) {
  const sessionVal = signSession();
  // SameSite=Strict completely prevents CSRF and Cross-Site WebSocket Hijacking (CSWSH)
  // 轻微项：HTTPS 下追加 Secure，避免会话 Cookie 走明文信道
  const secureFlag = isSecureRequest(req) ? '; Secure' : '';
  const cookieStr = `${COOKIE_NAME}=${encodeURIComponent(sessionVal)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${secureFlag}`;
  res.setHeader('Set-Cookie', cookieStr);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

module.exports = {
  isAuthEnabled,
  isSetupRequired,
  isWeakPassword,
  isSecureRequest,
  verifyToken,
  checkRequestAuth,
  setAuthCookie,
  clearAuthCookie,
  checkRateLimit,
  recordAuthAttempt,
  resolveClientIp,
  setTrustProxy,
  getTrustProxy,
  normalizeIp,
  getRateLimitTableSize,
  updateAuthToken,
  getAuthToken,
  getSigningSecret,
  COOKIE_NAME
};
