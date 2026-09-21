'use strict';

/**
 * WebSocket 同源校验（防 Cross-Site WebSocket Hijacking / CSWSH）。
 *
 * 设计要点（M2）：
 *  - **绝不采用 `x-forwarded-host`**：该头可由客户端伪造、或经反向代理原样透传，
 *    一旦用它参与比较，攻击者只要把它设成自己页面的域名就能绕过 Origin 校验。
 *  - 只认「真实 `host` 头」+「显式配置的对外主机名（PUBLIC_HOST / config.publicHost）」。
 *  - 回环来源（127.0.0.1 / ::1）额外允许 localhost 变体，便于本机调试。
 *  - 浏览器发起的握手必然携带 Origin；无 Origin 的是非浏览器客户端（Node/ws、CLI），
 *    拿不到受害者 Cookie，不构成 CSWSH，放行。
 */

const net = require('net');

/** 规范化 IP：剥离 IPv4-mapped IPv6 前缀 / 端口 / 方括号；非 IP 返回 '' */
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

function isLoopbackPeer(req) {
  const peer = normalizeIp(req && req.socket && req.socket.remoteAddress);
  return peer === '127.0.0.1' || peer === '::1';
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {string[]} publicHosts 显式允许的对外主机名（不含协议）
 * @returns {boolean}
 */
function isAllowedWsOrigin(req, publicHosts = []) {
  const origin = req && req.headers ? req.headers['origin'] : undefined;
  if (!origin) return true;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const allowed = new Set();
  if (req.headers['host']) allowed.add(String(req.headers['host']).toLowerCase());
  for (const h of publicHosts) {
    if (h) allowed.add(String(h).toLowerCase());
  }
  if (isLoopbackPeer(req)) {
    allowed.add('127.0.0.1');
    allowed.add('localhost');
    allowed.add('[::1]');
  }

  const originHost = parsed.host.toLowerCase();
  const originHostname = parsed.hostname.toLowerCase();
  return allowed.has(originHost) || allowed.has(originHostname);
}

module.exports = { isAllowedWsOrigin, normalizeIp, isLoopbackPeer };
