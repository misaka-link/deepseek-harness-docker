'use strict';

/**
 * 内部接口（/__internal/desktop/*）共享密钥。
 *
 * 背景：这些接口此前只靠「来源 IP 是回环」来放行。一旦网关被放在反向代理之后
 * （Nginx 与网关同机时所有外部请求的对端地址都会变成 127.0.0.1），外部访问者
 * 就能直接调用它们（启停桌面、改配置）。因此追加一层「只有容器内的插件才持有」的
 * 共享密钥：
 *   - 网关启动时生成/读取 256 位随机密钥，落盘为 0600 文件；
 *   - 插件每次调用前读取该文件，通过 `x-dsh-internal-token` 头带上；
 *   - 校验使用常量时间比较，且仍然要求来源是回环地址（纵深防御）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TOKEN_FILE = path.join(process.env.DSH_HOME || '/root', '.dsh/.internal-api-token');

function tokenFilePath() {
  return process.env.DSH_INTERNAL_TOKEN_FILE || DEFAULT_TOKEN_FILE;
}

let cachedToken = null;

/** 读取已存在的密钥；不存在或为空返回 null */
function readToken() {
  try {
    const raw = fs.readFileSync(tokenFilePath(), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** 生成并落盘一个新密钥（0600）；返回密钥字符串 */
function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const file = tokenFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {}
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return token;
}

/**
 * 返回当前生效的内部密钥（首次调用时生成并持久化，之后复用）。
 * 持久化保证网关重启后插件无需重新学习密钥；0600 权限保证同容器内的其它非 root 用户读不到。
 */
function getInternalToken() {
  if (cachedToken) return cachedToken;
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

/** 校验请求携带的内部密钥是否正确 */
function verifyInternalToken(req) {
  const provided = req && req.headers ? req.headers['x-dsh-internal-token'] : undefined;
  if (typeof provided !== 'string' || !provided) return false;
  return safeEqualStr(provided.trim(), getInternalToken());
}

module.exports = {
  tokenFilePath,
  getInternalToken,
  readToken,
  verifyInternalToken
};
