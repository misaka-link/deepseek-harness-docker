'use strict';

/**
 * HTML-only first-chunk polyfill injection for DSH Web:
 *   1. Official host-transport anchor: globalThis.__DSH_TRANSPORT__ = { ownsHost: true }
 *   2. crypto.randomUUID polyfill for non-secure HTTP/LAN contexts
 *   3. HTTPS WebSocket ws:// -> wss:// upgrade shim
 *
 * Non-HTML assets (JS/CSS/plugins) are never buffered or rewritten here and stream natively.
 */

const zlib = require('zlib');

const WS_UPGRADE_SHIM = `(function() {
  try {
    var loc = typeof window !== "undefined" && window.location ? window.location : (typeof location !== "undefined" ? location : null);
    if (!loc || loc.protocol !== "https:") return;
    if (typeof WebSocket === "undefined") return;
    if (WebSocket.__dsh_wss_shimmed) return;

    var OrigWebSocket = WebSocket;
    var PatchedWebSocket = function(url, protocols) {
      var targetUrl = url;
      try {
        if (typeof url === "string") {
          var parsed = new URL(url, loc.href);
          if (parsed.protocol === "ws:") {
            parsed.protocol = "wss:";
            targetUrl = parsed.toString();
          }
        } else if (typeof URL !== "undefined" && url instanceof URL) {
          if (url.protocol === "ws:") {
            var copy = new URL(url.toString());
            copy.protocol = "wss:";
            targetUrl = copy;
          }
        }
      } catch (err) {}

      if (protocols !== undefined) {
        return new OrigWebSocket(targetUrl, protocols);
      }
      return new OrigWebSocket(targetUrl);
    };

    PatchedWebSocket.prototype = OrigWebSocket.prototype;
    for (var key in OrigWebSocket) {
      if (Object.prototype.hasOwnProperty.call(OrigWebSocket, key)) {
        PatchedWebSocket[key] = OrigWebSocket[key];
      }
    }
    PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING !== undefined ? OrigWebSocket.CONNECTING : 0;
    PatchedWebSocket.OPEN = OrigWebSocket.OPEN !== undefined ? OrigWebSocket.OPEN : 1;
    PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING !== undefined ? OrigWebSocket.CLOSING : 2;
    PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED !== undefined ? OrigWebSocket.CLOSED : 3;

    PatchedWebSocket.__dsh_wss_shimmed = true;
    if (typeof window !== "undefined") window.WebSocket = PatchedWebSocket;
    if (typeof globalThis !== "undefined") globalThis.WebSocket = PatchedWebSocket;
  } catch (e) {}
})();`;

const RANDOM_UUID_POLYFILL = `<script>
// 1. Official DSH transport anchor declaring host ownership
globalThis.__DSH_TRANSPORT__ = { ownsHost: true };

// 2. crypto.randomUUID polyfill for non-secure HTTP/LAN contexts
(function(){
  try {
    if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID !== "function") {
      crypto.randomUUID = function() {
        var b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 15) | 64;
        b[8] = (b[8] & 63) | 128;
        var h = "";
        for (var i = 0; i < 16; i++) {
          h += b[i].toString(16).padStart(2, "0");
        }
        return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
      };
    }
  } catch (e) {}
})();

// 3. WebSocket wss:// upgrade shim
${WS_UPGRADE_SHIM}
</script>`;

function injectPolyfill(html) {
  const str = String(html || '');
  const headIdx = str.toLowerCase().indexOf('<head');
  if (headIdx !== -1) {
    const endIdx = str.indexOf('>', headIdx);
    if (endIdx !== -1) {
      return str.slice(0, endIdx + 1) + RANDOM_UUID_POLYFILL + str.slice(endIdx + 1);
    }
  }
  return RANDOM_UUID_POLYFILL + str;
}

function getEncodingType(encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (!enc || enc === 'identity') return null;
  const first = enc.split(',')[0].trim();
  if (first === 'gzip' || first === 'x-gzip') return 'gzip';
  if (first === 'deflate') return 'deflate';
  if (first === 'br') return 'br';
  return 'unknown';
}

function decompressBuffer(buf, encType) {
  if (encType === 'gzip') return zlib.gunzipSync(buf);
  if (encType === 'deflate') {
    try {
      return zlib.inflateSync(buf);
    } catch {
      return zlib.inflateRawSync(buf);
    }
  }
  if (encType === 'br') return zlib.brotliDecompressSync(buf);
  throw new Error(`Unsupported encoding type: ${encType}`);
}

function runDecompressStream(rawBuffer, createStreamFn) {
  return new Promise((resolve, reject) => {
    const out = [];
    const stream = createStreamFn();
    stream.on('data', (chunk) => out.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(out)));
    stream.on('error', reject);
    stream.end(rawBuffer);
  });
}

async function decompressBufferAsync(rawBuffer, encType) {
  if (encType === 'gzip') {
    return runDecompressStream(rawBuffer, () => zlib.createGunzip());
  }
  if (encType === 'br') {
    return runDecompressStream(rawBuffer, () => zlib.createBrotliDecompress());
  }
  if (encType === 'deflate') {
    try {
      return await runDecompressStream(rawBuffer, () => zlib.createInflate());
    } catch {
      return runDecompressStream(rawBuffer, () => zlib.createInflateRaw());
    }
  }
  throw new Error(`Unsupported encoding type: ${encType}`);
}

/**
 * Attach HTML polyfill injection hooks onto a proxied text/html response.
 * - Uncompressed HTML: streaming first-chunk injection (zero buffering).
 * - Compressed HTML (fallback if upstream ignores identity): streaming zlib decompression + injection.
 * - Unknown encoding: untouched passthrough.
 */
function attachHtmlInjection(proxyRes, res) {
  const origCe = proxyRes.headers['content-encoding'];
  const encType = getEncodingType(origCe);

  // Prevent browser caching of HTML entry points so revised asset bundles always resolve
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (!encType) {
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');

    let injected = false;
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = function (chunk, ...rest) {
      if (!injected && chunk) {
        injected = true;
        const htmlStr = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        chunk = Buffer.from(injectPolyfill(htmlStr), 'utf8');
      }
      return origWrite(chunk, ...rest);
    };

    res.end = function (chunk, ...rest) {
      if (!injected && chunk) {
        injected = true;
        const htmlStr = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        chunk = Buffer.from(injectPolyfill(htmlStr), 'utf8');
      }
      return origEnd(chunk, ...rest);
    };
    return;
  }

  if (encType === 'unknown') {
    console.warn(`[html-inject] 检测到未知内容编码 (${origCe})，跳过 HTML 注入以防损坏响应`);
    return;
  }

  delete proxyRes.headers['content-length'];
  res.removeHeader('content-length');
  delete proxyRes.headers['content-encoding'];
  res.removeHeader('content-encoding');

  const chunks = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  res.write = function (chunk) {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return true;
  };

  res.end = function (chunk, ...rest) {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    res.write = origWrite;
    res.end = origEnd;

    const rawBuffer = Buffer.concat(chunks);
    decompressBufferAsync(rawBuffer, encType)
      .then((decompressed) => {
        if (res.writableEnded) return;
        const htmlStr = injectPolyfill(decompressed.toString('utf8'));
        try {
          origEnd(Buffer.from(htmlStr, 'utf8'), ...rest);
        } catch (writeErr) {
          console.warn('[html-inject] HTML 写出失败:', writeErr && writeErr.message);
          try {
            res.destroy();
          } catch {}
        }
      })
      .catch((err) => {
        // Headers are already sent; never call setHeader here. Fall back safely to raw bytes.
        console.warn(`[html-inject] 解压上游 HTML 失败 (${encType}):`, err && err.message, '，回退原样透传');
        if (res.writableEnded) return;
        try {
          origEnd(rawBuffer, ...rest);
        } catch (writeErr) {
          console.warn('[html-inject] HTML 兜底写出失败:', writeErr && writeErr.message);
          try {
            res.destroy();
          } catch {}
        }
      });
  };
}

module.exports = {
  WS_UPGRADE_SHIM,
  RANDOM_UUID_POLYFILL,
  injectPolyfill,
  getEncodingType,
  decompressBuffer,
  decompressBufferAsync,
  attachHtmlInjection
};
