/**
 * Language & Theme pickers (shared by Admin Sidebar footer, Settings and Standalone Pages).
 * Menu surface follows dsh-client-ui-primitives Menu.module.css (4px pad, 34px rows,
 * translucent material + prominent elevation).
 */

import { h, icon } from '../lib/dom.js';
import { SUPPORTED_LOCALES, LOCALE_META, getLocale, getLocaleMode, setLocaleMode, t } from '../lib/i18n.js';
import { getThemeMode, getEffectiveTheme, setThemeMode } from '../lib/theme.js';

let activeCloser = null;
let globalBound = false;

function bindMenuDismiss() {
  if (globalBound) return;
  globalBound = true;
  document.addEventListener('click', (e) => {
    if (activeCloser && !activeCloser.wrap.contains(e.target)) {
      activeCloser.close();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeCloser) {
      activeCloser.close();
    }
  });
}

function createDropdownPicker({ triggerIcon, triggerLabel, ariaLabel, items, dropUp = false, alignRight = false, variant = 'quiet' }) {
  bindMenuDismiss();
  let isOpen = false;
  let menuEl = null;

  const close = () => {
    isOpen = false;
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    triggerBtn.setAttribute('aria-expanded', 'false');
    if (activeCloser && activeCloser.wrap === wrap) activeCloser = null;
  };

  const open = () => {
    if (activeCloser && activeCloser.wrap !== wrap) activeCloser.close();
    isOpen = true;
    menuEl = h(
      'div',
      {
        className: `menu${dropUp ? ' is-drop-up' : ''}${alignRight ? ' is-align-right' : ''}`,
        role: 'menu'
      },
      items.map((item) => {
        if (item.sep) return h('div', { className: 'menu-sep', role: 'separator' });
        return h(
          'button',
          {
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': item.selected ? 'true' : 'false',
            className: `menu-item${item.selected ? ' is-selected' : ''}`,
            onClick: async () => {
              close();
              await item.onSelect();
            }
          },
          item.icon ? h('span', { className: 'menu-item-icon' }, icon(item.icon, 16)) : null,
          h('span', { className: 'menu-item-label' }, item.label),
          h('span', { className: 'menu-item-check' }, item.selected ? icon('check', 14) : null)
        );
      })
    );
    wrap.appendChild(menuEl);
    triggerBtn.setAttribute('aria-expanded', 'true');
    activeCloser = { wrap, close };
  };

  const triggerBtn = h(
    'button',
    {
      type: 'button',
      className: `picker-trigger is-${variant}`,
      'aria-label': ariaLabel,
      title: ariaLabel,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        if (isOpen) close();
        else open();
      }
    },
    icon(triggerIcon, 14),
    h('span', { className: 'picker-trigger-label' }, triggerLabel),
    h('span', { className: 'picker-trigger-chevron' }, icon('chevronDown', 12))
  );

  const wrap = h('div', { className: 'picker-wrap' }, triggerBtn);
  return wrap;
}

export function getLocaleLabel() {
  const mode = getLocaleMode();
  const current = getLocale();
  return mode === 'dsh'
    ? (LOCALE_META[current]?.short || current.toUpperCase())
    : (LOCALE_META[mode]?.short || mode.toUpperCase());
}

export function getThemeLabel() {
  const mode = getThemeMode();
  const labelMap = {
    dsh: t('shell', 'themeFollowDshShort'),
    light: t('shell', 'themeLight'),
    dark: t('shell', 'themeDark'),
    system: t('shell', 'themeSystem')
  };
  return labelMap[mode] || labelMap.dsh;
}

export function createLangPicker({ dropUp = false, alignRight = false, onChanged = null, variant = 'quiet' } = {}) {
  const mode = getLocaleMode();

  const items = [
    {
      label: t('shell', 'followDsh'),
      selected: mode === 'dsh',
      onSelect: async () => {
        await setLocaleMode('dsh');
        if (onChanged) onChanged();
      }
    },
    { sep: true },
    ...SUPPORTED_LOCALES.map((id) => ({
      label: LOCALE_META[id].label,
      selected: mode === id,
      onSelect: async () => {
        await setLocaleMode(id);
        if (onChanged) onChanged();
      }
    }))
  ];

  return createDropdownPicker({
    triggerIcon: 'globe',
    triggerLabel: getLocaleLabel(),
    ariaLabel: t('shell', 'language'),
    items,
    dropUp,
    alignRight,
    variant
  });
}

export function createThemePicker({ dropUp = false, alignRight = false, onChanged = null, variant = 'quiet' } = {}) {
  const mode = getThemeMode();
  const eff = getEffectiveTheme();

  const pick = (m) => () => {
    setThemeMode(m);
    if (onChanged) onChanged();
  };

  const items = [
    { label: t('shell', 'followDsh'), icon: 'layers', selected: mode === 'dsh', onSelect: pick('dsh') },
    { sep: true },
    { label: t('shell', 'themeLight'), icon: 'sun', selected: mode === 'light', onSelect: pick('light') },
    { label: t('shell', 'themeDark'), icon: 'moon', selected: mode === 'dark', onSelect: pick('dark') },
    { label: t('shell', 'themeSystem'), icon: 'system', selected: mode === 'system', onSelect: pick('system') }
  ];

  return createDropdownPicker({
    triggerIcon: eff.isDark ? 'moon' : 'sun',
    triggerLabel: getThemeLabel(),
    ariaLabel: t('shell', 'theme'),
    items,
    dropUp,
    alignRight,
    variant
  });
}

/**
 * Unobtrusive top-right preference capsule for standalone pages
 * (/login, /setup, /desktop-starting, /account/callback, /locked).
 */
export function createQuickPrefsBar({ onChanged = null } = {}) {
  return h(
    'div',
    { className: 'standalone-prefs' },
    createLangPicker({ alignRight: true, onChanged, variant: 'capsule' }),
    h('span', { className: 'standalone-prefs-sep', 'aria-hidden': 'true' }),
    createThemePicker({ alignRight: true, onChanged, variant: 'capsule' })
  );
}
