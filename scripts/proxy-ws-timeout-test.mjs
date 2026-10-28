/**
 * 回归测试（补充）：WS 握手边界
 *   F. 上游 101 升级成功 → 长连接存活超过超时时间不被杀（验证“升级后清除计时器”）
 *   G. 上游返回 401 → 透传 401（非 504）
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const httpProxy = require(path.join(here, '../gateway/node_modules/http-proxy'));

const TIMEOUT = 800;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('   ✔ ' + m); pass++; } else { console.log('   ❌ ' + m); fail++; } };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

function makeWsFront(targetPort) {
  const proxy = httpProxy.createProxyServer({ target: 'http://127.0.0.1:' + targetPort, ws: true });
  proxy.on('proxyReqWs', (proxyReq, req) => {
    req.__wsReq = proxyReq;
    const clear = () => { if (req.__wsT) { clearTimeout(req.__wsT); req.__wsT = null; } };
    proxyReq.on('upgrade', () => { req.__wsOpened = true; clear(); });
    proxyReq.on('response', clear);
    proxyReq.on('error', clear);
    proxyReq.on('close', clear);
  });
  proxy.on('error', () => {});
  const srv = http.createServer();
  srv.on('upgrade', (req, socket, head) => {
    const t = setTimeout(() => {
      if (req.__wsOpened) return;
      try { req.__wsReq && req.__wsReq.destroy(); } catch {}
      try { socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n'); } catch {}
    }, TIMEOUT);
    if (t.unref) t.unref();
    req.__wsT = t;
    socket.on('close', () => { if (req.__wsT) { clearTimeout(req.__wsT); req.__wsT = null; } });
    proxy.ws(req, socket, head);
  });
  return srv;
}

(async () => {
  const servers = [];

  console.log('\n=== F. WS 101 升级成功：长连接存活超过超时不被杀 ===');
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const wsUp = net.createServer((sock) => {
    let up = false, buf = '';
    sock.on('data', (d) => {
      if (!up) {
        buf += d.toString();
        if (buf.includes('\r\n\r\n')) {
          const m = buf.match(/Sec-WebSocket-Key:\s*(.*)/i);
          const key = m ? m[1].trim() : '';
          const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
          sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
          up = true;
        }
      } else { sock.write(d); }
    });
  });
  const wsUpPort = await listen(wsUp); servers.push(wsUp);
  const ff = makeWsFront(wsUpPort); const ffPort = await listen(ff); servers.push(ff);
  const rf = await new Promise((resolve) => {
    const s = net.connect(ffPort, '127.0.0.1', () => {
      s.write('GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + Buffer.from('abcdefghijklmnop').toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let phase = 0, buf = ''; const t0 = Date.now();
    s.on('data', (d) => {
      buf += d.toString();
      if (phase === 0 && buf.includes('101')) { phase = 1; buf = ''; setTimeout(() => { try { s.write('PING_AFTER_TIMEOUT'); } catch {} }, TIMEOUT + 500); }
      else if (phase === 1 && buf.includes('PING_AFTER_TIMEOUT')) { phase = 2; resolve({ ok: true, ms: Date.now() - t0 }); s.destroy(); }
    });
    s.on('error', () => {});
    setTimeout(() => { if (phase < 2) { resolve({ ok: false, phase, buf: buf.slice(0, 60) }); try { s.destroy(); } catch {} } }, TIMEOUT + 3000);
  });
  ok(rf.ok, 'F 101 升级后长连接存活并回显（' + JSON.stringify(rf) + '）');

  console.log('\n=== G. WS 上游返回 401 → 透传 401（非 504） ===');
  const authUp = http.createServer();
  authUp.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); });
  const authPort = await listen(authUp); servers.push(authUp);
  const fg = makeWsFront(authPort); const fgPort = await listen(fg); servers.push(fg);
  const rg = await new Promise((resolve) => {
    const s = net.connect(fgPort, '127.0.0.1', () => {
      s.write('GET /api/remote.mux HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + Buffer.from('abcdefghijklmnop').toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = ''; const t0 = Date.now();
    s.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n')) { resolve({ head: buf.split('\r\n')[0], ms: Date.now() - t0 }); s.destroy(); } });
    s.on('error', () => {});
    setTimeout(() => resolve({ head: buf.split('\r\n')[0] || 'TIMEOUT', ms: Date.now() - t0 }), TIMEOUT + 2000);
  });
  ok(/401/.test(rg.head) && !/504/.test(rg.head), 'G 透传 401（' + rg.head + ' / ' + rg.ms + 'ms）');

  for (const s of servers) { try { s.close(); } catch {} }
  console.log('\n[proxy-ws-timeout] pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
