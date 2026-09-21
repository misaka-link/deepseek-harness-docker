'use strict';
/**
 * DSH 版本号与路径安全工具。
 *
 * 纯函数、无副作用、不依赖任何运行环境，便于单元测试。
 * 背景：/api/dsh/install 的 version 曾只做 trim() 就直接进入
 *   - path.join(versionsCacheDir, version)  → 可用 `../../..` 逃出缓存目录
 *   - `@deepseek-ai/dsh@${version}`         → 可注入 npm 别名等说明符
 * 这里提供统一的强校验，供入口与核心方法双重把关（纵深防御）。
 */
const path = require('path');

// 严格 semver：主.次.补 [-预发布] [+构建]；拒绝路径分隔符、`..`、`npm:` 别名、空白与超长串
const VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/** 是否为可安全使用的 DSH 版本号 */
function isValidVersion(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return false;
  return VERSION_RE.test(v);
}

/**
 * 把 name 解析到 baseDir 之内，越界即抛错（拒绝 `..` 与绝对路径）。
 * @param {string} baseDir 允许的根目录
 * @param {string} name 子路径/名称
 * @returns {string} 解析后的绝对路径
 */
function resolveWithinDir(baseDir, name) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, String(name));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`非法路径（越界）: ${String(name).slice(0, 64)}`);
  }
  return target;
}

module.exports = { isValidVersion, resolveWithinDir, VERSION_RE };
