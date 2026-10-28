/**
 * 回归测试：网关 DSH 反代「上游等响应头超时」逻辑（Issue #14 配套）。
 * 用 http-proxy + 本地假上游验证：
 *   A 正常上游 → 200
 *   B 连上但不回包 → 超时返回 504（而非无限挂起）
 *   C 上游拒绝连接 → 快速 502（非 504）
 * 用法: node scripts/proxy-timeout-test.mjs
 */
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const httpProxy = require(path.join(here, '../gateway/node_modules/http-proxy'));

const TIMEOUT = 800;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };

function listen(srv) { return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port))); }
function startFront(targetPort) {
  const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:' + targetPort, ws: false, changeOrigin: true });
  proxy.on('proxyReq', (p, req) => { req.__p = p; });
  proxy.on('proxyRes', (pr, req) => { if (req.__t) { clearTimeout(req.__t); req.__t = null; } });
  proxy.on('error', (e, req, res) => {
    if (req && req.__t) { clearTimeout(req.__t); req.__t = null; }
    if (req && req.__timedout) return;
    if (res && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"upstream_error"}'); }
  });
  const srv = http.createServer((req, res) => {
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
  return srv;
}
function req(port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request({ host: '127.0.0.1', port, path: '/' }, (res) => { let s = ''; res.on('data', d => s += d); res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0, body: s })); });
    r.on('error', e => resolve({ status: 'ERR', err: e.message, ms: Date.now() - t0 }));
    r.end();
  });
}

(async () => {
  const servers = [];
  console.log('\n=== A. 正常上游 → 200 ===');
  const okUp = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/plain' }); s.end('hello'); });
  const okPort = await listen(okUp); servers.push(okUp);
  const fa = startFront(okPort); const faPort = await listen(fa); servers.push(fa);
  const ra = await req(faPort);
  ok(ra.status === 200 && ra.body === 'hello', 'A 返回 200 hello（实际 ' + ra.status + ' ' + ra.ms + 'ms）');

  console.log('\n=== B. 连上不回包 → 超时 504 ===');
  const hangUp = http.createServer(() => { /* never respond */ });
  const hangPort = await listen(hangUp); servers.push(hangUp);
  const fb = startFront(hangPort); const fbPort = await listen(fb); servers.push(fb);
  const rb = await req(fbPort);
  ok(rb.status === 504, 'B 返回 504（实际 ' + rb.status + '）');
  ok(rb.ms >= TIMEOUT * 0.8 && rb.ms < TIMEOUT + 3000, 'B 在超时附近返回（实际 ' + rb.ms + 'ms）');
  ok(/upstream_timeout/.test(rb.body || ''), 'B body 标记 upstream_timeout');

  console.log('\n=== C. 上游拒绝 → 快速 502 ===');
  const fc = startFront(1); const fcPort = await listen(fc); servers.push(fc); // port 1 无人监听 → ECONNREFUSED
  const rc = await req(fcPort);
  ok(rc.status === 502, 'C 返回 502（实际 ' + rc.status + '）');
  ok(rc.ms < TIMEOUT, 'C 快速失败（实际 ' + rc.ms + 'ms）');

  console.log('\n=== D. WS 握手不回 101 → 超时关闭 504 ===');
  const silent = net.createServer((sock) => { sock.on('data', () => { /* never respond */ }); });
  const silentPort = await listen(silent); servers.push(silent);
  const wproxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:' + silentPort, ws: true });
  wproxy.on('proxyReqWs', (proxyReq, req) => {
    req.__wsReq = proxyReq;
    const clear = () => { if (req.__wsT) { clearTimeout(req.__wsT); req.__wsT = null; } };
    proxyReq.on('upgrade', () => { req.__wsOpened = true; clear(); });
    proxyReq.on('response', clear);
    proxyReq.on('error', clear);
    proxyReq.on('close', clear);
  });
  wproxy.on('error', () => {});
  const wfront = http.createServer();
  wfront.on('upgrade', (req, socket, head) => {
    const t = setTimeout(() => {
      if (req.__wsOpened) return;
      try { req.__wsReq && req.__wsReq.destroy(); } catch {}
      try { socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n'); } catch {}
    }, TIMEOUT);
    if (t.unref) t.unref();
    req.__wsT = t;
    socket.on('close', () => { if (req.__wsT) { clearTimeout(req.__wsT); req.__wsT = null; } });
    wproxy.ws(req, socket, head);
  });
  const wfrontPort = await listen(wfront); servers.push(wfront);
  const wsProbe = (port) => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + Buffer.from('1234567890123456').toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = ''; const t0 = Date.now();
    s.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n')) { resolve({ head: buf.split('\r\n')[0], ms: Date.now() - t0 }); s.destroy(); } });
    s.on('close', () => { if (!buf) resolve({ head: 'CLOSED_EMPTY', ms: Date.now() - t0 }); });
    s.on('error', () => {});
    setTimeout(() => { resolve({ head: (buf.split('\r\n')[0] || 'TIMEOUT'), ms: Date.now() - t0 }); try { s.destroy(); } catch {} }, TIMEOUT + 3000);
  });
  const rw = await wsProbe(wfrontPort);
  ok(/504/.test(rw.head), 'D WS 握手超时返回 504（实际 ' + rw.head + ' / ' + rw.ms + 'ms）');

  console.log('\n=== E. 流式响应（头先到、数据慢 > 超时）不被误杀 ===');
  const streamUp = http.createServer((q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/plain' });
    s.write('chunk1;');
    setTimeout(() => { s.write('chunk2;'); s.end('done'); }, TIMEOUT + 700); // 数据间隔 > 超时
  });
  const streamPort = await listen(streamUp); servers.push(streamUp);
  const fe = startFront(streamPort); const fePort = await listen(fe); servers.push(fe);
  const re = await req(fePort);
  ok(re.status === 200, 'E 仍返回 200（实际 ' + re.status + '）');
  ok(/chunk1;.*chunk2;.*done/.test(re.body || ''), 'E 完整收到慢速流式数据（实际 "' + (re.body || '').slice(0, 40) + '"）');

  for (const s of servers) { try { s.close(); } catch {} }
  console.log('\n[proxy-timeout] pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
