/**
 * 单一 SemVer 比较实现（version-service / dsh-manager / snapshot-manifest 共用）。
 *
 * 为什么要有这个文件：这三处原本各抄了一份 `compareSemver`，且都用
 * `pre.localeCompare(pre)` 比预发布段 —— 那是字典序，于是 "alpha.10" < "alpha.3"，
 * 与 semver 规范相反。后果不是"排序难看"，而是**版本判定反向**：
 *   - 管理面板 DSH「发现新版 / 已是最新」会误报（把 alpha.2 报成比 alpha.10 新）
 *   - 版本下拉列表顺序错乱
 *   - 快照按引擎版本排序 / 回滚目标选择错位
 * 2026-11 只修了 version-service 一份，另两份仍在用旧逻辑，行为已分叉；
 * 抽成单一模块后不可能再出现"修了一份漏两份"。
 */

function parseSemver(v = '') {
  const clean = String(v).replace(/^v/, '').trim();
  const [main, pre] = clean.split('-');
  const [major = 0, minor = 0, patch = 0] = (main || '').split('.').map(n => Number(n) || 0);
  return { major, minor, patch, pre: pre || '' };
}

/**
 * 预发布标识比较（严格按 semver 2.0 §11）：
 *   - 按 `.` 分段逐段比较，段数少者（前缀相同时）更小；
 *   - 纯数字段按**数值**比（alpha.2 < alpha.10）；
 *   - 数字段的优先级**低于**含字母的段；
 *   - 其余按 ASCII 字典序。
 */
function comparePrerelease(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const isNum = (s) => /^[0-9]+$/.test(s);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = isNum(x);
    const yn = isNum(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function compareSemver(v1, v2) {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  if (p1.patch !== p2.patch) return p1.patch - p2.patch;
  if (!p1.pre && p2.pre) return 1;
  if (p1.pre && !p2.pre) return -1;
  return comparePrerelease(p1.pre, p2.pre);
}

module.exports = { parseSemver, comparePrerelease, compareSemver };
