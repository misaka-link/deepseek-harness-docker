'use strict';
/**
 * DSH 版本号与路径安全校验工具（纯函数、无副作用）。
 */
const path = require('node:path');

// 严格 semver：主.次.补 [-预发布] [+构建]；拒绝路径分隔符、`..`、`npm:` 别名、空白与超长串
const VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

function isValidVersion(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return false;
  return VERSION_RE.test(v);
}

function resolveWithinDir(baseDir, name) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, String(name));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`非法路径（越界）: ${String(name).slice(0, 64)}`);
  }
  return target;
}

module.exports = { isValidVersion, resolveWithinDir, VERSION_RE };
