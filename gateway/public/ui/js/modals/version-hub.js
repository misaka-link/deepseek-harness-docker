/**
 * Version & Update Control Center Modal.
 * Consumes live/offline metadata exclusively from backend APIs (zero hardcoded version arrays).
 */

import { h, icon, clear } from '../lib/dom.js';
import { t, getLocale } from '../lib/i18n.js';
import { suiteVerText } from '../lib/format.js';
import { openModal } from '../components/modal.js';
import { createStateDot, createTag, createNotice } from '../components/pill.js';

function resolveProjectChangelog(proj, lang) {
  const i18nMap = proj?.changelogI18n;
  if (i18nMap && Array.isArray(i18nMap[lang]) && i18nMap[lang].length > 0) {
    return { items: i18nMap[lang], isOriginalFallback: false };
  }
  if (Array.isArray(proj?.changelogList) && proj.changelogList.length > 0) {
    return { items: proj.changelogList, isOriginalFallback: lang !== 'zh' };
  }
  if (proj?.changelog) {
    return { items: [String(proj.changelog)], isOriginalFallback: lang !== 'zh' };
  }
  return { items: [t('version', 'defaultChangelogItem')], isOriginalFallback: false };
}

function levelToState(level, hasUpdate) {
  if (level === 'danger') return 'error';
  if (level === 'warning') return 'warning';
  if (hasUpdate) return 'info';
  return 'done';
}

function quietLink(href, label) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', className: 'link-quiet' }, label, icon('external', 12));
}

function versionCard({ title, iconName, state, stateText, curLabel, curVal, latLabel, latVal, highlightLatest, links }) {
  return h(
    'div',
    { className: 'hub-card' },
    h('div', { className: 'hub-card-head' },
      h('span', { className: 'hub-card-title' }, icon(iconName, 14), title),
      createStateDot({ state, text: stateText })
    ),
    h('div', { className: 'hub-card-versions' },
      h('div', { className: 'hub-ver' },
        h('span', { className: 'hub-ver-label' }, curLabel),
        h('span', { className: 'hub-ver-val' }, curVal)
      ),
      h('span', { className: 'hub-ver-arrow', 'aria-hidden': 'true' }, icon('chevronRight', 14)),
      h('div', { className: 'hub-ver' },
        h('span', { className: 'hub-ver-label' }, latLabel),
        h('span', { className: `hub-ver-val${highlightLatest ? ' is-new' : ''}` }, latVal)
      )
    ),
    h('div', { className: 'hub-card-links' }, links)
  );
}

function buildHubBody(data, currentDshVersion) {
  const lang = getLocale();
  const proj = data?.project || {};
  const dsh = data?.dsh || {};
  const compat = data?.compatibility || {};

  const curSuite = suiteVerText(proj.current, t);
  const latSuite = suiteVerText(proj.latest || proj.current, t);
  const curDsh = dsh.current || currentDshVersion || '';
  const latDsh = dsh.latest || '';

  const projStatusText = proj.level === 'danger' ? t('version', 'badgeIncompatible')
    : proj.hasUpdate ? t('version', 'badgeUpdateAvailable')
      : proj.level === 'warning' ? t('version', 'badgeAdvisory')
        : t('version', 'badgeUpToDate');

  const dshStatusText = dsh.level === 'danger' ? t('version', 'badgeIncompatible')
    : dsh.level === 'warning' ? t('version', 'badgeUnadapted')
      : dsh.hasUpdate ? t('version', 'badgeDshNewRelease')
        : t('version', 'badgeAdaptedStable');

  const isRemote = Boolean(
    data?.isRemoteMeta ||
    compat?.isRemoteMeta ||
    dsh?.isRemoteMeta ||
    data?.metaSource === 'remote'
  );

  const adaptedList = Array.isArray(compat.adaptedVersions) ? compat.adaptedVersions : [];
  const recDsh = compat.recommendedDsh || '';
  const supportedRange = compat.supportedDshRange || (compat.minDsh ? `>=${compat.minDsh}` : '');

  const cards = h(
    'div',
    { className: 'hub-cards' },
    versionCard({
      title: t('version', 'suiteCardTitle'),
      iconName: 'package',
      state: levelToState(proj.level, proj.hasUpdate),
      stateText: projStatusText,
      curLabel: t('version', 'localRunning'),
      curVal: curSuite,
      latLabel: t('version', 'remoteLatest'),
      latVal: latSuite,
      highlightLatest: Boolean(proj.hasUpdate),
      links: [
        quietLink(proj.releaseUrl || proj.projectReleases || 'https://github.com/misaka-link/deepseek-harness-docker/releases', t('version', 'releaseNotes')),
        quietLink(proj.projectUrl || 'https://github.com/misaka-link/deepseek-harness-docker', t('version', 'githubSource'))
      ]
    }),
    versionCard({
      title: t('version', 'dshCardTitle'),
      iconName: 'gauge',
      state: levelToState(dsh.level, dsh.hasUpdate),
      stateText: dshStatusText,
      curLabel: t('version', 'currentRunning'),
      curVal: curDsh && curDsh !== 'unknown' ? `v${curDsh}` : t('common', 'unknown'),
      latLabel: t('version', 'officialLatest'),
      latVal: latDsh ? `v${latDsh}` : t('common', 'unknown'),
      highlightLatest: Boolean(dsh.hasUpdate),
      links: [
        quietLink(dsh.upstreamReleases || 'https://github.com/deepseek-ai/deepseek-harness/releases', t('version', 'releaseNotes')),
        quietLink(dsh.upstreamRepo || 'https://github.com/deepseek-ai/deepseek-harness', t('version', 'officialRepo'))
      ]
    })
  );

  const compatBlock = h(
    'section',
    { className: 'hub-block' },
    h('div', { className: 'hub-block-head' },
      h('h3', { className: 'hub-block-title' }, t('version', 'compatMatrixTitle')),
      createTag({ tone: 'outline', text: isRemote ? t('version', 'sourceCloud') : t('version', 'sourceLocal') })
    ),
    h('dl', { className: 'kv-list is-compact' },
      h('div', { className: 'kv-row' },
        h('dt', { className: 'kv-key' }, t('version', 'recommendedCoreLabel')),
        h('dd', { className: 'kv-val' }, recDsh ? `v${recDsh}` : t('common', 'unknown'))
      ),
      supportedRange
        ? h('div', { className: 'kv-row' },
          h('dt', { className: 'kv-key' }, t('version', 'supportedRangeLabel')),
          h('dd', { className: 'kv-val' }, h('code', null, supportedRange))
        )
        : null
    ),
    h('div', { className: 'hub-block-label' }, t('version', 'adaptedListLabel')),
    h(
      'div',
      { className: 'tag-row' },
      adaptedList.length > 0
        ? adaptedList.map((ver) => {
          const isCur = ver === curDsh;
          const isRec = ver === recDsh;
          const label = isCur ? `${ver} ★` : isRec ? `${ver} · ${t('version', 'recommendedTag')}` : ver;
          return createTag({ tone: isCur ? 'solid' : 'outline', text: label });
        })
        : createTag({ tone: 'quiet', text: t('common', 'unknown') })
    )
  );

  // Suite changelog
  const { items: projItems, isOriginalFallback } = resolveProjectChangelog(proj, lang);
  const projTitle = proj.level === 'danger'
    ? t('version', 'suiteBreakingTitle')
    : proj.hasUpdate
      ? t('version', 'suiteNewVersionTitle', { version: latSuite })
      : t('version', 'suiteCurrentVersionTitle', { version: curSuite });

  const projList = h('ul', { className: 'changelog-list' }, projItems.map((line) => h('li', null, String(line))));
  const projBlock = proj.level === 'danger'
    ? createNotice({ level: 'danger', title: projTitle, body: projList })
    : h('section', { className: 'hub-block' },
      h('div', { className: 'hub-block-head' },
        h('h3', { className: 'hub-block-title' }, projTitle),
        isOriginalFallback ? createTag({ tone: 'outline', text: t('version', 'originalLangTag') }) : null
      ),
      projList
    );

  // DSH highlights
  const dshItems = Array.isArray(dsh.changelogList) ? dsh.changelogList : [];
  let dshLevel = '';
  let dshTitle = t('version', 'dshHighlightsTitle', { version: curDsh && curDsh !== 'unknown' ? `v${curDsh}` : t('common', 'unknown') });
  let dshIntro = '';

  if (dsh.notice) {
    dshLevel = dsh.notice.level === 'danger' ? 'danger' : dsh.notice.level === 'warning' ? 'warn' : 'info';
    if (dsh.notice.kind === 'engine-unsupported') {
      dshTitle = t('dsh', 'evalUnsupportedTitle');
      dshIntro = t('dsh', 'evalUnsupportedMsg', { version: curDsh, floor: dsh.notice.params?.floor || '' });
    } else if (dsh.notice.kind === 'breaking-major') {
      dshTitle = t('dsh', 'evalBreakingTitle');
      dshIntro = t('dsh', 'evalBreakingMsg', { version: curDsh });
    } else if (dsh.notice.kind === 'unadapted') {
      dshTitle = t('dsh', 'evalUnadaptedTitle');
      dshIntro = t('dsh', 'evalUnadaptedMsg', { version: curDsh });
    } else {
      dshTitle = dsh.notice.title || dshTitle;
      dshIntro = dsh.notice.message || '';
    }
  } else if (dsh.hasUpdate && latDsh) {
    dshTitle = t('version', 'dshNewVersionTitle', { version: `v${latDsh}` });
  }

  const dshBody = h(
    'div',
    null,
    dshIntro ? h('p', { className: 'hub-intro' }, dshIntro) : null,
    dshItems.length > 0
      ? h('ul', { className: 'changelog-list' }, dshItems.map((line) => h('li', null, String(line))))
      : null
  );
  const dshBlock = dshLevel === 'danger' || dshLevel === 'warn'
    ? createNotice({ level: dshLevel, title: dshTitle, body: dshBody })
    : h('section', { className: 'hub-block' },
      h('div', { className: 'hub-block-head' }, h('h3', { className: 'hub-block-title' }, dshTitle)),
      dshBody
    );

  return h(
    'div',
    { className: 'hub' },
    cards,
    h('div', { className: 'hub-columns' },
      h('div', { className: 'hub-col' }, compatBlock),
      h('div', { className: 'hub-col' }, projBlock, dshBlock)
    )
  );
}

export function openVersionHubModal({ versionCheck, currentDshVersion, onRefresh }) {
  const bodyHost = h('div', null, versionCheck
    ? buildHubBody(versionCheck, currentDshVersion)
    : h('div', { className: 'empty-state' }, t('common', 'loading')));

  const refreshLabel = h('span', { className: 'btn-label' }, t('version', 'recheckBtn'));
  const refreshBtn = h(
    'button',
    {
      type: 'button',
      className: 'btn',
      onClick: async () => {
        refreshBtn.disabled = true;
        refreshLabel.textContent = t('version', 'checking');
        try {
          const fresh = await onRefresh(true);
          if (fresh) {
            clear(bodyHost);
            bodyHost.appendChild(buildHubBody(fresh, fresh?.dsh?.current || currentDshVersion));
          }
        } finally {
          refreshBtn.disabled = false;
          refreshLabel.textContent = t('version', 'recheckBtn');
        }
      }
    },
    icon('refresh', 16),
    refreshLabel
  );

  const closeBtn = h('button', {
    type: 'button',
    className: 'btn btn-primary',
    onClick: () => modal.close()
  }, t('common', 'close'));

  const modal = openModal({
    title: t('version', 'hubTitle'),
    wide: true,
    content: bodyHost,
    footer: [refreshBtn, closeBtn],
    footerBetween: true
  });

  if (!versionCheck && typeof onRefresh === 'function') {
    onRefresh(false).then((fresh) => {
      if (fresh && document.body.contains(bodyHost)) {
        clear(bodyHost);
        bodyHost.appendChild(buildHubBody(fresh, fresh?.dsh?.current || currentDshVersion));
      }
    }).catch(() => {});
  }

  return modal;
}
