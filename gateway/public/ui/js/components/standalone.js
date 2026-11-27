/**
 * Standalone page chrome (/setup, /login, /locked, /desktop-starting, /account/callback):
 * pure base canvas with a faint ambient wash, unobtrusive top-right preference capsule,
 * and a borderless centred column led by the official `deepseek HARNESS` lockup.
 */

import { h } from '../lib/dom.js';
import { brandWordmark } from './brand.js';
import { createQuickPrefsBar } from './lang-theme-picker.js';

/**
 * @param {{ children: any[], footer?: any, onPrefsChanged?: Function, width?: 'sm'|'md'|'lg', className?: string }} opts
 */
export function standaloneShell({ children = [], footer = null, onPrefsChanged = null, width = 'sm', className = '' } = {}) {
  return h(
    'div',
    { className: `standalone${className ? ' ' + className : ''}` },
    h('div', { className: 'standalone-wash', 'aria-hidden': 'true' }),
    h('div', { className: 'standalone-bar' }, createQuickPrefsBar({ onChanged: onPrefsChanged })),
    h('main', { className: 'standalone-main' },
      h('div', { className: `standalone-col is-${width}` }, children)
    ),
    footer ? h('footer', { className: 'standalone-footer' }, footer) : null
  );
}

/**
 * Brand header. When `title` is omitted the wordmark itself is the page heading.
 */
export function standaloneHead({ title = '', desc = null, wordmarkSize = 0, align = 'center', leading = null } = {}) {
  const size = wordmarkSize || (title ? 22 : 30);
  return h(
    'header',
    { className: `standalone-head is-${align}` },
    title
      ? h('div', { className: 'standalone-logo' }, brandWordmark({ size }))
      : h('h1', { className: 'standalone-logo' }, brandWordmark({ size })),
    leading,
    title ? h('h1', { className: 'standalone-title' }, title) : null,
    desc ? h('p', { className: 'standalone-desc' }, desc) : null
  );
}

/** Labelled field block for standalone forms. */
export function standaloneField({ label = '', htmlFor = '', control = null, hint = null } = {}) {
  return h(
    'div',
    { className: 'field' },
    label ? h('label', { className: 'field-label', for: htmlFor || undefined }, label) : null,
    control,
    hint
  );
}
