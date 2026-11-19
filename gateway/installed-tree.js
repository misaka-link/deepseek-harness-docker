/**
 * 已安装依赖树的**文件级**完整性校验（Issue #18 同类问题的纵深防御）。
 *
 * 为什么不能只看「包目录在不在」：
 *   npm/pnpm 解包是逐文件写入的。进程在解包途中被杀，会留下「package.json 在、index.js 缺」的半成品；
 *   只看目录存在 → 判健康 → 补写签名 → 之后每次运行都 MODULE_NOT_FOUND，且再也不会重装。
 *
 * 为什么也不能只看 node_modules/.package-lock.json：
 *   实测（npm 11，增量 reify 全程 50ms 轮询）该文件在 reify **过程中始终存在**（是上一次安装留下的旧锁），
 *   并不是「装完才出现」的完成标记，无法区分「装到一半」与「装完」。
 *
 * 因此这里做的是：对每个顶层包，解析其 main/exports/bin 指向的文件，确认存在且非空。
 * 只检查入口文件（不递归整个包），兼顾成本与召回：入口缺失正是「解包中断」最典型的表现。
 *
 * @module installed-tree
 */

const fs = require('fs');
const path = require('path');

/** 收集一个包声明过的入口文件（相对包根） */
function entryTargets(manifest) {
  // 只认显式且非空的 main：
  //   - 无 main（如 pnpm / 原生插件包）：入口由 bin 或 exports 决定，这里不判，避免误删
  //   - 有 exports：入口映射复杂，静态解析易误判，同样跳过
  //   - @types/* 这类纯类型包：main 为空，跳过
  if (!manifest || typeof manifest.main !== 'string' || !manifest.main.trim()) return [];
  return [manifest.main.trim()];
}

/** 解析相对路径到真实文件（支持省略扩展名与目录 index） */
function resolves(pkgDir, rel) {
  const clean = String(rel).replace(/^\.\//, '');
  const candidates = [clean, clean + '.js', clean + '.cjs', clean + '.mjs', clean + '.json',
    clean.replace(/\.js$/, '.mjs'), clean.replace(/\.js$/, '.cjs'),
    path.join(clean, 'index.js'), path.join(clean, 'index.cjs'), path.join(clean, 'index.mjs')];
  for (const c of candidates) {
    try {
      const st = fs.statSync(path.join(pkgDir, c));
      if (st.isFile() && st.size > 0) return true;
    } catch {}
  }
  return false;
}

/**
 * 返回文件级缺口列表（空数组 = 入口文件齐全）。
 * @param {string} nodeModulesDir 形如 <installDir>/node_modules
 */
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
