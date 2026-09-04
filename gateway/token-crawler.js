const fs = require('fs');

const LOG_FILE = process.env.DSH_WEB_LOG || '/tmp/dsh-web.log';
const TOKEN_FILE_AUTO = process.env.DSH_TOKEN_FILE_AUTO || '/tmp/dsh-launch-token';
const HARD_TOKEN = process.env.DSH_TOKEN || '';

const DEFAULT_TOKEN_RE = /(?:[?&,]|^)token[=:]\s*["']?([A-Za-z0-9._~-]{16,})/i;

let state = {
  token: '',
  upstreamCookie: '',
  source: null,
  fetchingCookie: false
};

function readTail(filePath, maxBytes = 256 * 1024) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const st = fs.statSync(filePath);
    if (!st.size) return '';
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function scanTokenOnce() {
  if (HARD_TOKEN) {
    state.token = HARD_TOKEN;
    state.source = 'env';
    return HARD_TOKEN;
  }

  const text = readTail(LOG_FILE);
  if (!text) return null;

  const matches = [...text.matchAll(new RegExp(DEFAULT_TOKEN_RE, 'g'))];
  if (matches.length > 0) {
    const latest = matches[matches.length - 1][1].trim();
    if (latest) {
      state.token = latest;
      state.source = 'log';
      try { fs.writeFileSync(TOKEN_FILE_AUTO, latest); } catch {}
      return latest;
    }
  }
  return null;
}

function getLaunchToken() {
  if (state.token) return state.token;
  return scanTokenOnce();
}

async function ensureUpstreamCookie(dshOrigin = 'http://127.0.0.1:3079') {
  if (state.upstreamCookie) return state.upstreamCookie;
  if (state.fetchingCookie) return '';

  const token = getLaunchToken();
  if (!token) return '';

  state.fetchingCookie = true;
  try {
    const targetUrl = `${dshOrigin}/?token=${encodeURIComponent(token)}`;
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: { 'Host': '127.0.0.1:3079' },
      redirect: 'manual'
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookieHeader = res.headers.get('set-cookie') || '';
    const allCookies = setCookies.length > 0 ? setCookies : [cookieHeader];

    for (const sc of allCookies) {
      if (sc && sc.includes('dsh-auth-')) {
        const cookiePair = sc.split(';')[0].trim();
        state.upstreamCookie = cookiePair;
        console.log(`[token-crawler] 成功换取 DSH 上游会话 Cookie: ${cookiePair.slice(0, 25)}...`);
        return cookiePair;
      }
    }
  } catch (err) {
    console.error('[token-crawler] 换取上游会话 Cookie 失败:', err.message);
  } finally {
    state.fetchingCookie = false;
  }
  return state.upstreamCookie;
}

function getCachedUpstreamCookie() {
  return state.upstreamCookie;
}

// Polyfill for non-secure contexts (LAN IP / plain HTTP) and native __DSH_TRANSPORT__
const RANDOM_UUID_POLYFILL = `<script>
// 1. DSH 官方预留扩展锚点：显式声明拥有宿主回环控制权 (零侵入启用 host 模式，彻底免去源码修补)
globalThis.__DSH_TRANSPORT__ = { ownsHost: true };

// 2. crypto.randomUUID Polyfill for HTTP/LAN non-secure context
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
</script>`;

function injectPolyfill(html) {
  const headIdx = html.toLowerCase().indexOf('<head');
  if (headIdx !== -1) {
    const endIdx = html.indexOf('>', headIdx);
    if (endIdx !== -1) {
      return html.slice(0, endIdx + 1) + RANDOM_UUID_POLYFILL + html.slice(endIdx + 1);
    }
  }
  return RANDOM_UUID_POLYFILL + html;
}

module.exports = {
  getLaunchToken,
  ensureUpstreamCookie,
  getCachedUpstreamCookie,
  RANDOM_UUID_POLYFILL,
  injectPolyfill
};
