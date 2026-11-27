'use strict';

/**
 * IP-based authentication rate limiting with proxy trust boundary and TTL cleanup.
 */

const net = require('net');

const failedAttempts = new Map(); // ip -> { count, firstAttempt, lockedUntil, lastSeen }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 60 * 1000;
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

let TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

function setTrustProxy(value) {
  TRUST_PROXY = value === true || value === '1' || value === 'true';
}

function getTrustProxy() {
  return TRUST_PROXY;
}

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
 * Resolve client IP for rate limiting.
 * Uses socket peer address by default; only uses rightmost valid IP in X-Forwarded-For
 * when TRUST_PROXY is explicitly enabled.
 */
function resolveClientIp(req) {
  const direct = normalizeIp(req && req.socket && req.socket.remoteAddress) || 'unknown';
  if (!TRUST_PROXY) return direct;

  const header = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || !header.trim()) return direct;

  const parts = header.split(',').map((s) => normalizeIp(s)).filter(Boolean);
  if (parts.length === 0) return direct;
  return parts[parts.length - 1];
}

function checkRateLimit(clientIp) {
  const now = Date.now();
  const record = failedAttempts.get(clientIp);
  if (!record) return { allowed: true };

  if (record.lockedUntil && now < record.lockedUntil) {
    const retryAfterSec = Math.ceil((record.lockedUntil - now) / 1000);
    return {
      allowed: false,
      retryAfterSec,
      error: `登录尝试次数过多，请在 ${retryAfterSec} 秒后重试`
    };
  }

  if (record.lockedUntil && now >= record.lockedUntil) {
    failedAttempts.delete(clientIp);
    return { allowed: true };
  }

  return { allowed: true };
}

function sweepExpiredAttempts(now) {
  if (failedAttempts.size < 1000) return;
  for (const [ip, entry] of failedAttempts) {
    const expiredLock = !entry.lockedUntil || entry.lockedUntil < now;
    const stale = !entry.lastSeen || (now - entry.lastSeen) > ATTEMPT_TTL_MS;
    if (expiredLock && stale) failedAttempts.delete(ip);
  }
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

function getRateLimitTableSize() {
  return failedAttempts.size;
}

function clearRateLimitForTest() {
  failedAttempts.clear();
}

module.exports = {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_WINDOW_MS,
  ATTEMPT_TTL_MS,
  setTrustProxy,
  getTrustProxy,
  normalizeIp,
  resolveClientIp,
  checkRateLimit,
  recordAuthAttempt,
  getRateLimitTableSize,
  clearRateLimitForTest
};
