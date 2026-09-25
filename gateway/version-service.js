const fs = require('fs');
const path = require('path');

function parseSemver(v = '') {
  const clean = String(v).replace(/^v/, '').trim();
  const [main, pre] = clean.split('-');
  const [major = 0, minor = 0, patch = 0] = (main || '').split('.').map(n => Number(n) || 0);
  return { major, minor, patch, pre: pre || '' };
}

/**
 * 严格 semver 校验（只接受 1.2.3 / v1.2.3 / 1.2.3-rc.1）。
 * parseSemver 会把非法值静默降级为 0.0.0，若直接拿它比较，远端一个畸形版本号
 * 就会造成"误报有新版本"，因此比较前必须先确认两边都是合法 semver。
 */
function isSemver(v) {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(v ?? '').trim());
}

function compareSemver(v1, v2) {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  if (p1.patch !== p2.patch) return p1.patch - p2.patch;
  if (!p1.pre && p2.pre) return 1;
  if (p1.pre && !p2.pre) return -1;
  return p1.pre.localeCompare(p2.pre);
}

/**
 * 匹配单条 semver 表达式（`>=` / `>` / `<=` / `<` / `=` / 裸版本号）。
 * 同时支持**空格分隔的复合 AND 区间**（npm semver 语义），例如
 * `">=0.1.2-rc.1 <=0.1.7-rc.2"` 会被拆成两个 term 逐条 AND 求值。
 *
 * 修复前：`p.slice(2).trim()` 会把 `">=0.1.2-rc.1 <=0.1.7-rc.2"` 的剩余部分
 * 当成版本号交给 parseSemver，后者静默降级为 `0.1.2`，导致 `0.2.0`（本应硬阻断）
 * 被误判为落在区间内（返回 true，应为 false）。
 */
function matchSemverPattern(ver, pattern) {
  if (!ver || !pattern) return false;
  const p = String(pattern).trim();
  if (!p) return false;

  // 复合区间：空白分隔 = AND（支持多空格 / Tab / 换行）。逐 term 求值后取与。
  // 单 term 不会进入该分支，因此不存在递归失控。
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
 * 求值复合区间（空格分隔 = AND）。`version.json` 的 `supportedDshRange`
 * 这类字段必须用它判定，而不是裸用 matchSemverPattern：区间求值前先做
 * isSemver 守卫，避免非法版本号被 parseSemver 静默降级成 0.0.0 后误判。
 *
 * @param {string} version 待判定版本号，如 '0.1.7-rc.2'
 * @param {string} range   区间表达式，如 '>=0.1.2-rc.1 <=0.1.7-rc.2'
 * @returns {boolean} 版本是否满足区间内**全部**约束
 */
function satisfiesRange(version, range) {
  if (!isSemver(version) || !range) return false;
  const terms = String(range).trim().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => matchSemverPattern(version, term));
}

class VersionService {
  constructor() {
    this.cacheTTL = 10 * 60 * 1000; // 10 分钟缓存
    this.cachedMeta = null;
    this.lastFetched = 0;
    this.inFlightFetch = null;
    this._isRemoteMeta = false;
  }

  getLiveMeta() {
    return this.cachedMeta || this.getLocalMeta();
  }

  isUsingRemoteMeta() {
    return Boolean(this._isRemoteMeta && this.cachedMeta);
  }

  getLocalProjectVersion() {
    try {
      const pkgPath = path.join(__dirname, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.version) return pkg.version;
      }
    } catch (e) {
      console.warn('[version-service] 读取本地 package.json 版本失败:', e.message);
    }
    return '0.1.9';
  }

  getLocalMeta() {
    const candidatePaths = [
      path.join(__dirname, '../version.json'),
      path.join(__dirname, 'version.json'),
      '/app/version.json',
      '/workspace/deepseek-harness-docker/version.json'
    ];
    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      } catch (e) {
        console.warn(`[version-service] 读取本地版本元数据失败 (${p}):`, e.message);
      }
    }
    return {
      project: 'deepseek-harness-docker',
      repo: {
        projectUrl: 'https://github.com/misaka-link/deepseek-harness-docker',
        projectReleases: 'https://github.com/misaka-link/deepseek-harness-docker/releases',
        upstreamRepo: 'https://github.com/deepseek-ai/deepseek-harness',
        upstreamReleases: 'https://github.com/deepseek-ai/deepseek-harness/releases',
        upstreamNpm: 'https://www.npmjs.com/package/@deepseek-ai/dsh'
      },
      latest: {
        version: this.getLocalProjectVersion(),
        releaseDate: '2026-09-21',
        releaseUrl: 'https://github.com/misaka-link/deepseek-harness-docker/releases/tag/v0.1.4',
        changelog: 'Admin 配置权威收敛、桌面生命周期健壮性重构、安全与容器工程加固、移动端适配优化',
        changelogList: [
          '确立「Admin 为唯一权威」配置模型：桌面开关/分辨率/休眠/CDP/截图画质等统一由管理后台持久化并即时生效',
          '重构虚拟桌面生命周期管理：消除并发竞争死锁，支持优雅停止与进程回收，增强崩溃自愈能力',
          '新增管理员初始化口令向导 (/setup)，废除默认弱口令并强化安全持久化',
          '容器安全加固：支持非 root 用户 (dsh:1001) 运行，默认剔除多余特权 (cap_drop ALL)',
          '移动端进行了简单适配',
          '控制台日志终端体验优化：新增自动滚动记忆开关，优化渲染性能，翻阅历史日志更平稳',
          '修复预装插件及社区插件在特定运行配置下未能正常加载的问题',
          '预装插件跟随最新版本，供应链锁定核心引擎并强化完整性校验与构建上下文精简'
        ]
      },
      history: {
        '0.1.2': {
          version: '0.1.2',
          releaseDate: '2026-09-18',
          releaseUrl: 'https://github.com/misaka-link/deepseek-harness-docker/releases/tag/v0.1.2'
        },
        '0.1.1': {
          version: '0.1.1',
          releaseDate: '2026-09-15',
          releaseUrl: 'https://github.com/misaka-link/deepseek-harness-docker/releases/tag/v0.1.1'
        }
      },
      compatibility: {
        recommendedDsh: '0.1.7-rc.2',
        supportedDshRange: '>=0.1.2-rc.1 <=0.1.7-rc.2',
        adaptedVersions: ['0.1.7-rc.2', '0.1.7-rc.1', '0.1.7-alpha.2', '0.1.7-alpha.1', '0.1.6-alpha.2', '0.1.6-alpha.1', '0.1.5-rc.2', '0.1.5-rc.1', '0.1.2-rc.1'],
        rules: [
          {
            pattern: '<0.1.5-rc.1',
            level: 'warning',
            title: '向后降级格式风险',
            message: '官方自 0.1.5-rc.1 起采用了全新的会话存储结构，向下降级至 0.1.5 以下可能导致新会话解析异常。'
          },
          {
            pattern: '<0.1.7-alpha.1',
            level: 'warning',
            title: '会话格式 V4 降级风险',
            message: '官方 0.1.7 起会话日志升级为 V4，且为单向迁移。降级到 0.1.6 及以下将无法读取已在 0.1.7 中新建或迁移的会话；如需回滚请连同数据卷快照一并恢复。'
          },
          {
            pattern: '>=0.2.0',
            level: 'danger',
            title: '底层架构重大重构 · 不再兼容在线切换',
            message: '官方 DSH 0.2.x 调整了底层架构与通信协议，当前 Docker 镜像底座无法直接在线热切换。切勿在线强制切换，请重新拉取最新 Docker 镜像重新部署！',
            action: 'force-docker-pull'
          }
        ]
      }
    };
  }

  async fetchRemoteMeta(force = false) {
    const now = Date.now();
    if (!force && this.cachedMeta && (now - this.lastFetched < this.cacheTTL)) {
      return this.cachedMeta;
    }

    if (this.inFlightFetch) {
      return this.inFlightFetch;
    }

    if (force) {
      // 强制刷新时，异步触发 jsDelivr 缓存清理
      try {
        fetch('https://purge.jsdelivr.net/gh/misaka-link/deepseek-harness-docker@main/version.json').catch(() => {});
      } catch {}
    }

    this.inFlightFetch = (async () => {
      const ts = Date.now();
      // 多通道降级策略: 实时 GitHub Raw -> ghproxy 镜像 -> jsDelivr CDN
      const endpoints = [
        `https://raw.githubusercontent.com/misaka-link/deepseek-harness-docker/main/version.json?_=${ts}`,
        `https://ghproxy.net/https://raw.githubusercontent.com/misaka-link/deepseek-harness-docker/main/version.json?_=${ts}`,
        'https://fastly.jsdelivr.net/gh/misaka-link/deepseek-harness-docker@main/version.json',
        'https://cdn.jsdelivr.net/gh/misaka-link/deepseek-harness-docker@main/version.json'
      ];

      const local = this.getLocalMeta();

      for (const url of endpoints) {
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
          if (resp.ok) {
            const data = await resp.json();
            if (data && data.project && data.latest && data.latest.version) {
              // 防 CDN 脏缓存保护：若远端版本比本地已知最新版本还旧，判定为 CDN 历史缓存，跳过并尝试下一个通道
              if (compareSemver(data.latest.version, local.latest?.version || '0.0.0') < 0) {
                console.warn(`[version-service] 通道 ${url} 返回陈旧版本 (v${data.latest.version} < 本地已知 v${local.latest?.version})，跳过该通道`);
                continue;
              }

              if (!data.latest.changelogList && local.latest?.changelogList) {
                data.latest.changelogList = local.latest.changelogList;
              }
              if (!data.latest.dshChangelogList && local.latest?.dshChangelogList) {
                data.latest.dshChangelogList = local.latest.dshChangelogList;
              }
              if (!data.history && local.history) {
                data.history = local.history;
              }
              this.cachedMeta = data;
              this.lastFetched = Date.now();
              this._isRemoteMeta = true;
              return data;
            }
          }
        } catch (e) {
          // 降级尝试下一个通道
        }
      }

      // 所有远端通道未连通时，优雅回退本地元数据
      this.cachedMeta = local;
      this.lastFetched = Date.now();
      this._isRemoteMeta = false;
      return local;
    })().finally(() => {
      this.inFlightFetch = null;
    });

    return this.inFlightFetch;
  }

  evaluateTargetVersion(targetVersion, meta = null) {
    const m = meta || this.getLiveMeta();
    const rules = m.compatibility?.rules || [];
    const adapted = m.compatibility?.adaptedVersions || [
      '0.1.7-rc.2',
      '0.1.7-rc.1',
      '0.1.7-alpha.2',
      '0.1.7-alpha.1',
      '0.1.6-alpha.2',
      '0.1.6-alpha.1',
      '0.1.5-rc.2',
      '0.1.5-rc.1',
      '0.1.2-rc.1'
    ];

    const isAdapted = adapted.includes(targetVersion);

    // 匹配命中规则 (强制按从高危到低危排序，保证 danger 规则永远优先命中)
    const severityWeights = { danger: 3, warning: 2, info: 1 };
    const sortedRules = [...rules].sort((a, b) => (severityWeights[b.level] || 0) - (severityWeights[a.level] || 0));
    for (const rule of sortedRules) {
      if (matchSemverPattern(targetVersion, rule.pattern)) {
        return {
          level: rule.level || 'warning',
          title: rule.title || '版本兼容性提示',
          message: rule.message || '',
          action: rule.action || '',
          isAdapted
        };
      }
    }

    if (!isAdapted) {
      return {
        level: 'warning',
        title: '未经特殊适配版本',
        message: `目标版本 v${targetVersion} 尚未收录在官方深度适配列表中，若切换请留意官方变更说明。`,
        action: '',
        isAdapted: false
      };
    }

    return {
      level: 'success',
      title: '官方深度适配',
      message: `目标版本 v${targetVersion} 为官方深度适配版本，当前 Docker 镜像底座完全兼容，无需更新容器即可在线切换。`,
      action: 'online-switch',
      isAdapted: true
    };
  }

  async check(force = false, dshManager = null) {
    const meta = await this.fetchRemoteMeta(force);
    const currentProjectVer = this.getLocalProjectVersion();
    const latestProjectVer = meta.latest?.version || currentProjectVer;
    const hasProjectUpdate = isSemver(latestProjectVer) && isSemver(currentProjectVer)
      && compareSemver(latestProjectVer, currentProjectVer) > 0;

    let projectLevel = 'success';
    if (hasProjectUpdate) {
      projectLevel = 'info';
    }

    // DSH 状态研判
    let currentDshVer = 'unknown';
    let latestDshVer = '';
    let isDshAdapted = false;
    let dshLevel = 'success';
    let dshNotice = null;

    if (dshManager) {
      try {
        currentDshVer = dshManager.getCurrentVersion();
        const dshData = await dshManager.fetchAvailableVersions(false, meta);
        latestDshVer = dshData.latest || '';
        const hasDshUpdate = Boolean(latestDshVer && isSemver(latestDshVer) && isSemver(currentDshVer)
          && compareSemver(latestDshVer, currentDshVer) > 0);
        
        const evalRes = this.evaluateTargetVersion(currentDshVer, meta);
        isDshAdapted = evalRes.isAdapted;

        if (evalRes.level === 'danger') {
          dshLevel = 'danger';
          dshNotice = evalRes;
        } else if (evalRes.level === 'warning') {
          dshLevel = 'warning';
          dshNotice = evalRes;
        } else if (hasDshUpdate) {
          dshLevel = 'info';
          dshNotice = {
            level: 'info',
            title: '发现 DSH 官方新版本',
            message: `官方已发布新版本 v${latestDshVer}，当前运行版本为 v${currentDshVer}。`
          };
        }
      } catch (err) {
        // 不再静默吞异常：DSH 版本研判失败要留下痕迹（安全降级为"无更新提示"）
        console.warn('[version-service] DSH 版本研判失败(已降级为无更新提示):', err.message);
      }
    }

    // 综合判定全局安全级别
    let overallLevel = 'success';
    if (projectLevel === 'danger' || dshLevel === 'danger') {
      overallLevel = 'danger';
    } else if (projectLevel === 'warning' || dshLevel === 'warning') {
      overallLevel = 'warning';
    } else if (projectLevel === 'info' || dshLevel === 'info') {
      overallLevel = 'info';
    }

    // 依据是否有新版，动态提供对应版本的更新内容说明与清单
    const currentHist = meta.history?.[currentProjectVer];
    const updateTitle = hasProjectUpdate
      ? `新版本 (v${latestProjectVer}) 更新内容`
      : `当前版本 (v${currentProjectVer}) 更新内容`;
    const activeReleaseDate = (hasProjectUpdate ? meta.latest?.releaseDate : (currentHist?.releaseDate || meta.latest?.releaseDate)) || '';
    const activeReleaseUrl = (hasProjectUpdate ? meta.latest?.releaseUrl : (currentHist?.releaseUrl || meta.latest?.releaseUrl)) || meta.repo?.projectReleases || 'https://github.com/misaka-link/deepseek-harness-docker/releases';
    const activeChangelog = (hasProjectUpdate ? meta.latest?.changelog : (currentHist?.changelog || meta.latest?.changelog)) || '';
    const activeChangelogList = (hasProjectUpdate ? meta.latest?.changelogList : (currentHist?.changelogList || meta.latest?.changelogList)) || [activeChangelog || '功能优化与安全增强'];

    return {
      ok: true,
      project: {
        current: currentProjectVer,
        latest: latestProjectVer,
        hasUpdate: hasProjectUpdate,
        level: projectLevel,
        updateTitle,
        releaseDate: activeReleaseDate,
        releaseUrl: activeReleaseUrl,
        changelog: activeChangelog,
        changelogList: activeChangelogList,
        projectUrl: meta.repo?.projectUrl || 'https://github.com/misaka-link/deepseek-harness-docker',
        projectReleases: meta.repo?.projectReleases || 'https://github.com/misaka-link/deepseek-harness-docker/releases'
      },
      dsh: {
        current: currentDshVer,
        latest: latestDshVer,
        hasUpdate: Boolean(latestDshVer && compareSemver(latestDshVer, currentDshVer) > 0),
        isAdapted: isDshAdapted,
        level: dshLevel,
        notice: dshNotice,
        changelogList: meta.latest?.dshChangelogList || [
          '新增 Web 侧边栏“插件管理页”，支持 profile 插件动态启停与热装卸',
          '新增右侧边栏 Office 文档 (.docx / .xlsx / .pptx) 原生 WASM 高清预览',
          '新增会话回合文件改动审阅卡片与 Review Tab 逐文件代码对比',
          '支持右侧边栏沙箱浏览器 (ui-sidebar-browser) 与会话流预览',
          '对齐原生 DeepSeek-V41-Flash 与 DeepSeek-V4-Pro 最新模型支持'
        ],
        upstreamRepo: meta.repo?.upstreamRepo || 'https://github.com/deepseek-ai/deepseek-harness',
        upstreamReleases: meta.repo?.upstreamReleases || 'https://github.com/deepseek-ai/deepseek-harness/releases',
        upstreamNpm: meta.repo?.upstreamNpm || 'https://www.npmjs.com/package/@deepseek-ai/dsh'
      },
      compatibility: meta.compatibility || {},
      overallLevel,
      timestamp: Date.now()
    };
  }
}

const versionService = new VersionService();

// ── 导出面 ────────────────────────────────────────────────────────────────
// 向后兼容：默认导出仍是 VersionService 单例，
//   const versionService = require('./version-service');
//   versionService.getLiveMeta() / .check() / .evaluateTargetVersion() / ...
// 全部保持 100% 可用。
// 同时把纯函数挂载到单例上，使外部模块可解构复用：
//   const { satisfiesRange, compareSemver } = require('./version-service');
versionService.parseSemver = parseSemver;
versionService.isSemver = isSemver;
versionService.compareSemver = compareSemver;
versionService.matchSemverPattern = matchSemverPattern;
versionService.satisfiesRange = satisfiesRange;

module.exports = versionService;
