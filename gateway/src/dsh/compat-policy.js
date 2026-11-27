'use strict';
/**
 * v1.0.0 DSH 引擎兼容性策略（硬下限 + 结构化评估）。
 *
 * 规则：
 *   - 内置硬下限 ENGINE_FLOOR = '0.2.3-alpha.2'；远端矩阵只能收紧（更高 minDsh），不能放宽。
 *   - 优先读取 version.json 的 compatibilityV1 块；仅在自定义测试夹具不含 compatibilityV1 时回退 compatibility。
 *   - 所有评估结果均返回结构化 kind 与 params，供前端多语言本地化展示，不再依赖中文子串判断。
 */

const { compareSemver, isSemver, matchSemverPattern } = require('../core/semver');

const ENGINE_FLOOR = '0.2.3-alpha.2';
const BREAKING_CEILING = '0.3.0';

/**
 * 从元数据中提取 v1 生效的兼容性矩阵，并计算受硬下限约束的 effectiveFloor。
 */
function getEffectiveCompat(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const raw = (m.compatibilityV1 && typeof m.compatibilityV1 === 'object')
    ? m.compatibilityV1
    : (m.compatibility && typeof m.compatibility === 'object' ? m.compatibility : {});

  let effectiveFloor = ENGINE_FLOOR;
  if (isSemver(raw.minDsh) && compareSemver(raw.minDsh, ENGINE_FLOOR) > 0) {
    effectiveFloor = raw.minDsh;
  }

  const rawAdapted = Array.isArray(raw.adaptedVersions) && raw.adaptedVersions.length > 0
    ? raw.adaptedVersions
    : [ENGINE_FLOOR];
  // 过滤掉低于硬下限的历史条目（防止回退到 legacy 块时把旧引擎判为已适配）
  const adaptedVersions = rawAdapted.filter((v) => isSemver(v) && compareSemver(v, effectiveFloor) >= 0);

  const recommendedDsh = (isSemver(raw.recommendedDsh) && compareSemver(raw.recommendedDsh, effectiveFloor) >= 0)
    ? raw.recommendedDsh
    : (adaptedVersions[0] || effectiveFloor);

  const rules = Array.isArray(raw.rules) ? raw.rules : [];

  return {
    schema: raw.schema || 1,
    minDsh: effectiveFloor,
    recommendedDsh,
    supportedDshRange: raw.supportedDshRange || `>=${effectiveFloor} <=${recommendedDsh}`,
    adaptedVersions,
    rules
  };
}

/**
 * 评估目标 DSH 版本在当前 v1 套件中的兼容性等级与结构化类型。
 *
 * @param {string} targetVersion
 * @param {object|null} [meta]
 * @returns {{
 *   level: 'success'|'info'|'warning'|'danger',
 *   kind: 'adapted'|'unadapted'|'engine-unsupported'|'breaking-major'|'invalid-version'|'rule-match',
 *   action: string,
 *   title: string,
 *   message: string,
 *   params: Record<string, any>,
 *   isAdapted: boolean
 * }}
 */
function evaluateTargetVersion(targetVersion, meta = null) {
  const ver = String(targetVersion || '').trim();
  const compat = getEffectiveCompat(meta);
  const floor = compat.minDsh;

  if (!isSemver(ver)) {
    return {
      level: 'danger',
      kind: 'invalid-version',
      action: 'blocked-invalid',
      title: '非法版本号',
      message: `目标版本号格式不合法: ${ver || 'empty'}`,
      params: { version: ver, floor },
      isAdapted: false
    };
  }

  // 1) 硬下限阻断（远端不可放宽）
  if (compareSemver(ver, floor) < 0) {
    return {
      level: 'danger',
      kind: 'engine-unsupported',
      action: 'blocked-legacy',
      title: '不再支持的旧版 DSH 引擎',
      message: `v1.0.0 套件最低支持 @deepseek-ai/dsh@${floor}，目标版本 v${ver} 低于最低要求并已禁止在线切换。如需运行旧版引擎请使用 0.2.x 系列容器镜像。`,
      params: { version: ver, floor },
      isAdapted: false
    };
  }

  const isAdapted = compat.adaptedVersions.includes(ver);

  // 2) 规则列表按高危到低危求值（兼容 pattern 与 range 两种键名）
  const severityWeights = { danger: 3, warning: 2, info: 1 };
  const sortedRules = [...compat.rules].sort(
    (a, b) => (severityWeights[b?.level] || 0) - (severityWeights[a?.level] || 0)
  );
  for (const rule of sortedRules) {
    const pattern = rule && (rule.pattern || rule.range);
    if (!pattern) continue;
    if (matchSemverPattern(ver, pattern)) {
      const level = rule.level || 'warning';
      const kind = rule.kind
        || (rule.action === 'force-docker-pull' || matchSemverPattern(ver, `>=${BREAKING_CEILING}`)
          ? 'breaking-major'
          : 'rule-match');
      const action = rule.action || (kind === 'breaking-major' ? 'force-docker-pull' : '');
      return {
        level,
        kind,
        action,
        title: rule.title || (kind === 'breaking-major' ? '底层协议重大重构 · 不再兼容在线切换' : '版本兼容性提示'),
        message: rule.message || (kind === 'breaking-major'
          ? `目标版本 v${ver} 已跨入破坏性大版本（>=${BREAKING_CEILING}），请更新容器镜像重新部署。`
          : ''),
        params: { version: ver, floor },
        isAdapted
      };
    }
  }

  // 3) 内置 >=0.3.0 破坏性大版本防线（即使远端规则缺失也拦截）
  if (compareSemver(ver, BREAKING_CEILING) >= 0) {
    return {
      level: 'danger',
      kind: 'breaking-major',
      action: 'force-docker-pull',
      title: '底层协议重大重构 · 不再兼容在线切换',
      message: `目标版本 v${ver} 已跨入官方下一轮破坏性重构（${BREAKING_CEILING} 及以上），切勿在线强制切换，请拉取最新 Docker 镜像重新部署。`,
      params: { version: ver, floor },
      isAdapted: false
    };
  }

  // 4) 已深度适配版本
  if (isAdapted) {
    return {
      level: 'success',
      kind: 'adapted',
      action: 'online-switch',
      title: '官方深度适配',
      message: `目标版本 v${ver} 为官方深度适配版本，当前容器底座完全兼容，无需更新镜像即可在线切换。`,
      params: { version: ver, floor },
      isAdapted: true
    };
  }

  // 5) 介于 [floor, 0.3.0) 之间的未收录版本
  return {
    level: 'warning',
    kind: 'unadapted',
    action: '',
    title: '未经特殊适配版本',
    message: `目标版本 v${ver} 尚未收录在官方深度适配列表中，若切换请留意上游变更说明。`,
    params: { version: ver, floor },
    isAdapted: false
  };
}

module.exports = {
  ENGINE_FLOOR,
  BREAKING_CEILING,
  getEffectiveCompat,
  evaluateTargetVersion
};
