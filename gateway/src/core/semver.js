'use strict';

/**
 * Unified SemVer 2.0 parsing, comparison, and range matching utilities.
 */

const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isSemver(v) {
  return SEMVER_RE.test(String(v ?? '').trim());
}

function parseSemver(v = '') {
  const clean = String(v).replace(/^v/, '').trim();
  const dashIdx = clean.indexOf('-');
  const main = dashIdx === -1 ? clean : clean.slice(0, dashIdx);
  const pre = dashIdx === -1 ? '' : clean.slice(dashIdx + 1);
  const [major = 0, minor = 0, patch = 0] = (main || '').split('.').map((n) => Number(n) || 0);
  return { major, minor, patch, pre };
}

/**
 * SemVer 2.0 section 11 prerelease precedence comparison:
 * - Split by '.'; shorter list has lower precedence when prefix matches.
 * - Numeric identifiers are compared numerically (alpha.2 < alpha.10).
 * - Numeric identifiers always have lower precedence than non-numeric identifiers.
 * - Non-numeric identifiers are compared lexically in ASCII sort order.
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

/**
 * Match a version against a single comparator (>=, >, <=, <, =, exact)
 * or whitespace-separated AND terms.
 */
function matchSemverPattern(ver, pattern) {
  if (!ver || !pattern) return false;
  const p = String(pattern).trim();
  if (!p) return false;

  const terms = p.split(/\s+/).filter(Boolean);
  if (terms.length > 1) {
    return terms.every((term) => matchSemverPattern(ver, term));
  }

  if (p.startsWith('>=')) return compareSemver(ver, p.slice(2).trim()) >= 0;
  if (p.startsWith('>')) return compareSemver(ver, p.slice(1).trim()) > 0;
  if (p.startsWith('<=')) return compareSemver(ver, p.slice(2).trim()) <= 0;
  if (p.startsWith('<')) return compareSemver(ver, p.slice(1).trim()) < 0;
  if (p.startsWith('=')) return compareSemver(ver, p.slice(1).trim()) === 0;
  return compareSemver(ver, p) === 0;
}

/**
 * Evaluate a whitespace-separated AND range expression with strict isSemver guard.
 */
function satisfiesRange(version, range) {
  if (!isSemver(version) || !range) return false;
  const terms = String(range).trim().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => matchSemverPattern(version, term));
}

module.exports = {
  parseSemver,
  comparePrerelease,
  compareSemver,
  isSemver,
  matchSemverPattern,
  satisfiesRange
};
