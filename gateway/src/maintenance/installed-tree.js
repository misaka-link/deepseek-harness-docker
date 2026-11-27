'use strict';
/**
 * 已安装依赖树的文件级入口完整性校验。
 */

const fs = require('node:fs');
const path = require('node:path');

function entryTargets(manifest) {
  if (!manifest || typeof manifest.main !== 'string' || !manifest.main.trim()) return [];
  return [manifest.main.trim()];
}

function resolves(pkgDir, rel) {
  const clean = String(rel).replace(/^\.\//, '');
  const candidates = [
    clean,
    clean + '.js',
    clean + '.cjs',
    clean + '.mjs',
    clean + '.json',
    clean.replace(/\.js$/, '.mjs'),
    clean.replace(/\.js$/, '.cjs'),
    path.join(clean, 'index.js'),
    path.join(clean, 'index.cjs'),
    path.join(clean, 'index.mjs')
  ];
  for (const c of candidates) {
    try {
      const st = fs.statSync(path.join(pkgDir, c));
      if (st.isFile() && st.size > 0) return true;
    } catch {}
  }
  return false;
}

function fileLevelGaps(nodeModulesDir) {
  const gaps = [];
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return ['.node_modules'];
  }

  const checkOne = (name) => {
    const pkgDir = path.join(nodeModulesDir, name);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch {
      gaps.push(name + ':package.json');
      return;
    }
    for (const rel of entryTargets(manifest)) {
      if (!resolves(pkgDir, rel)) {
        gaps.push(name + ':' + rel);
        return;
      }
    }
  };

  for (const ent of entries) {
    if (ent.name === '.bin' || ent.name.startsWith('.')) continue;
    if (ent.name.startsWith('@')) {
      let subs = [];
      try { subs = fs.readdirSync(path.join(nodeModulesDir, ent.name), { withFileTypes: true }); } catch { continue; }
      for (const s of subs) {
        if (s.isDirectory() || s.isSymbolicLink()) checkOne(ent.name + '/' + s.name);
      }
    } else if (ent.isDirectory() || ent.isSymbolicLink()) {
      checkOne(ent.name);
    }
  }
  return gaps;
}

module.exports = { fileLevelGaps, entryTargets, resolves };
