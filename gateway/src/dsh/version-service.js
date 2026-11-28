'use strict';
/**
 * version-service.js (v1.0.0)
 *
 * - 优先读取 version.json 中的 compatibilityV1 块，并通过 compat-policy 强制执行 ENGINE_FLOOR；
 * - 彻底移除历史 26 项硬编码版本副本与旧版假兜底数据；
 * - 评估与检查结果携带结构化 kind 与 params，供多语言 UI 消费。
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveProjectVersion, describeProjectVersion } = require('../core/project-version');
const {
  parseSemver,
  compareSemver,
  isSemver,
  matchSemverPattern,
  satisfiesRange
} = require('../core/semver');
const {
  ENGINE_FLOOR,
  getEffectiveCompat,
  evaluateTargetVersion: evaluateCompatTarget
} = require('./compat-policy');

class VersionService {
  constructor() {
    this.cacheTTL = 10 * 60 * 1000;
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
    return resolveProjectVersion();
  }

  describeProjectVersion() {
    return describeProjectVersion();
  }

  getLocalMeta() {
    const candidatePaths = [
      process.env.DSH_VERSION_JSON,
      path.join(__dirname, '../../../version.json'),
      '/app/version.json',
      path.join(process.cwd(), 'version.json')
    ].filter(Boolean);

    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      } catch (e) {
        console.warn(`[version-service] 读取本地版本元数据失败 (${p}):`, e.message);
      }
    }

    const localVer = this.getLocalProjectVersion();
    return {
      project: 'deepseek-harness-docker',
      repo: {
        projectUrl: 'https://github.com/misaka-link/deepseek-harness-docker',
        projectReleases: 'https://github.com/misaka-link/deepseek-harness-docker/releases',
        upstreamRepo: 'https://github.com/deepseek-ai/deepseek-harness',
        upstreamReleases: 'https://github.com/deepseek-ai/deepseek-harness/releases',
        upstreamNpm: 'https://www.npmjs.com/package/@deepseek-ai/dsh'
      },
      supply: {
        dshVersion: ENGINE_FLOOR
      },
      latest: {
        version: localVer,
        releaseDate: '',
        releaseUrl: 'https://github.com/misaka-link/deepseek-harness-docker/releases',
        changelog: '',
        changelogList: [],
        dshChangelogList: []
      },
      history: {},
      compatibilityV1: {
        schema: 1,
        minDsh: ENGINE_FLOOR,
        recommendedDsh: ENGINE_FLOOR,
        supportedDshRange: `>=${ENGINE_FLOOR} <=${ENGINE_FLOOR}`,
        adaptedVersions: [ENGINE_FLOOR],
        rules: [
          {
            pattern: `<${ENGINE_FLOOR}`,
            level: 'danger',
            kind: 'engine-unsupported',
            action: 'blocked-legacy'
          },
          {
            pattern: '>=0.3.0',
            level: 'danger',
            kind: 'breaking-major',
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
      try {
        fetch('https://purge.jsdelivr.net/gh/misaka-link/deepseek-harness-docker@main/version.json').catch(() => {});
      } catch {}
    }

    this.inFlightFetch = (async () => {
      const ts = Date.now();
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
              if (!data.compatibilityV1 && local.compatibilityV1) {
                data.compatibilityV1 = local.compatibilityV1;
              }
              this.cachedMeta = data;
              this.lastFetched = Date.now();
              this._isRemoteMeta = true;
              return data;
            }
          }
        } catch {}
      }

      this.cachedMeta = local;
      this.lastFetched = Date.now();
      this._isRemoteMeta = false;
      return local;
    })().finally(() => {
      this.inFlightFetch = null;
    });

    return this.inFlightFetch;
  }

  evaluateTargetVersion(targetVersion, metaOverride = null) {
    const m = metaOverride || this.getLiveMeta();
    return evaluateCompatTarget(targetVersion, m);
  }

  async check(force = false, dshManager = null) {
    const meta = await this.fetchRemoteMeta(force);
    const effectiveCompat = getEffectiveCompat(meta);
    const versionDesc = this.describeProjectVersion();
    const currentProjectVer = versionDesc.version;
    const versionMismatch = Boolean(versionDesc.versionMismatch);
    const rawLatestProjectVer = meta.latest?.version;
    const latestProjectVer = isSemver(rawLatestProjectVer) ? rawLatestProjectVer : currentProjectVer;
    const hasProjectUpdate = Boolean(
      isSemver(latestProjectVer) && isSemver(currentProjectVer)
      && compareSemver(latestProjectVer, currentProjectVer) > 0
    );

    const projectLevel = versionMismatch
      ? 'warning'
      : (hasProjectUpdate ? 'info' : 'success');

    let currentDshVer = 'unknown';
    let latestDshVer = '';
    let isDshAdapted = false;
    let dshLevel = 'success';
    let dshNotice = null;
    let dshHasUpdate = false;

    if (dshManager) {
      try {
        currentDshVer = dshManager.getCurrentVersion();
        const dshData = await dshManager.fetchAvailableVersions(false, meta);
        latestDshVer = dshData.latest || '';
        dshHasUpdate = Boolean(
          latestDshVer && isSemver(latestDshVer) && isSemver(currentDshVer)
          && compareSemver(latestDshVer, currentDshVer) > 0
        );

        const evalRes = this.evaluateTargetVersion(currentDshVer, meta);
        isDshAdapted = evalRes.isAdapted;

        if (evalRes.level === 'danger') {
          dshLevel = 'danger';
          dshNotice = evalRes;
        } else if (evalRes.level === 'warning') {
          dshLevel = 'warning';
          dshNotice = evalRes;
        } else if (dshHasUpdate) {
          dshLevel = 'info';
          dshNotice = {
            level: 'info',
            kind: 'update-available',
            title: '发现 DSH 官方新版本',
            message: `官方已发布新版本 v${latestDshVer}，当前运行版本为 v${currentDshVer}。`,
            params: { latest: latestDshVer, current: currentDshVer }
          };
        }
      } catch (err) {
        console.warn('[version-service] DSH 版本研判失败(已降级为无更新提示):', err.message);
      }
    }

    let overallLevel = 'success';
    if (projectLevel === 'danger' || dshLevel === 'danger') {
      overallLevel = 'danger';
    } else if (projectLevel === 'warning' || dshLevel === 'warning') {
      overallLevel = 'warning';
    } else if (projectLevel === 'info' || dshLevel === 'info') {
      overallLevel = 'info';
    }

    const currentHist = currentProjectVer && meta.history ? meta.history[currentProjectVer] : null;
    const currentVerLabel = currentProjectVer ? 'v' + currentProjectVer : '未知';
    const updateTitle = hasProjectUpdate
      ? `新版本 (v${latestProjectVer}) 更新内容`
      : `当前版本 (${currentVerLabel}) 更新内容`;
    const activeReleaseDate = (hasProjectUpdate ? meta.latest?.releaseDate : (currentHist?.releaseDate || meta.latest?.releaseDate)) || '';
    const activeReleaseUrl = (hasProjectUpdate ? meta.latest?.releaseUrl : (currentHist?.releaseUrl || meta.latest?.releaseUrl))
      || meta.repo?.projectReleases
      || 'https://github.com/misaka-link/deepseek-harness-docker/releases';
    const activeChangelog = (hasProjectUpdate ? meta.latest?.changelog : (currentHist?.changelog || meta.latest?.changelog)) || '';
    const activeChangelogList = (hasProjectUpdate ? meta.latest?.changelogList : (currentHist?.changelogList || meta.latest?.changelogList))
      || (activeChangelog ? [activeChangelog] : []);
    const activeChangelogI18n = (hasProjectUpdate ? meta.latest?.changelogI18n : (currentHist?.changelogI18n || meta.latest?.changelogI18n)) || null;

    return {
      ok: true,
      project: {
        current: currentProjectVer,
        latest: latestProjectVer,
        hasUpdate: hasProjectUpdate,
        versionMismatch,
        envConflict: Boolean(versionDesc.envConflict),
        envVersion: versionDesc.envVersion ?? null,
        imageVersion: versionDesc.imageVersion ?? null,
        versionSources: versionDesc.sources,
        level: projectLevel,
        updateTitle,
        releaseDate: activeReleaseDate,
        releaseUrl: activeReleaseUrl,
        changelog: activeChangelog,
        changelogList: activeChangelogList,
        changelogI18n: activeChangelogI18n,
        projectUrl: meta.repo?.projectUrl || 'https://github.com/misaka-link/deepseek-harness-docker',
        projectReleases: meta.repo?.projectReleases || 'https://github.com/misaka-link/deepseek-harness-docker/releases'
      },
      dsh: {
        current: currentDshVer,
        latest: latestDshVer,
        hasUpdate: dshHasUpdate,
        isAdapted: isDshAdapted,
        level: dshLevel,
        notice: dshNotice,
        changelogList: Array.isArray(meta.latest?.dshChangelogList) ? meta.latest.dshChangelogList : [],
        upstreamRepo: meta.repo?.upstreamRepo || 'https://github.com/deepseek-ai/deepseek-harness',
        upstreamReleases: meta.repo?.upstreamReleases || 'https://github.com/deepseek-ai/deepseek-harness/releases',
        upstreamNpm: meta.repo?.upstreamNpm || 'https://www.npmjs.com/package/@deepseek-ai/dsh'
      },
      compatibility: effectiveCompat,
      compatibilityV1: effectiveCompat,
      overallLevel,
      timestamp: Date.now()
    };
  }
}

const versionService = new VersionService();
versionService.VersionService = VersionService;
versionService.ENGINE_FLOOR = ENGINE_FLOOR;
versionService.parseSemver = parseSemver;
versionService.isSemver = isSemver;
versionService.compareSemver = compareSemver;
versionService.matchSemverPattern = matchSemverPattern;
versionService.satisfiesRange = satisfiesRange;
versionService.describeProjectVersion = describeProjectVersion;

module.exports = versionService;
