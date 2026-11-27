'use strict';
/**
 * legacy-links.js — 老快照软链自动修复与非 root 路径重定位。
 *
 * 1. 100% 保留逃出归档根的相对软链原地改写为等价绝对软链（仅限白名单目标）。
 * 2. 新增：当 DSH_HOME !== '/root'（即 DSH_DIR !== LEGACY_DSH_DIR）时，将指向
 *    /root/.dsh/... 的绝对软链（以及经 LEGACY_DSH_DIR 解析到 /root/.dsh/... 的相对软链）
 *    重定位到当前 $DSH_DIR/...，防止非 root 部署还原旧快照后出现悬空软链。
 */

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../core/paths');
const {
  ALLOWED_ARCHIVE_PREFIX,
  toPosix,
  getLegacyDshDir,
  getArchiveRootBases,
  isAllowedAbsoluteLinkTarget
} = require('./archive-validate');

function relocateLegacyRootTarget(absTarget, currentDshDir, legacyDshDir) {
  if (!absTarget || !currentDshDir || !legacyDshDir || currentDshDir === legacyDshDir) {
    return absTarget;
  }
  const normCurrent = toPosix(currentDshDir).replace(/\/+$/, '');
  const normLegacy = toPosix(legacyDshDir).replace(/\/+$/, '');
  if (normCurrent === normLegacy) return absTarget;
  if (absTarget === normLegacy) return normCurrent;
  if (absTarget.startsWith(normLegacy + '/')) {
    return normCurrent + absTarget.slice(normLegacy.length);
  }
  return absTarget;
}

/**
 * 在 staging 沙箱内修复逃出归档根的相对软链，并重定位跨 DSH_HOME 的绝对软链。
 * @param {string} stagedDsh staging 目录里的 `.dsh` 绝对路径
 * @returns {{ repaired: number, relocated: number, kept: number, samples: string[] }}
 */
function repairEscapingRelativeLinks(stagedDsh) {
  const report = { repaired: 0, relocated: 0, kept: 0, samples: [] };
  const currentDshDir = paths.getDshDir();
  const legacyDshDir = getLegacyDshDir();
  const rootBases = getArchiveRootBases();

  const stack = [stagedDsh];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target = null;
        try { target = fs.readlinkSync(p); } catch { continue; }
        if (!target) continue;

        const memberName = ALLOWED_ARCHIVE_PREFIX + '/' + toPosix(path.relative(stagedDsh, p));

        // 情形 A：绝对软链指向 /root/.dsh/... 且当前 DSH_DIR !== /root/.dsh → 重定位至当前 DSH_DIR
        if (target.startsWith('/')) {
          const normalized = path.posix.normalize(target);
          const relocated = relocateLegacyRootTarget(normalized, currentDshDir, legacyDshDir);
          if (relocated !== normalized && isAllowedAbsoluteLinkTarget(relocated)) {
            try {
              fs.unlinkSync(p);
              fs.symlinkSync(relocated, p);
              report.repaired += 1;
              report.relocated += 1;
              if (report.samples.length < 20) report.samples.push(`${memberName} -> ${relocated} (relocated)`);
            } catch (e) {
              report.kept += 1;
              console.warn(`[backup-links] 绝对软链重定位失败（保持原样）: ${memberName}: ${e.message}`);
            }
          }
          continue;
        }

        // 情形 B：归档内部相对引用，无需改写
        const insideArchive = path.posix.normalize(path.posix.join(path.posix.dirname(memberName), target));
        if (insideArchive.startsWith(ALLOWED_ARCHIVE_PREFIX + '/')) continue;

        // 情形 C：逃出归档根的相对软链 → 按真实还原落点解析成等价绝对路径并套用白名单
        const memberDirInArchive = path.posix.dirname(memberName);
        let resolved = null;
        for (const base of rootBases) {
          const candidate = path.posix.resolve(
            path.posix.join(toPosix(path.posix.dirname(toPosix(base))), memberDirInArchive),
            target
          );
          if (isAllowedAbsoluteLinkTarget(candidate)) {
            resolved = relocateLegacyRootTarget(candidate, currentDshDir, legacyDshDir);
            break;
          }
        }
        if (!resolved) {
          report.kept += 1;
          continue;
        }
        try {
          fs.unlinkSync(p);
          fs.symlinkSync(resolved, p);
          report.repaired += 1;
          if (report.samples.length < 20) report.samples.push(`${memberName} -> ${resolved}`);
        } catch (e) {
          report.kept += 1;
          console.warn(`[backup-links] 相对软链改写失败（保持原样）: ${memberName}: ${e.message}`);
        }
      } else if (entry.isDirectory()) {
        stack.push(p);
      }
    }
  }
  return report;
}

module.exports = {
  relocateLegacyRootTarget,
  repairEscapingRelativeLinks
};
