/**
 * DSH-aligned layout & control primitives for the Admin UI:
 * page heading, flat settings sections with hairline rows (SettingsForm / Setting-Cell),
 * Button, Switch, SegmentedControl, SearchField, native Select wrapper and stat strip.
 */

import { h, icon } from '../lib/dom.js';

const BTN_VARIANTS = new Set(['primary', 'outline', 'ghost', 'danger', 'danger-solid']);

/**
 * Button (Button.module.css geometry: md 36px / sm 28px).
 * @param {{ variant?: string, size?: 'md'|'sm'|'lg', iconName?: string, label?: any, title?: string,
 *           disabled?: boolean, onClick?: Function, block?: boolean, iconOnly?: boolean,
 *           href?: string, target?: string, type?: string, className?: string, ariaLabel?: string }} opts
 */
export function button({
  variant = 'outline',
  size = 'md',
  iconName = '',
  label = '',
  title = '',
  disabled = false,
  onClick = null,
  block = false,
  iconOnly = false,
  href = '',
  target = '',
  type = 'button',
  className = '',
  ariaLabel = ''
} = {}) {
  const v = BTN_VARIANTS.has(variant) ? variant : 'outline';
  const cls = [
    'btn',
    v === 'primary' ? 'btn-primary'
      : v === 'ghost' ? 'btn-ghost'
        : v === 'danger' ? 'btn-danger-ghost'
          : v === 'danger-solid' ? 'btn-danger'
            : '',
    size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '',
    block ? 'btn-block' : '',
    iconOnly ? 'btn-icon' : '',
    className
  ].filter(Boolean).join(' ');
  const iconSize = size === 'sm' ? 14 : 16;
  const children = [
    iconName ? icon(iconName, iconSize) : null,
    label !== '' && label !== null && !iconOnly ? h('span', { className: 'btn-label' }, label) : null
  ];
  if (href) {
    return h('a', {
      className: `${cls}${disabled ? ' is-disabled' : ''}`,
      href,
      target: target || undefined,
      rel: target === '_blank' ? 'noopener noreferrer' : undefined,
      title: title || undefined,
      'aria-label': ariaLabel || (iconOnly ? title : undefined) || undefined,
      'aria-disabled': disabled ? 'true' : undefined,
      tabindex: disabled ? '-1' : undefined,
      onClick: typeof onClick === 'function' ? onClick : undefined
    }, children);
  }
  return h('button', {
    type,
    className: cls,
    disabled,
    title: title || undefined,
    'aria-label': ariaLabel || (iconOnly ? title : undefined) || undefined,
    onClick: typeof onClick === 'function' ? onClick : undefined
  }, children);
}

/** Inline group of buttons / controls. */
export function actions(...items) {
  return h('div', { className: 'actions' }, items);
}

/**
 * Page heading inside the centred reading column.
 */
export function pageHeader({ title = '', desc = null, aside = null } = {}) {
  return h(
    'header',
    { className: 'page-head' },
    h('div', { className: 'page-head-text' },
      h('h1', { className: 'page-title' }, title),
      desc ? h('p', { className: 'page-desc' }, desc) : null
    ),
    aside ? h('div', { className: 'page-head-aside' }, aside) : null
  );
}

/**
 * Flat settings section: title + optional description + hairline-separated rows.
 */
export function section({ title = '', desc = null, aside = null, children = [], className = '', id = '' } = {}) {
  return h(
    'section',
    { className: `section${className ? ' ' + className : ''}`, id: id || undefined },
    (title || aside)
      ? h('header', { className: 'section-head' },
        h('div', { className: 'section-head-text' },
          title ? h('h2', { className: 'section-title' }, title) : null,
          desc ? h('p', { className: 'section-desc' }, desc) : null
        ),
        aside ? h('div', { className: 'section-aside' }, aside) : null
      )
      : null,
    h('div', { className: 'section-body' }, children)
  );
}

/**
 * Horizontal setting row: label + description on the left, control on the right.
 * Stacks cleanly below 640px.
 * @param {{ label?: any, desc?: any, control?: any, wide?: boolean, auto?: boolean, stack?: boolean,
 *           htmlFor?: string, extra?: any, className?: string, dataset?: object, hidden?: boolean }} opts
 */
export function settingRow({
  label = '',
  desc = null,
  control = null,
  wide = false,
  auto = false,
  stack = false,
  htmlFor = '',
  extra = null,
  className = '',
  dataset = undefined,
  hidden = false
} = {}) {
  const ctrlCls = ['setting-control', wide ? 'is-wide' : '', auto ? 'is-auto' : ''].filter(Boolean).join(' ');
  return h(
    'div',
    {
      className: `setting-row${stack ? ' is-stack' : ''}${className ? ' ' + className : ''}`,
      dataset,
      hidden
    },
    h('div', { className: 'setting-text' },
      label ? h(htmlFor ? 'label' : 'div', { className: 'setting-label', for: htmlFor || undefined }, label) : null,
      desc ? h('div', { className: 'setting-desc' }, desc) : null
    ),
    control ? h('div', { className: ctrlCls }, control) : null,
    extra ? h('div', { className: 'setting-extra' }, extra) : null
  );
}

/** Footer row for a settings form (save / reset). */
export function formFooter(...items) {
  return h('div', { className: 'form-footer' }, items);
}

/**
 * Text / number input with DSH field geometry.
 */
export function textInput(attrs = {}) {
  const { className = '', ...rest } = attrs;
  return h('input', { type: 'text', ...rest, className: `input${className ? ' ' + className : ''}` });
}

/**
 * Native <select> wrapped with a DSH chevron.
 */
export function selectInput(attrs = {}, options = []) {
  const { className = '', ...rest } = attrs;
  const sel = h('select', { ...rest, className: `input select${className ? ' ' + className : ''}` }, options);
  return sel;
}

/**
 * Switch (Switch.module.css: 36×20 capsule, 16px thumb). Native checkbox keeps `.checked` semantics.
 */
export function switchInput({ checked = false, disabled = false, onChange = null, ariaLabel = '', id = '' } = {}) {
  return h('input', {
    type: 'checkbox',
    role: 'switch',
    className: 'switch',
    id: id || undefined,
    checked: Boolean(checked),
    disabled,
    'aria-label': ariaLabel || undefined,
    onChange: typeof onChange === 'function' ? onChange : undefined
  });
}

/** Checkbox with label (DSH 16px rounded box). */
export function checkboxRow({ input, label = '', hint = null, disabled = false } = {}) {
  return h(
    'label',
    { className: `check-row${disabled ? ' is-disabled' : ''}` },
    input,
    h('span', { className: 'check-row-text' },
      h('span', { className: 'check-row-label' }, label),
      hint ? h('span', { className: 'check-row-hint' }, hint) : null
    )
  );
}

export function checkbox(attrs = {}) {
  return h('input', { type: 'checkbox', ...attrs, className: `checkbox${attrs.className ? ' ' + attrs.className : ''}` });
}

/**
 * SegmentedControl (SegmentedControl.module.css): equal-width tracks, one sliding indicator.
 * @param {{ items: {id:string,label:any}[], value: string, onChange: (id:string)=>void, ariaLabel?: string }} opts
 */
export function segmented({ items = [], value = '', onChange = null, ariaLabel = '' } = {}) {
  const idx = Math.max(0, items.findIndex((it) => it.id === value));
  const root = h('div', {
    className: 'segmented',
    role: 'tablist',
    'aria-label': ariaLabel || undefined,
    style: { '--seg-count': String(items.length || 1), '--seg-index': String(idx) }
  });
  root.appendChild(h('span', { className: 'segmented-indicator', 'aria-hidden': 'true' }));
  items.forEach((it, i) => {
    root.appendChild(h('button', {
      type: 'button',
      role: 'tab',
      className: 'segmented-tab',
      'aria-selected': it.id === value ? 'true' : 'false',
      onClick: () => {
        root.style.setProperty('--seg-index', String(i));
        for (const b of root.querySelectorAll('.segmented-tab')) b.setAttribute('aria-selected', 'false');
        root.children[i + 1].setAttribute('aria-selected', 'true');
        if (typeof onChange === 'function') onChange(it.id);
      }
    }, it.label));
  });
  return root;
}

/**
 * SearchField (SearchField.module.css): leading magnifier, underline-only field, clear button.
 */
export function searchField({ value = '', placeholder = '', onInput = null, ariaLabel = '', clearLabel = '' } = {}) {
  const input = h('input', {
    type: 'search',
    className: 'search-input',
    value,
    placeholder,
    'aria-label': ariaLabel || placeholder || undefined,
    onInput: (e) => {
      clearBtn.hidden = !e.currentTarget.value;
      if (typeof onInput === 'function') onInput(e.currentTarget.value);
    }
  });
  const clearBtn = h('button', {
    type: 'button',
    className: 'search-clear',
    hidden: !value,
    'aria-label': clearLabel || undefined,
    onClick: () => {
      input.value = '';
      clearBtn.hidden = true;
      if (typeof onInput === 'function') onInput('');
      input.focus();
    }
  }, icon('x', 14));
  return h('label', { className: 'search-field' },
    h('span', { className: 'search-leading' }, icon('search', 14)),
    input,
    clearBtn
  );
}

/**
 * Stat strip: a single hairline surface split into equal columns.
 * @param {{ label:any, value:any, meta?:any, aside?:any }[]} cells
 */
export function statStrip(cells = []) {
  return h(
    'div',
    { className: 'stat-strip', style: { '--stat-cols': String(cells.length || 1) } },
    cells.map((c) => h(
      'div',
      { className: 'stat' },
      h('div', { className: 'stat-label' }, h('span', null, c.label), c.aside || null),
      h('div', { className: 'stat-value' }, c.value),
      c.meta ? h('div', { className: 'stat-meta' }, c.meta) : null
    ))
  );
}

/** Key/value list with hairline rows (dialog summaries). */
export function kvList(rows = []) {
  return h(
    'dl',
    { className: 'kv-list' },
    rows.filter(Boolean).map(([k, v]) => h('div', { className: 'kv-row' },
      h('dt', { className: 'kv-key' }, k),
      h('dd', { className: 'kv-val' }, v)
    ))
  );
}

/** Small dot-separated meta line (e.g. "128 MB · 2025-01-01"). */
export function metaLine(...parts) {
  const items = parts.flat().filter((p) => p !== null && p !== undefined && p !== false && p !== '');
  const out = [];
  items.forEach((p, i) => {
    if (i > 0) out.push(h('span', { className: 'meta-sep', 'aria-hidden': 'true' }, '·'));
    out.push(typeof p === 'string' || typeof p === 'number' ? h('span', null, String(p)) : p);
  });
  return h('span', { className: 'meta-line' }, out);
}

/** Empty / loading placeholder row. */
export function emptyState(text) {
  return h('div', { className: 'empty-state' }, text);
}

/** Selectable option card (AppearanceRow `.themeCube` selection language: platform fill + selected border). */
export function optionCard({ input, title, tag = null, desc = null, disabled = false }) {
  return h(
    'label',
    { className: `option-card${disabled ? ' is-disabled' : ''}` },
    input,
    h('span', { className: 'option-card-body' },
      h('span', { className: 'option-card-title' }, h('span', null, title), tag),
      desc ? h('span', { className: 'option-card-desc' }, desc) : null
    )
  );
}
