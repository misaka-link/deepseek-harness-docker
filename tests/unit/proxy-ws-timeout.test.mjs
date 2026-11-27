#!/usr/bin/env node
/**
 * WS 握手边界回归测试（101 长连接保活 + 401 透传）。
 * 用法: node tests/unit/proxy-ws-timeout.test.mjs
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const httpProxy = require(path.join(root, 'gateway/node_modules/http-proxy'));

const TIMEOUT = 600;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

function makeWsFront(targetPort) {
  const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:' + targetPort, ws: true });
  proxy.on('proxyReqWs', (proxyReq, req) => {
    req.__wsReq = proxyReq;
    const clear = () => { if (req.__wsT) { clearTimeout(req.__wsT); req.__wsT = null; } };
    proxyReq.on('upgrade', () => { req.__wsOpened = true; clear(); });
    proxyReq.on('response', clear); proxyReq.on('error', clear); proxyReq.on('close', clear);
  });
  proxy.on('error', () => {});
  const srv = http.createServer();
  srv.on('upgrade', (req, socket, head) => {
    req.__wsT = setTimeout(() => {
      if (req.__wsOpened) return;
      try { req.__wsReq && req.__wsReq.destroy(); } catch {}
      try { socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n'); } catch {}
    }, TIMEOUT);
    if (req.__wsT.unref) req.__wsT.unref();
    socket.on('close', () => { if (req.__wsT) { clearTimeout(req.__wsT); req.__wsT = null; } });
    proxy.ws(req, socket, head);
  });
  return srv;
}

const servers = [];
try {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const wsUp = net.createServer((sock) => {
    let up = false, buf = '';
    sock.on('data', (d) => {
      if (!up) {
        buf += d.toString();
        if (buf.includes('\r\n\r\n')) {
          const m = buf.match(/Sec-WebSocket-Key:\s*(.*)/i);
          const accept = crypto.createHash('sha1').update((m ? m[1].trim() : '') + GUID).digest('base64');
          sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
          up = true;
        }
      } else sock.write(d);
    });
  });
  servers.push(wsUp);
  const ff = makeWsFront(await listen(wsUp)); servers.push(ff);
  const ffPort = await listen(ff);
  const rf = await new Promise((resolve) => {
    const s = net.connect(ffPort, '127.0.0.1', () => {
      s.write('GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + Buffer.from('abcdefghijklmnop').toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let phase = 0, buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (phase === 0 && buf.includes('101')) { phase = 1; buf = ''; setTimeout(() => { try { s.write('PING_AFTER_TIMEOUT'); } catch {} }, TIMEOUT + 400); }
      else if (phase === 1 && buf.includes('PING_AFTER_TIMEOUT')) { phase = 2; resolve(true); s.destroy(); }
    });
    s.on('error', () => {});
    setTimeout(() => { if (phase < 2) { resolve(false); try { s.destroy(); } catch {} } }, TIMEOUT + 2500);
  });
  ok(rf === true, 'F. WS 101 升级后长连接存活超过超时不被杀');

  const authUp = http.createServer();
  authUp.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); });
  servers.push(authUp);
  const fg = makeWsFront(await listen(authUp)); servers.push(fg);
  const fgPort = await listen(fg);
  const rg = await new Promise((resolve) => {
    const s = net.connect(fgPort, '127.0.0.1', () => {
      s.write('GET /api/remote.mux HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + Buffer.from('abcdefghijklmnop').toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n')) { resolve(buf.split('\r\n')[0]); s.destroy(); } });
    s.on('error', () => {});
    setTimeout(() => resolve(buf.split('\r\n')[0] || 'TIMEOUT'), TIMEOUT + 2000);
  });
  ok(/401/.test(rg) && !/504/.test(rg), 'G. 上游 401 透传而非误报 504');
} finally {
  for (const s of servers) { try { s.close(); } catch {} }
}
console.log(`\n[proxy-ws-timeout] pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
