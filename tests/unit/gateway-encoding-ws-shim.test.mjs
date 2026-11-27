#!/usr/bin/env node
/**
 * 网关 HTML 垫片注入、wss:// 升级 shim、异步解压与非 HTML 压缩透传判定测试。
 * 用法: node tests/unit/gateway-encoding-ws-shim.test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const {
  RANDOM_UUID_POLYFILL,
  WS_UPGRADE_SHIM,
  injectPolyfill,
  getEncodingType,
  decompressBuffer,
  decompressBufferAsync,
  attachHtmlInjection
} = require(path.join(ROOT, 'gateway/src/proxy/html-inject.js'));
const { shouldDowngradeEncodingForHtml } = require(path.join(ROOT, 'gateway/src/proxy/dsh-proxy.js'));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { fail++; console.log('  ✗ ' + name + '\n      ' + (err && err.stack ? err.stack : err)); }
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url, protocols) {
    this.url = String(url && url.href ? url.href : url);
    this.protocols = protocols;
    this.readyState = MockWebSocket.CONNECTING;
  }
  send() {}
  close() {}
}

console.log('\n[模块 1] WebSocket wss:// 安全升级 shim');
await check('HTTPS 下 ws:// 自动改写为 wss://，保留端口/路径/查询/Hash 与子协议', () => {
  const ctx = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/viewer' } },
    location: { protocol: 'https:', href: 'https://example.com/viewer' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx.globalThis = ctx;
  vm.runInContext(WS_UPGRADE_SHIM, ctx);

  const ws = new ctx.WebSocket('ws://example.com:18443/events/mux?token=abc#live', ['v1']);
  assert.equal(ws.url, 'wss://example.com:18443/events/mux?token=abc#live');
  assert.deepEqual(ws.protocols, ['v1']);
  assert.equal(ws instanceof MockWebSocket, true);
  assert.equal(ctx.WebSocket.OPEN, 1);

  const wsUrlObj = new ctx.WebSocket(new URL('ws://example.com/channel'));
  assert.equal(wsUrlObj.url, 'wss://example.com/channel');
  const wsAlready = new ctx.WebSocket('wss://example.com/ok');
  assert.equal(wsAlready.url, 'wss://example.com/ok');
});

await check('shim 幂等性且 HTTP 下不改写', () => {
  const ctxHttps = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/' } },
    location: { protocol: 'https:', href: 'https://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctxHttps.globalThis = ctxHttps;
  vm.runInContext(WS_UPGRADE_SHIM, ctxHttps);
  const first = ctxHttps.WebSocket;
  vm.runInContext(WS_UPGRADE_SHIM, ctxHttps);
  assert.equal(ctxHttps.WebSocket, first);

  const ctxHttp = vm.createContext({
    window: { location: { protocol: 'http:', href: 'http://example.com/' } },
    location: { protocol: 'http:', href: 'http://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctxHttp.globalThis = ctxHttp;
  vm.runInContext(WS_UPGRADE_SHIM, ctxHttp);
  assert.equal(ctxHttp.WebSocket, MockWebSocket);
});

await check('RANDOM_UUID_POLYFILL 包含 __DSH_TRANSPORT__ 与 __dsh_wss_shimmed', () => {
  assert.ok(RANDOM_UUID_POLYFILL.includes('__dsh_wss_shimmed'));
  const injected = injectPolyfill('<!DOCTYPE html><html><head><title>T</title></head><body></body></html>');
  assert.ok(injected.includes('__DSH_TRANSPORT__') && injected.includes('__dsh_wss_shimmed'));
});

console.log('\n[模块 2] 编码识别、异步解压与非 HTML 压缩透传判定');
await check('shouldDowngradeEncodingForHtml 仅对 HTML 入口降级，JS/CSS/插件保持原样压缩', () => {
  assert.equal(shouldDowngradeEncodingForHtml('/'), true);
  assert.equal(shouldDowngradeEncodingForHtml('/index.html'), true);
  assert.equal(shouldDowngradeEncodingForHtml('/assets/app.js'), false);
  assert.equal(shouldDowngradeEncodingForHtml('/plugins/??a.js'), false);
  assert.equal(shouldDowngradeEncodingForHtml('/assets/style.css'), false);
});

await check('getEncodingType / decompressBuffer / decompressBufferAsync 覆盖 gzip/deflate/br/unknown', async () => {
  assert.equal(getEncodingType('gzip'), 'gzip');
  assert.equal(getEncodingType('deflate'), 'deflate');
  assert.equal(getEncodingType('br'), 'br');
  assert.equal(getEncodingType('identity'), null);
  assert.equal(getEncodingType('zstd'), 'unknown');

  const rawBuf = Buffer.from('<div>Hello DSH</div>', 'utf8');
  assert.equal(decompressBuffer(zlib.gzipSync(rawBuf), 'gzip').toString('utf8'), '<div>Hello DSH</div>');
  assert.equal((await decompressBufferAsync(zlib.gzipSync(rawBuf), 'gzip')).toString('utf8'), '<div>Hello DSH</div>');
  assert.equal((await decompressBufferAsync(zlib.deflateSync(rawBuf), 'deflate')).toString('utf8'), '<div>Hello DSH</div>');
  assert.equal((await decompressBufferAsync(zlib.deflateRawSync(rawBuf), 'deflate')).toString('utf8'), '<div>Hello DSH</div>');
  assert.equal((await decompressBufferAsync(zlib.brotliCompressSync(rawBuf), 'br')).toString('utf8'), '<div>Hello DSH</div>');
});

console.log('\n[模块 3] attachHtmlInjection 真实钩子生命周期');
function createMockRes() {
  const headers = {};
  const chunks = [];
  let headersSent = false;
  let writableEnded = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  return {
    headers,
    done,
    get headersSent() { return headersSent; },
    get writableEnded() { return writableEnded; },
    writeHead(status, hdrs) {
      headersSent = true;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
      return this;
    },
    setHeader(k, v) {
      if (headersSent) throw Object.assign(new Error('headers sent'), { code: 'ERR_HTTP_HEADERS_SENT' });
      headers[k.toLowerCase()] = v;
    },
    removeHeader(k) { delete headers[k.toLowerCase()]; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true; },
    end(c) {
      if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      writableEnded = true;
      resolveDone(Buffer.concat(chunks));
    },
    destroy() { if (!writableEnded) { writableEnded = true; resolveDone(Buffer.concat(chunks)); } }
  };
}

await check('attachHtmlInjection：gzip 压缩 HTML 异步解压注入并移除 Content-Encoding', async () => {
  const html = '<!DOCTYPE html><html><head><title>V</title></head><body>MARKER</body></html>';
  const proxyRes = { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': '99' } };
  const res = createMockRes();
  res.setHeader('content-encoding', 'gzip');
  attachHtmlInjection(proxyRes, res);
  res.writeHead(200, { ...proxyRes.headers });

  const gz = zlib.gzipSync(Buffer.from(html, 'utf8'));
  res.write(gz.subarray(0, 20));
  res.write(gz.subarray(20));
  res.end();

  const finalBuf = await res.done;
  const text = finalBuf.toString('utf8');
  assert.equal(res.getHeader('content-encoding'), undefined);
  assert.ok(text.includes('MARKER') && text.includes('__DSH_TRANSPORT__'));
});

await check('attachHtmlInjection：损坏 gzip 解压失败时不抛错且原样透传', async () => {
  const corrupt = Buffer.from('not-a-valid-gzip-stream');
  const proxyRes = { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } };
  const res = createMockRes();
  attachHtmlInjection(proxyRes, res);
  res.writeHead(200, { ...proxyRes.headers });
  res.write(corrupt);
  res.end();
  const finalBuf = await res.done;
  assert.deepEqual(finalBuf, corrupt);
});

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
