#!/usr/bin/env node
/**
 * 网关反代上游响应头超时 (504)、快速失败 (502)、WS 握手超时与慢速流式响应保护测试。
 * 用法: node tests/unit/proxy-timeout.test.mjs
 */
import http from 'node:http';
import net from 'node:net';
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
function startFront(targetPort) {
  const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:' + targetPort, ws: false, changeOrigin: true });
  proxy.on('proxyReq', (p, req) => { req.__p = p; });
  proxy.on('proxyRes', (pr, req) => { if (req.__t) { clearTimeout(req.__t); req.__t = null; } });
  proxy.on('error', (e, req, res) => {
    if (req && req.__t) { clearTimeout(req.__t); req.__t = null; }
    if (req && req.__timedout) return;
    if (res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"upstream_error"}'); }
  });
  return http.createServer((req, res) => {
    let fired = false;
    const t = setTimeout(() => {
      if (fired || res.headersSent || res.writableEnded) return;
      fired = true; req.__timedout = true;
      try { req.__p && req.__p.destroy(); } catch {}
      res.writeHead(504, { 'Content-Type': 'application/json' }); res.end('{"error":"upstream_timeout"}');
    }, TIMEOUT);
    req.__t = t;
    proxy.web(req, res);
  });
}
function req(port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; });
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0, body: s }));
    });
    r.on('error', (e) => resolve({ status: 'ERR', err: e.message, ms: Date.now() - t0 }));
    r.end();
  });
}

const servers = [];
try {
  const okUp = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/plain' }); s.end('hello'); });
  servers.push(okUp);
  const fa = startFront(await listen(okUp)); servers.push(fa);
  const ra = await req(await listen(fa));
  ok(ra.status === 200 && ra.body === 'hello', 'A. 正常上游返回 200 hello');

  const hangUp = http.createServer(() => {}); servers.push(hangUp);
  const fb = startFront(await listen(hangUp)); servers.push(fb);
  const rb = await req(await listen(fb));
  ok(rb.status === 504 && /upstream_timeout/.test(rb.body || ''), 'B. 上游挂起超时返回 504');

  const fc = startFront(1); servers.push(fc);
  const rc = await req(await listen(fc));
  ok(rc.status === 502 && rc.ms < TIMEOUT, 'C. 上游拒绝快速返回 502');

  const silent = net.createServer((sock) => { sock.on('data', () => {}); }); servers.push(silent);
  const wproxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:' + await listen(silent), ws: true });
  wproxy.on('proxyReqWs', (proxyReq, q) => {
    q.__wsReq = proxyReq;
    const clear = () => { if (q.__wsT) { clearTimeout(q.__wsT); q.__wsT = null; } };
    proxyReq.on('upgrade', () => { q.__wsOpened = true; clear(); });
    proxyReq.on('response', clear); proxyReq.on('error', clear); proxyReq.on('close', clear);
  });
  wproxy.on('error', () => {});
  const wfront = http.createServer(); servers.push(wfront);
  wfront.on('upgrade', (q, socket, head) => {
    q.__wsT = setTimeout(() => {
      if (q.__wsOpened) return;
      try { q.__wsReq && q.__wsReq.destroy(); } catch {}
      try { socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n'); } catch {}
    }, TIMEOUT);
    if (q.__wsT.unref) q.__wsT.unref();
    socket.on('close', () => { if (q.__wsT) { clearTimeout(q.__wsT); q.__wsT = null; } });
    wproxy.ws(q, socket, head);
  });
  const wPort = await listen(wfront);
  const rw = await new Promise((resolve) => {
    const s = net.connect(wPort, '127.0.0.1', () => {
      s.write('GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + Buffer.from('1234567890123456').toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n')) { resolve(buf.split('\r\n')[0]); s.destroy(); } });
    s.on('error', () => {});
    setTimeout(() => { resolve(buf.split('\r\n')[0] || 'TIMEOUT'); try { s.destroy(); } catch {} }, TIMEOUT + 2500);
  });
  ok(/504/.test(rw), 'D. WS 握手超时返回 504');

  const streamUp = http.createServer((q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/plain' });
    s.write('chunk1;');
    setTimeout(() => { s.write('chunk2;'); s.end('done'); }, TIMEOUT + 500);
  }); servers.push(streamUp);
  const fe = startFront(await listen(streamUp)); servers.push(fe);
  const re = await req(await listen(fe));
  ok(re.status === 200 && /chunk1;.*chunk2;.*done/.test(re.body || ''), 'E. 慢速流式响应不被超时误杀');
} finally {
  for (const s of servers) { try { s.close(); } catch {} }
}
console.log(`\n[proxy-timeout] pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
