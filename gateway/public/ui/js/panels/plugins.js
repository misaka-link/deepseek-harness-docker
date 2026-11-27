/**
 * Panel 2: Extensions & Plugins Management + Tool Cache (npx / pnpm dlx) Self-Heal.
 * DSH plugin-manager look: SegmentedControl category filter + SearchField,
 * hairline list rows inside one quiet surface, Switch toggles, StateDot status.
 */

import { h, clear, richText } from '../lib/dom.js';
import { t, getLocaleTag } from '../lib/i18n.js';
import { apiJson } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { createNotice, createStateDot, createTag } from '../components/pill.js';
import { askConfirm } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import {
  button, actions as actionGroup, pageHeader, section, segmented, searchField, switchInput,
  statStrip, metaLine, kvList, emptyState
} from '../components/ui.js';

const BROWSER_PLUGIN = '@dsh-custom/dsh-browser-desktop';

const CATEGORIES = [
  { id: 'all', key: 'catAll' },
  { id: 'core', key: 'catCore' },
  { id: 'builtin', key: 'catBuiltin' },
  { id: 'community', key: 'catCommunity' },
  { id: 'uninstalled', key: 'catUninstalled' }
];

function matchCategory(plugin, cat) {
  if (cat === 'all') return true;
  if (cat === 'uninstalled') return Boolean(plugin.isUninstalled);
  if (plugin.isUninstalled) return false;
  if (cat === 'core') return Boolean(plugin.isCore);
  if (cat === 'builtin') return Boolean(plugin.isCustom && !plugin.isCore);
  if (cat === 'community') return !plugin.isCore && !plugin.isCustom;
  return true;
}

function fmtVersion(v) {
  if (!v) return '--';
  const s = String(v);
  return !s.startsWith('v') && /^\d/.test(s) ? `v${s}` : s;
}

export function renderPluginsPanel(container, ctx) {
  const { plugins, pluginSearch, pluginCategory, isMini, status, toolCache } = ctx.state;
  const list = Array.isArray(plugins) ? plugins : [];
  const isolatedSet = new Set((status?.autoIsolatedEvents || []).map((ev) => ev.plugin));

  const restartBtn = button({
    variant: 'primary',
    size: 'sm',
    iconName: 'refresh',
    label: t('plugins', 'restartApplyBtn'),
    onClick: async () => {
      restartBtn.disabled = true;
      const lbl = restartBtn.querySelector('.btn-label');
      if (lbl) lbl.textContent = t('plugins', 'restartingBtn');
      try {
        const r = await apiJson(`${ctx.adminPath}/api/dsh/restart`, { method: 'POST', timeoutMs: 60000 });
        if (r.ok) showToast(t('plugins', 'toastRestartOk'), 'success');
        else showToast(r.message, { type: 'error', errorCode: r.errorCode });
        await Promise.all([ctx.actions.refreshStatus(), ctx.actions.refreshPlugins()]);
      } finally {
        restartBtn.disabled = false;
        if (lbl) lbl.textContent = t('plugins', 'restartApplyBtn');
      }
    }
  });

  const filterBar = segmented({
    ariaLabel: t('plugins', 'colType'),
    value: pluginCategory || 'all',
    items: CATEGORIES.map((cat) => {
      const count = list.filter((p) => matchCategory(p, cat.id)).length;
      return {
        id: cat.id,
        label: h('span', { className: 'segmented-label' }, t('plugins', cat.key), h('span', { className: 'segmented-count' }, String(count)))
      };
    }),
    onChange: (id) => {
      ctx.state.pluginCategory = id;
      updateRows();
    }
  });

  const search = searchField({
    value: pluginSearch || '',
    placeholder: t('plugins', 'searchPlaceholder'),
    clearLabel: t('common', 'close'),
    onInput: (val) => {
      ctx.state.pluginSearch = val;
      updateRows();
    }
  });

  const infoNotice = createNotice({
    level: 'info',
    body: isMini
      ? richText(t('plugins', 'noticeMini'))
      : richText(t('plugins', 'noticeFull'), null, {
        desktop: { onClick: () => ctx.actions.switchTab('desktop') }
      })
  });

  const listEl = h('div', { className: 'list surface plugin-list' });

  function buildRow(p) {
    const isUnsupported = isMini && p.name === BROWSER_PLUGIN;
    const isAutoIsolated = isolatedSet.has(p.name);

    const typeText = p.isCore ? t('plugins', 'typeCore') : p.isCustom ? t('plugins', 'typeBuiltin') : t('plugins', 'typeCommunity');

    let statusNode;
    if (isUnsupported) {
      statusNode = createStateDot({ state: 'error', text: t('plugins', 'statusUnsupported') });
    } else if (p.isUninstalled) {
      statusNode = createStateDot({ state: 'idle', text: t('plugins', 'statusUninstalled') });
    } else if (p.enabled) {
      statusNode = createStateDot({ state: 'done', text: t('plugins', 'statusEnabled') });
    } else if (isAutoIsolated) {
      statusNode = createStateDot({ state: 'warning', text: t('plugins', 'statusIsolated'), title: t('plugins', 'isolatedTooltip') });
    } else {
      statusNode = createStateDot({ state: 'idle', text: t('plugins', 'statusDisabled') });
    }

    let actionNode;
    if (isUnsupported) {
      actionNode = button({ size: 'sm', label: t('plugins', 'statusUnsupported'), disabled: true, title: t('plugins', 'unsupportedTooltip') });
    } else if (p.isCore) {
      actionNode = h('span', { className: 'list-hint' }, t('plugins', 'protectedCore'));
    } else if (p.isUninstalled) {
      actionNode = button({ size: 'sm', label: t('plugins', 'reinstallBtn'), onClick: () => handleInstall(p.name) });
    } else {
      const switchCb = switchInput({
        checked: Boolean(p.enabled),
        ariaLabel: `${p.enabled ? t('plugins', 'disableBtn') : t('plugins', 'enableBtn')} ${p.name}`,
        onChange: async (e) => {
          const wantEnable = e.currentTarget.checked;
          // Revert visually until the user confirms
          e.currentTarget.checked = Boolean(p.enabled);
          await handleToggle(p.name, wantEnable);
        }
      });
      actionNode = h(
        'div',
        { className: 'list-actions-inline' },
        !p.isCustom
          ? button({
            size: 'sm',
            variant: 'ghost',
            iconName: 'trash',
            iconOnly: true,
            className: 'is-danger-icon',
            title: `${t('plugins', 'uninstallBtn')} · ${t('plugins', 'uninstallTooltip')}`,
            onClick: () => handleUninstall(p.name)
          })
          : null,
        switchCb
      );
    }

    return h(
      'div',
      { className: `list-row${p.isUninstalled ? ' is-muted' : ''}` },
      h('div', { className: 'list-main' },
        h('div', { className: 'list-title' },
          h('span', { className: 'list-name' }, p.name),
          h('span', { className: 'list-version mono' }, fmtVersion(p.version)),
          createTag({ tone: p.isCore ? 'neutral' : 'outline', text: typeText })
        ),
        h('div', { className: 'list-desc' },
          p.description || t('plugins', 'noDesc'),
          isUnsupported ? h('span', { className: 'text-danger' }, ` ${t('plugins', 'unsupportedDescSuffix')}`) : null
        )
      ),
      h('div', { className: 'list-status' }, statusNode),
      h('div', { className: 'list-actions' }, actionNode)
    );
  }

  function updateRows() {
    clear(listEl);
    const q = (ctx.state.pluginSearch || '').trim().toLowerCase();
    const curList = list.filter((p) => {
      if (!matchCategory(p, ctx.state.pluginCategory || 'all')) return false;
      if (!q) return true;
      return String(p.name || '').toLowerCase().includes(q) || String(p.description || '').toLowerCase().includes(q);
    });
    if (!plugins) {
      listEl.appendChild(emptyState(t('common', 'loading')));
      return;
    }
    if (curList.length === 0) {
      listEl.appendChild(emptyState(t('plugins', 'emptyList')));
      return;
    }
    for (const p of curList) listEl.appendChild(buildRow(p));
  }

  async function handleToggle(name, enabled) {
    const isBrowser = name === BROWSER_PLUGIN;
    const ok = await askConfirm({
      title: enabled ? t('plugins', 'confirmEnableTitle') : t('plugins', 'confirmDisableTitle'),
      iconName: enabled ? 'play' : 'alertTriangle',
      iconTone: enabled ? 'success' : 'warn',
      confirmText: enabled ? t('plugins', 'enableBtn') : t('plugins', 'disableBtn'),
      confirmKind: enabled ? 'primary' : 'danger',
      body: h(
        'div',
        { className: 'modal-stack' },
        kvList([
          [t('plugins', 'targetPlugin'), h('code', null, name)],
          [t('plugins', 'colActions'), enabled ? t('plugins', 'enableBtn') : t('plugins', 'disableBtn')]
        ]),
        createNotice({
          level: enabled ? 'info' : 'warn',
          title: t('plugins', 'confirmToggleRestartTitle'),
          body: richText(
            isBrowser && !enabled ? t('plugins', 'confirmDisableBrowserBody') : t('plugins', 'confirmToggleBody')
          )
        })
      )
    });
    if (!ok) return;

    const r = await apiJson(`${ctx.adminPath}/api/plugins/toggle`, {
      method: 'POST',
      json: { name, enabled, restart: true },
      timeoutMs: 60000
    });
    if (r.ok) {
      showToast(
        r.data?.restarted
          ? t('plugins', enabled ? 'toastEnabledRestarted' : 'toastDisabledRestarted', { name })
          : t('plugins', 'toastToggledManualRestart', { name }),
        r.data?.restarted ? 'success' : 'warn'
      );
      await Promise.all([ctx.actions.refreshPlugins(), ctx.actions.refreshStatus()]);
    } else {
      showToast(r.message, { type: 'error', errorCode: r.errorCode });
    }
  }

  async function handleUninstall(name) {
    const ok = await askConfirm({
      title: t('plugins', 'confirmUninstallTitle'),
      iconName: 'trash',
      iconTone: 'danger',
      destructive: true,
      confirmText: t('plugins', 'uninstallBtn'),
      confirmKind: 'danger',
      body: h(
        'div',
        { className: 'modal-stack' },
        kvList([[t('plugins', 'targetPlugin'), h('code', null, name)]]),
        createNotice({
          level: 'danger',
          title: t('plugins', 'confirmUninstallWarnTitle'),
          body: richText(t('plugins', 'confirmUninstallWarnBody'))
        })
      )
    });
    if (!ok) return;

    const r = await apiJson(`${ctx.adminPath}/api/plugins/uninstall`, {
      method: 'POST',
      json: { name },
      timeoutMs: 45000
    });
    if (r.ok) {
      showToast(t('plugins', 'toastUninstalled', { name }), 'success');
      await ctx.actions.refreshPlugins();
    } else {
      showToast(r.message, { type: 'error', errorCode: r.errorCode });
    }
  }

  async function handleInstall(name) {
    const ok = await askConfirm({
      title: t('plugins', 'confirmReinstallTitle'),
      iconName: 'package',
      iconTone: 'info',
      confirmText: t('plugins', 'reinstallBtn'),
      confirmKind: 'primary',
      body: createNotice({
        level: 'info',
        title: t('plugins', 'confirmReinstallNoticeTitle'),
        body: richText(t('plugins', 'confirmReinstallNoticeBody'), { name })
      })
    });
    if (!ok) return;

    const r = await apiJson(`${ctx.adminPath}/api/plugins/install`, {
      method: 'POST',
      json: { name },
      timeoutMs: 60000
    });
    if (r.ok) {
      showToast(t('plugins', 'toastReinstalled', { name }), 'success');
      await ctx.actions.refreshPlugins();
    } else {
      showToast(r.message, { type: 'error', errorCode: r.errorCode });
    }
  }

  updateRows();

  // Tool cache (npx / pnpm dlx) health
  const tc = toolCache;
  const npxInfo = tc?.npxCache || null;
  const dlxInfo = tc?.pnpmDlx || null;
  const brokenTotal = (Number(npxInfo?.broken) || 0) + (Number(dlxInfo?.broken) || 0);

  const healBtn = button({
    size: 'sm',
    iconName: 'wrench',
    label: t('plugins', 'healCacheBtn'),
    onClick: async () => {
      healBtn.disabled = true;
      try {
        const r = await apiJson(`${ctx.adminPath}/api/maintenance/npx-cache/heal`, { method: 'POST', timeoutMs: 45000 });
        if (r.ok) {
          const rep = Number(r.data?.result?.repaired) || 0;
          const rem = Number(r.data?.result?.removed) || 0;
          showToast(t('plugins', 'toastCacheHealed', { repaired: rep, removed: rem }), 'success');
          await ctx.actions.refreshToolCache();
        } else {
          showToast(r.message, { type: 'error', errorCode: r.errorCode });
        }
      } finally {
        healBtn.disabled = false;
      }
    }
  });

  const cacheCell = (title, info) => ({
    label: title,
    aside: createStateDot({
      state: (Number(info?.broken) || 0) > 0 ? 'warning' : 'done',
      text: `${info?.healthy ?? 0} OK · ${info?.broken ?? 0} !`
    }),
    value: h('code', { className: 'stat-code' }, info?.cacheDir || '--')
  });

  const cacheSection = section({
    title: h('span', { className: 'row-title-state' },
      t('plugins', 'toolCacheTitle'),
      createStateDot({
        state: !tc ? 'ongoing' : brokenTotal > 0 ? 'warning' : 'done',
        text: !tc ? t('common', 'loading') : brokenTotal > 0 ? t('plugins', 'cacheBrokenPill', { count: brokenTotal }) : t('plugins', 'cacheHealthyPill')
      })
    ),
    desc: t('plugins', 'toolCacheDesc'),
    aside: actionGroup(
      button({ size: 'sm', variant: 'ghost', iconName: 'refresh', label: t('plugins', 'refreshBtn'), onClick: () => ctx.actions.refreshToolCache() }),
      healBtn
    ),
    children: [
      tc
        ? statStrip([
          cacheCell('npx', npxInfo),
          cacheCell('pnpm dlx', dlxInfo),
          {
            label: t('plugins', 'cacheAutoHealStats'),
            aside: createStateDot({ state: tc.running ? 'done' : 'idle', text: tc.running ? t('plugins', 'healerActive') : t('plugins', 'healerIdle') }),
            value: h('span', { className: 'stat-small' }, t('plugins', 'cacheRepairedTotal', { repaired: tc.totalRepaired || 0, removed: tc.totalRemoved || 0 })),
            meta: tc.lastRunAt ? metaLine(formatDateTime(tc.lastRunAt, getLocaleTag())) : null
          }
        ])
        : emptyState(t('common', 'loading'))
    ]
  });

  clear(container);
  container.append(
    pageHeader({
      title: t('plugins', 'cardTitle'),
      desc: t('plugins', 'cardDesc'),
      aside: actionGroup(
        button({ size: 'sm', iconName: 'refresh', label: t('plugins', 'refreshBtn'), onClick: () => ctx.actions.refreshPlugins() }),
        restartBtn
      )
    }),
    h('div', { className: 'page-banner' }, infoNotice),
    h('div', { className: 'toolbar' }, filterBar, search),
    listEl,
    cacheSection
  );
}
