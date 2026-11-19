'use strict';
/**
 * 套件工程版本（project version）的唯一读取入口。
 *
 * 背景（Issue #19）：工程版本号曾同时存在于 build.sh#PROJ_VER、version.json#latest.version、
 * gateway/package.json#version、CI 默认值以及两处硬编码兜底（version-service.js 的 '0.2.13'、
 * backup-service.js 的 '0.1.9'）共 5+2 份副本。v0.2.14 发版时漏改 gateway/package.json，
 * 导致镜像内「本地版本 0.2.13」与「version.json 的 0.2.14」自相矛盾，管理面板永久误报
 * 「发现新版」，且该错值被写进快照 sidecar 元数据（projectVersion / dockerSuiteVersion）。
 *
 * 设计要点：
 * 1. **单一事实源**：构建期由 build.sh 把 PROJ_VER 通过 --build-arg SUITE_VERSION 注入镜像，
 *    Dockerfile 落到 ENV DSH_SUITE_VERSION。它描述「这个镜像由哪次构建产出」，优先级最高；
 * 2. **只降级、不编造**：其余副本（package.json / version.json）仅作降级来源；全部不可用时
 *    返回 null，由调用方按「版本未知」处理。**严禁再写死具体版本号兜底** —— 硬编码兜底会把
 *    「读不到」伪装成「读到了旧版本」，从而在异常路径下继续制造误报；
 * 3. **漂移可见**：多来源不一致时打一条 warn（含全部来源取值），让漏改在日志里暴露，
 *    而不是静默取其一。CI 侧另有 scripts/suite-version-sync-test.mjs 做发版前硬门禁。
 *
 * @module project-version
 */

const fs = require('fs');
const path = require('path');

/** 构建期注入的环境变量名（Dockerfile ENV / build.sh --build-arg 同源） */
const ENV_KEY = 'DSH_SUITE_VERSION';

/** 与 version-service.js 的 isSemver 保持同一口径：拒绝非法值，避免把脏数据当版本号比较 */
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 归一化：去空白、去前导 v；空值返回 '' */
function normalize(value) {
  const s = String(value ?? '').trim();
  return s ? s.replace(/^v/, '') : '';
}

function isValidProjectVersion(value) {
  return SEMVER_RE.test(normalize(value));
}

/** 同一来源的读取失败只告警一次，避免每请求刷屏，同时保证「不静默吞异常」 */
const readFailureWarned = new Set();
function warnReadFailure(key, message) {
  if (readFailureWarned.has(key)) return;
  readFailureWarned.add(key);
  console.warn(message);
}

/** 来源②：gateway/package.json#version（与镜像同源副本，历史上是唯一来源） */
function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return normalize(pkg.version);
  } catch (e) {
    warnReadFailure('package.json', '[project-version] 读取 gateway/package.json 版本失败: ' + e.message);
    return '';
  }
}

/** 来源③：version.json#latest.version（镜像自带发布元数据；容器内为 /app/version.json） */
function readVersionJsonLatest() {
  const candidates = [
    path.join(__dirname, '../version.json'),
    path.join(__dirname, 'version.json'),
    '/app/version.json'
  ];
  for (const p of candidates) {
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = normalize(meta?.latest?.version);
      if (v) return v;
    } catch (e) {
      // ENOENT 属于正常候选缺失（如容器内无仓库副本），只有「存在但解析失败」才留痕
      if (e && e.code !== 'ENOENT') {
        warnReadFailure(p, '[project-version] 读取套件版本来源失败 (' + p + '): ' + e.message);
      }
      // 继续尝试下一个候选路径
    }
  }
  return '';
}

/** 按优先级排列的取值来源（顺序即权威性） */
const SOURCES = [
  { source: 'env', label: `\${DSH_SUITE_VERSION}`, read: () => normalize(process.env[ENV_KEY]) },
  { source: 'package.json', label: 'gateway/package.json#version', read: readPackageVersion },
  { source: 'version.json', label: 'version.json#latest.version', read: readVersionJsonLatest }
];

let mismatchWarned = false;

/**
 * 解析套件工程版本。
 *
 * @returns {string|null} 合法 semver 字符串；所有来源均不可用时返回 null（调用方须按「未知」处理）
 */
function resolveProjectVersion() {
  const hits = [];
  for (const item of SOURCES) {
    let value = '';
    try {
      value = item.read();
    } catch {
      value = '';
    }
    if (isValidProjectVersion(value)) hits.push({ source: item.source, version: normalize(value) });
  }

  if (hits.length === 0) return null;

  if (!mismatchWarned) {
    const distinct = new Set(hits.map((h) => h.version));
    if (distinct.size > 1) {
      mismatchWarned = true;
      console.warn(
        '[project-version] 套件版本号来源不一致（已采用最高优先级 ' + hits[0].source + '），请检查发版是否漏改：' +
        hits.map((h) => `${h.source}=${h.version}`).join(' | ')
      );
    }
  }

  return hits[0].version;
}

/**
 * 诊断用：返回全部来源的原始取值与最终裁决结果（供 /api 自检与测试断言使用）。
 * @returns {{version: string|null, sources: Array<{source: string, label: string, raw: string, valid: boolean, adopted: boolean}>}}
 */
function describeProjectVersion() {
  const resolved = resolveProjectVersion();
  const sources = SOURCES.map((item) => {
    let raw = '';
    try {
      raw = item.read();
    } catch {
      raw = '';
    }
    const valid = isValidProjectVersion(raw);
    return {
      source: item.source,
      label: item.label,
      raw: normalize(raw),
      valid,
      adopted: valid && resolved !== null && normalize(raw) === resolved
    };
  });
  return { version: resolved, sources };
}

/** 仅测试用：重置「已告警」标记，便于同一进程内多次断言 */
function resetWarnings() {
  mismatchWarned = false;
  readFailureWarned.clear();
}

module.exports = {
  ENV_KEY,
  isValidProjectVersion,
  resolveProjectVersion,
  describeProjectVersion,
  resetWarnings
};
