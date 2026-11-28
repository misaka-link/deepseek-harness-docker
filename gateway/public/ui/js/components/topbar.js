/**
 * Minimal DSH header strip (48px, trailing 0.5px hairline):
 * [sidebar opener] panel title · DSH StateDot ........ version chip · VNC shortcut
 */

import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { suiteVerText } from '../lib/format.js';
import { createStateDot } from './pill.js';

const TAB_TITLE_KEYS = {
  dsh: 'navDsh',
  plugins: 'navPlugins',
  desktop: 'navDesktop',
  snapshots: 'navSnapshots',
  settings: 'navSettings'
};

export function dshRuntimeState(status) {
  if (!status) return { state: 'ongoing', text: t('common', 'loading') };
  const d = status.dsh || {};
  if (d.running && d.ready) return { state: 'done', text: t('dsh', 'statusReady') };
  if (d.running) return { state: 'ongoing', text: t('dsh', 'statusStarting') };
  if (d.manualStopped) return { state: 'idle', text: t('dsh', 'statusManualStopped') };
  if (d.lastExitInfo) return { state: 'error', text: t('dsh', 'statusCrashed') };
  return { state: 'idle', text: t('dsh', 'statusStopped') };
}

export function renderTopbar({ activeTab, status, versionCheck, isMini, vncPath, onOpenDrawer, onToggleCollapse, onOpenVersionHub }) {
  const titleKey = TAB_TITLE_KEYS[activeTab] || 'navDsh';
  const rt = dshRuntimeState(status);

  const proj = versionCheck?.project || {};
  const statusProj = status?.project || {};
  const hasMismatch = Boolean(proj.versionMismatch || statusProj.versionMismatch);
  const hasAnyUpdate = Boolean(proj.hasUpdate || versionCheck?.dsh?.hasUpdate);
  const hasDanger = versionCheck?.overallLevel === 'danger';
  const hasWarning = Boolean(
    !hasDanger && (
      hasMismatch ||
      versionCheck?.overallLevel === 'warning' ||
      proj.level === 'warning' ||
      versionCheck?.dsh?.level === 'warning'
    )
  );
  const suiteText = suiteVerText(proj.current || statusProj.version || '', t);
  const effectiveVnc = status?.paths?.vnc || vncPath || '/vnc/';

  const chipTitle = hasDanger ? t('version', 'badgeIncompatible')
    : hasMismatch ? t('version', 'badgeEnvMismatch')
      : hasAnyUpdate ? t('version', 'badgeUpdateAvailable')
        : hasWarning ? t('version', 'badgeUnadapted')
          : t('shell', 'openVersionHub');

  const dotLevel = hasDanger ? 'danger' : hasWarning ? 'warning' : hasAnyUpdate ? 'update' : '';

  return h(
    'header',
    { className: 'app-topbar' },
    h(
      'div',
      { className: 'topbar-left' },
      h('button', {
        type: 'button',
        className: 'icon-btn topbar-drawer-btn',
        'aria-label': t('shell', 'openMenu'),
        title: t('shell', 'openMenu'),
        onClick: onOpenDrawer
      }, icon('panelLeft', 16)),
      h('button', {
        type: 'button',
        className: 'icon-btn topbar-expand-btn',
        'aria-label': t('shell', 'expandSidebar'),
        title: t('shell', 'expandSidebar'),
        onClick: onToggleCollapse
      }, icon('panelLeft', 16)),
      h('h1', { className: 'topbar-title' }, t('shell', titleKey)),
      h('span', { className: 'topbar-status' }, createStateDot({ state: rt.state, text: `DSH ${rt.text}` }))
    ),
    h(
      'div',
      { className: 'topbar-right' },
      h(
        'button',
        {
          type: 'button',
          className: 'topbar-chip',
          onClick: onOpenVersionHub,
          title: chipTitle,
          'aria-label': `${t('shell', 'versionHub')} · ${chipTitle}`
        },
        icon('layers', 14),
        h('span', null, suiteText),
        dotLevel
          ? h('span', { className: 'update-dot', dataset: { level: dotLevel }, 'aria-hidden': 'true' })
          : null
      ),
      !isMini
        ? h('a', {
          href: effectiveVnc,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'icon-btn',
          title: t('shell', 'openDesktopVnc'),
          'aria-label': t('shell', 'openDesktopVnc'),
          dataset: { desktopOnly: '1' }
        }, icon('monitor', 16))
        : null
    )
  );
}
