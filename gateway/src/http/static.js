'use strict';

/**
 * Unauthenticated static asset server for /__ui/<rev>/* (and /__ui/latest/*)
 * plus /favicon.svg and /favicon.ico, with strict directory-traversal containment.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveProjectVersion } = require('../core/project-version');

const PUBLIC_ROOT = path.resolve(__dirname, '../../public');
const UI_ROOT = path.resolve(PUBLIC_ROOT, 'ui');

const MIME_TYPES = Object.freeze({
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8'
});

let cachedRev = null;

function walkSortedFiles(dir, baseDir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkSortedFiles(full, baseDir, out);
    } else if (ent.isFile()) {
      out.push({ rel: path.relative(baseDir, full), full });
    }
  }
  return out;
}

function computeUiRev() {
  const hash = crypto.createHash('sha256');
  const files = walkSortedFiles(UI_ROOT, UI_ROOT);
  for (const item of files) {
    hash.update(item.rel);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(item.full));
    } catch {}
    hash.update('\0');
  }
  const digest = hash.digest('hex').slice(0, 8);
  const projVer = resolveProjectVersion();
  return projVer ? `${projVer}-${digest}` : `rev-${digest}`;
}

function getUiRev() {
  if (!cachedRev) {
    cachedRev = computeUiRev();
  }
  return cachedRev;
}

function resetUiRevForTest() {
  cachedRev = null;
}

function safeResolveUnder(rootDir, relPath) {
  if (!relPath || relPath.includes('\0') || relPath.includes('\\')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/');
  if (segments.some((s) => s === '..' || s === '.')) return null;

  const resolved = path.resolve(rootDir, decoded);
  const prefix = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (!resolved.startsWith(prefix)) return null;

  // Verify symlink target remains strictly within rootDir
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync(rootDir);
    realTarget = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  const realPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!realTarget.startsWith(realPrefix)) return null;

  return realTarget;
}

/**
 * Serve GET/HEAD /__ui/<rev>/* (and /__ui/latest/*).
 * Returns true if the request path matched /__ui/* and was handled.
 */
function serveUiAsset(req, res, pathname) {
  if (!pathname.startsWith('/__ui/')) return false;

  const rest = pathname.slice('/__ui/'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
    return true;
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return true;
  }

  const rev = rest.slice(0, slashIdx);
  const relPath = rest.slice(slashIdx + 1);
  const target = safeResolveUnder(UI_ROOT, relPath);
  if (!target) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
    return true;
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
    return true;
  }

  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
    return true;
  }

  const ext = path.extname(target).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const cacheControl = rev === 'latest'
    ? 'no-store, no-cache, must-revalidate'
    : 'public, max-age=31536000, immutable';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff'
  });

  if (method === 'HEAD') {
    res.end();
    return true;
  }

  const stream = fs.createReadStream(target);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (!res.writableEnded) res.end();
  });
  stream.pipe(res);
  return true;
}

function serveFavicon(req, res, pathname) {
  if (pathname !== '/favicon.svg' && pathname !== '/favicon.ico') return false;
  const staticFile = path.join(PUBLIC_ROOT, pathname.slice(1));
  if (!fs.existsSync(staticFile)) return false;

  res.writeHead(200, {
    'Content-Type': pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/x-icon',
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff'
  });
  if (String(req.method || 'GET').toUpperCase() === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(staticFile).pipe(res);
  return true;
}

module.exports = {
  PUBLIC_ROOT,
  UI_ROOT,
  getUiRev,
  computeUiRev,
  resetUiRevForTest,
  serveUiAsset,
  serveFavicon
};
