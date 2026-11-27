#!/usr/bin/env node
/**
 * needle-scan.mjs — 客户端 Bundle 未修补 Loopback/Memory Needle 残留扫描器。
 *
 * v1.0.0 移除了代理层对 JS 响应的全量内存缓冲与动态字符串替换，恢复原生 br/gzip 压缩透传。
 * 本扫描器在构建期（--build）与版本切换后扫描客户端 JS 产物，确保不存在遗漏的
 * `isLoopbackHostname(pageLocation.hostname)` 或 `connection.isLoopback ? "host" : "memory"`。
 *
 * 用法：
 *   node scripts/lib/needle-scan.mjs [--build] [--dir <path>] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NEEDLES = Object.freeze([
  'isLoopbackHostname(pageLocation.hostname)',
  'connection.isLoopback ? "host" : "memory"',
  'ctx.remote.$host.isLoopback ? "host" : "memory"'
]);

const SKIP_DIRS = new Set(['src', 'test', 'tests', '__tests__', 'docs', 'examples', '.git']);
const JS_EXT_RE = /\.(?:js|mjs|cjs)$/i;

/**
 * 扫描单个目录下的运行期 JS 文件（跳过 src/、测试目录、.dsh-orig 备份与 .map）。
 * @param {string} baseDir
 * @param {{ needles?: readonly string[], followSymlinks?: boolean }} [opts]
 */
export function scanDirectory(baseDir, opts = {}) {
  const needles = opts.needles || NEEDLES;
  const residues = [];
  let filesScanned = 0;
  const visitedReal = new Set();

  if (!baseDir || !fs.existsSync(baseDir)) {
    return { dir: baseDir, exists: false, filesScanned: 0, residues: [] };
  }

  function walk(dir) {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visitedReal.has(real)) return;
    visitedReal.add(real);

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const fullPath = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(fullPath);
        continue;
      }

      if (ent.isSymbolicLink() && opts.followSymlinks !== false) {
        try {
          const st = fs.statSync(fullPath);
          if (st.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) walk(fullPath);
            continue;
          }
          if (!st.isFile()) continue;
        } catch {
          continue;
        }
      } else if (!ent.isFile()) {
        continue;
      }

      if (!JS_EXT_RE.test(ent.name)) continue;
      if (ent.name.endsWith('.dsh-orig')) continue;

      let content;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }
      filesScanned++;

      for (const needle of needles) {
        if (content.includes(needle)) {
          residues.push({ file: fullPath, needle });
        }
      }
    }
  }

  walk(baseDir);
  return { dir: baseDir, exists: true, filesScanned, residues };
}

export function resolveDefaultScanDirs(env = process.env) {
  const onlyDir = env.DSH_PATCH_ONLY_DIR;
  if (onlyDir) {
    return [
      path.join(onlyDir, 'dsh/node_modules/@deepseek-ai'),
      onlyDir
    ].filter((d) => {
      try { return fs.existsSync(d); } catch { return false; }
    });
  }

  const installDir = env.DSH_INSTALL_DIR || '/usr/local';
  const candidates = [
    path.join(installDir, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
    path.join(installDir, 'lib/node_modules/@deepseek-ai'),
    '/usr/local/lib/node_modules/dshmarket',
    '/usr/local/lib/node_modules/@hytime/dsh-thinking-effort',
    '/app/plugins'
  ];

  const out = [];
  const seen = new Set();
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (!fs.existsSync(dir)) continue;
      const real = fs.realpathSync(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(dir);
    } catch {}
  }
  return out;
}

export function scanDefaultDirs(opts = {}) {
  const dirs = Array.isArray(opts.dirs) && opts.dirs.length > 0
    ? opts.dirs
    : resolveDefaultScanDirs(opts.env || process.env);

  let totalFiles = 0;
  const allResidues = [];
  const seenKey = new Set();
  const checkedDirs = [];

  for (const dir of dirs) {
    const res = scanDirectory(dir, opts);
    if (!res.exists) continue;
    checkedDirs.push(dir);
    totalFiles += res.filesScanned;
    for (const r of res.residues) {
      let realFile = r.file;
      try { realFile = fs.realpathSync(r.file); } catch {}
      const key = `${realFile}::${r.needle}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      allResidues.push(r);
    }
  }

  return {
    ok: allResidues.length === 0,
    checkedDirs,
    filesScanned: totalFiles,
    needleResidue: allResidues.length,
    residues: allResidues
  };
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  const isBuild = argv.includes('--build');
  const isJson = argv.includes('--json');
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      dirs.push(argv[++i]);
    } else if (argv[i].startsWith('--dir=')) {
      dirs.push(argv[i].slice('--dir='.length));
    }
  }

  const report = scanDefaultDirs({ dirs });

  if (isJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(
      `[needle-scan] 扫描完成: 目录 ${report.checkedDirs.length} 个，JS 文件 ${report.filesScanned} 个，残留 needle ${report.needleResidue} 处`
    );
    for (const r of report.residues) {
      console.error(`[needle-scan] [FAIL] 发现未修补残留: ${r.file} -> ${r.needle}`);
    }
  }

  if (isBuild && report.checkedDirs.length === 0) {
    console.error('[needle-scan] [FATAL] --build 模式下未找到任何可扫描的 DSH 目录');
    process.exit(1);
  }
  if (!report.ok) {
    process.exit(1);
  }
  process.exit(0);
}
