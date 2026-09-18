const fs = require('fs');
const path = require('path');

function parseSemver(v = '') {
  const clean = String(v).replace(/^v/, '').trim();
  const [main, pre] = clean.split('-');
  const [major = 0, minor = 0, patch = 0] = (main || '').split('.').map(n => Number(n) || 0);
  return { major, minor, patch, pre: pre || '' };
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

function matchSemverPattern(ver, pattern) {
  if (!ver || !pattern) return false;
  const p = String(pattern).trim();
  if (p.startsWith('>=')) return compareSemver(ver, p.slice(2).trim()) >= 0;
  if (p.startsWith('>')) return compareSemver(ver, p.slice(1).trim()) > 0;
  if (p.startsWith('<=')) return compareSemver(ver, p.slice(2).trim()) <= 0;
  if (p.startsWith('<')) return compareSemver(ver, p.slice(1).trim()) < 0;
  if (p.startsWith('=')) return compareSemver(ver, p.slice(1).trim()) === 0;
  return compareSemver(ver, p) === 0;
}

class VersionService {
  constructor() {
    this.cacheTTL = 10 * 60 * 1000; // 10 分钟缓存
    this.cachedMeta = null;
    this.lastFetched = 0;
    this.inFlightFetch = null;
  }

  getLocalProjectVersion() {
    try {
      const pkgPath = path.join(__dirname, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.version) return pkg.version;
      }
    } catch {}
    return '0.1.3';
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
      } catch {}
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
        releaseDate: '2026-09-18',
        releaseUrl: 'https://github.com/misaka-link/deepseek-harness-docker/releases/tag/v0.1.3',
        changelog: '新增配置快照仅备份配置选项、内置插件规范中文描述、插件持久化状态防复活与启动崩溃自愈自动隔离',
        changelogList: [
          '配置快照与备份新增「仅备份配置(无对话内容)」选项，自动排除会话历史与媒体附件，体积轻巧便于迁移分享',
          '内置插件 (@dsh-custom/*) 与官方核心组件功能介绍全面支持规范中文呈现',
          '重构插件管理状态机，在 /root/.dsh/plugins-state.json 中持久化记录已禁用/卸载插件，彻底解决容器更新后插件强制复活问题',
          'Web Admin 拓展管理新增已卸载预装插件展示与一键重新安装支持',
          '新增 DSH 启动崩溃自愈与故障插件自动隔离功能 (实验性)，智能提取错误堆栈并自动停用引发崩溃的拓展',
          '设置面板支持自定义单启动周期自愈隔离数量上限 (默认 5 个)，防止崩溃死锁'
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
        recommendedDsh: '0.1.6-alpha.2',
        supportedDshRange: '>=0.1.2-rc.1 <=0.1.6-alpha.2',
        adaptedVersions: ['0.1.6-alpha.2', '0.1.6-alpha.1', '0.1.5-rc.2', '0.1.5-rc.1', '0.1.2-rc.1'],
        rules: [
          {
            pattern: '<0.1.5-rc.1',
            level: 'warning',
            title: '向后降级格式风险',
            message: '官方自 0.1.5-rc.1 起采用了全新的会话存储结构，向下降级至 0.1.5 以下可能导致新会话解析异常。'
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
      return local;
    })().finally(() => {
      this.inFlightFetch = null;
    });

    return this.inFlightFetch;
  }

  evaluateTargetVersion(targetVersion, meta = null) {
    const m = meta || this.cachedMeta || this.getLocalMeta();
    const rules = m.compatibility?.rules || [];
    const adapted = m.compatibility?.adaptedVersions || [
      '0.1.6-alpha.2',
      '0.1.6-alpha.1',
      '0.1.5-rc.2',
      '0.1.5-rc.1',
      '0.1.2-rc.1'
    ];

    const isAdapted = adapted.includes(targetVersion);

    // 匹配命中规则 (从高危到低危)
    for (const rule of rules) {
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
        message: `目标版本 v${targetVersion} 尚未收录在当前镜像的官方深度适配列表中，建议优先拉取更新 Docker 镜像底座以获得官方优化。`,
        action: 'recommend-docker-pull',
        isAdapted: false
      };
    }

    return {
      level: 'success',
      title: '官方深度适配',
      message: `目标版本 v${targetVersion} 为当前镜像官方深度适配版本。`,
      action: 'online-switch',
      isAdapted: true
    };
  }

  async check(force = false, dshManager = null) {
    const meta = await this.fetchRemoteMeta(force);
    const currentProjectVer = this.getLocalProjectVersion();
    const latestProjectVer = meta.latest?.version || currentProjectVer;
    const hasProjectUpdate = compareSemver(latestProjectVer, currentProjectVer) > 0;

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
        const dshData = await dshManager.fetchAvailableVersions(false);
        latestDshVer = dshData.latest || '';
        const hasDshUpdate = Boolean(latestDshVer && compareSemver(latestDshVer, currentDshVer) > 0);
        
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
        // 静默保护
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

module.exports = new VersionService();
