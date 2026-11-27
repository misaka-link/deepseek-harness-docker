'use strict';

/**
 * Shared secret for container-internal loopback APIs (/__internal/desktop/*).
 * Persisted as a 0600 file at $DSH_DIR/.internal-api-token and verified with timingSafeEqual.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../core/paths');
const { writeFileAtomicSync } = require('../core/atomic-write');

let cachedToken = null;
let cachedPath = null;

function tokenFilePath() {
  return paths.getInternalTokenFile();
}

function readToken() {
  try {
    const raw = fs.readFileSync(tokenFilePath(), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const file = tokenFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {}
  writeFileAtomicSync(file, token + '\n', { mode: 0o600 });
  return token;
}

function getInternalToken() {
  const currentPath = tokenFilePath();
  if (cachedToken && cachedPath === currentPath) return cachedToken;
  cachedPath = currentPath;
  cachedToken = readToken() || generateToken();
  return cachedToken;
}

function safeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyInternalToken(req) {
  const provided = req && req.headers ? req.headers['x-dsh-internal-token'] : undefined;
  if (typeof provided !== 'string' || !provided) return false;
  return safeEqualStr(provided.trim(), getInternalToken());
}

function resetCacheForTest() {
  cachedToken = null;
  cachedPath = null;
}

module.exports = {
  tokenFilePath,
  getInternalToken,
  readToken,
  verifyInternalToken,
  resetCacheForTest
};
