/**
 * Official DSH-aligned Left Sidebar (specific-sidebar-fill column, 0.5px trailing hairline).
 * Top strip: brand lockup + 28px sidebar toggle; full-width outlined primary action;
 * quiet 34px nav rows; external shortcuts; compact footer (version hub · prefs · sign out).
 */

import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { suiteVerText } from '../lib/format.js';
import { brandWordmark } from './brand.js';
import { createLangPicker, createThemePicker } from './lang-theme-picker.js';

const NAV_ITEMS = [
  { id: 'dsh', icon: 'gauge', labelKey: 'navDsh' },
  { id: 'plugins', icon: 'puzzle', labelKey: 'navPlugins' },
  { id: 'desktop', icon: 'monitor', labelKey: 'navDesktop', desktopOnly: true },
  { id: 'snapshots', icon: 'archive', labelKey: 'navSnapshots' },
  { id: 'settings', icon: 'settings', labelKey: 'navSettings' }
];

function navLink({ href, label, iconName, external = false, desktopOnly = false }) {
  return h(
    'a',
    {
      href,
      target: external ? '_blank' : undefined,
      rel: external ? 'noopener noreferrer' : undefined,
      className: 'sidebar-item',
      title: label,
      dataset: desktopOnly ? { desktopOnly: '1' } : undefined
    },
    h('span', { className: 'sidebar-item-icon' }, icon(iconName, 16)),
    h('span', { className: 'sidebar-item-text' }, label),
    external ? h('span', { className: 'sidebar-item-trail' }, icon('external', 12)) : null
  );
}

export function renderSidebar({
  activeTab,
  isMini,
  collapsed,
  status,
  versionCheck,
  vncPath,
  onSelectTab,
  onToggleCollapse,
  onCloseDrawer,
  onOpenVersionHub,
  onPrefsChanged
}) {
  const proj = versionCheck?.project || {};
  const dshMeta = versionCheck?.dsh || {};
  const curSuite = proj.current || status?.project?.version || '';
  const curDsh = dshMeta.current || status?.dsh?.version || '';

  const suiteText = suiteVerText(curSuite, t);
  const dshText = curDsh && curDsh !== 'unknown' ? curDsh : t('common', 'unknown');

  const level = versionCheck?.overallLevel === 'danger' || proj.level === 'danger' || dshMeta.level === 'danger'
    ? 'danger'
    : dshMeta.level === 'warning'
      ? 'warning'
      : (proj.hasUpdate || dshMeta.hasUpdate) ? 'update' : '';

  const projectUrl = proj.projectUrl || 'https://github.com/misaka-link/deepseek-harness-docker';
  const upstreamRepo = dshMeta.upstreamRepo || 'https://github.com/deepseek-ai/deepseek-harness';
  const effectiveVnc = status?.paths?.vnc || vncPath || '/vnc/';

  const navButtons = NAV_ITEMS
    .filter((item) => !(isMini && item.desktopOnly))
    .map((item) => {
      const label = t('shell', item.labelKey);
      const active = activeTab === item.id;
      return h(
        'button',
        {
          type: 'button',
          className: `sidebar-item${active ? ' is-active' : ''}`,
          'aria-current': active ? 'page' : undefined,
          title: label,
          dataset: item.desktopOnly ? { desktopOnly: '1' } : undefined,
          onClick: () => {
            onSelectTab(item.id);
            onCloseDrawer();
          }
        },
        h('span', { className: 'sidebar-item-icon' }, icon(item.icon, 16)),
        h('span', { className: 'sidebar-item-text' }, label)
      );
    });

  const toggleLabel = collapsed ? t('shell', 'expandSidebar') : t('shell', 'collapseSidebar');

  return h(
    'aside',
    { className: 'app-sidebar', 'aria-label': t('shell', 'sidebarAria') },
    // Top strip: brand lockup + sidebar toggle
    h(
      'div',
      { className: 'sidebar-top' },
      h('div', { className: 'sidebar-brand', title: 'DeepSeek Harness' }, brandWordmark({ size: 22 })),
      h('button', {
        type: 'button',
        className: 'icon-btn sidebar-toggle',
        title: toggleLabel,
        'aria-label': toggleLabel,
        onClick: onToggleCollapse
      }, icon('panelLeft', 16)),
      h('button', {
        type: 'button',
        className: 'icon-btn sidebar-drawer-close',
        title: t('common', 'close'),
        'aria-label': t('common', 'close'),
        onClick: onCloseDrawer
      }, icon('x', 16))
    ),

    // Primary outlined action (DSH "New Session" geometry)
    h(
      'div',
      { className: 'sidebar-primary' },
      h('a', { href: '/', className: 'sidebar-primary-btn', title: t('shell', 'openWorkspace') },
        icon('workspace', 16),
        h('span', null, t('shell', 'openWorkspace'))
      )
    ),

    // Navigation + shortcuts
    h(
      'nav',
      { className: 'sidebar-scroll' },
      h('div', { className: 'sidebar-label' }, t('shell', 'sectionManage')),
      h('div', { className: 'sidebar-group' }, navButtons),
      h('div', { className: 'sidebar-label' }, t('shell', 'sectionShortcuts')),
      h(
        'div',
        { className: 'sidebar-group' },
        !isMini ? navLink({ href: effectiveVnc, label: t('shell', 'openDesktopVnc'), iconName: 'monitor', external: true, desktopOnly: true }) : null,
        navLink({ href: projectUrl, label: t('shell', 'repoDocker'), iconName: 'github', external: true }),
        navLink({ href: upstreamRepo, label: t('shell', 'repoDsh'), iconName: 'link', external: true })
      )
    ),

    // Compact footer (DSH bottom "Settings" area)
    h(
      'div',
      { className: 'sidebar-footer' },
      h(
        'button',
        {
          type: 'button',
          className: 'sidebar-item sidebar-version',
          title: t('shell', 'openVersionHub'),
          onClick: () => {
            onCloseDrawer();
            onOpenVersionHub();
          }
        },
        h('span', { className: 'sidebar-item-icon' }, icon('layers', 16)),
        h('span', { className: 'sidebar-item-text' },
          h('span', null, suiteText),
          h('span', { className: 'sidebar-version-sep', 'aria-hidden': 'true' }, '·'),
          h('span', { className: 'sidebar-version-dsh' }, `DSH ${dshText}`)
        ),
        level ? h('span', { className: 'update-dot', dataset: { level }, 'aria-hidden': 'true' }) : null
      ),
      h(
        'div',
        { className: 'sidebar-prefs' },
        createLangPicker({ dropUp: true, onChanged: onPrefsChanged }),
        createThemePicker({ dropUp: true, alignRight: true, onChanged: onPrefsChanged })
      ),
      h(
        'a',
        { href: '/logout', className: 'sidebar-item sidebar-logout', title: t('shell', 'logout') },
        h('span', { className: 'sidebar-item-icon' }, icon('logout', 16)),
        h('span', { className: 'sidebar-item-text' }, t('shell', 'logout'))
      )
    )
  );
}
