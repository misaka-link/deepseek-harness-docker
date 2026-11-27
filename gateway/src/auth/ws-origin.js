'use strict';

/**
 * WebSocket Origin verification (CSWSH protection).
 * Strictly ignores x-forwarded-host (client-spoofable); only trusts the real Host header,
 * explicitly configured publicHosts, and loopback localhost variants for loopback peers.
 */

const net = require('net');

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
 * @param {string[]} [publicHosts]
 * @returns {boolean}
 */
function isAllowedWsOrigin(req, publicHosts = []) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (!origin) return true;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const allowed = new Set();
  if (req.headers.host) allowed.add(String(req.headers.host).toLowerCase());
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

module.exports = {
  isAllowedWsOrigin,
  normalizeIp,
  isLoopbackPeer
};
