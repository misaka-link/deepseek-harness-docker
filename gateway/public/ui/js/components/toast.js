/**
 * Toast notifications (dsh-client-ui-primitives Toast.module.css):
 * dark surface in both themes, anchored top-centre, click-through except the action text.
 */

import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { copyToClipboard } from '../lib/format.js';

let hostEl = null;

function ensureHost() {
  if (hostEl && document.body.contains(hostEl)) return hostEl;
  hostEl = document.getElementById('toastHost');
  if (!hostEl) {
    hostEl = h('div', { id: 'toastHost', className: 'toast-host', role: 'region', 'aria-live': 'polite' });
    document.body.appendChild(hostEl);
  }
  return hostEl;
}

const TOAST_TYPES = new Set(['success', 'info', 'warn', 'error']);

/**
 * Show a transient dark toast notification.
 * @param {string} message
 * @param {'success'|'info'|'warn'|'warning'|'error'|{ type?: string, errorCode?: string, duration?: number }} [typeOrOpts]
 */
export function showToast(message, typeOrOpts = 'info') {
  const opts = typeof typeOrOpts === 'string' ? { type: typeOrOpts } : (typeOrOpts || {});
  const rawType = opts.type === 'warning' ? 'warn' : (opts.type || 'info');
  const safeType = TOAST_TYPES.has(rawType) ? rawType : 'info';
  const duration = Number(opts.duration) > 0 ? Number(opts.duration) : 4500;
  const errorCode = opts.errorCode ? String(opts.errorCode) : '';

  const host = ensureHost();
  const copyBtn = (safeType === 'error' && errorCode)
    ? h('button', {
      type: 'button',
      className: 'toast-action',
      onClick: async (e) => {
        const btn = e.currentTarget;
        const ok = await copyToClipboard(errorCode);
        if (ok) {
          btn.textContent = t('common', 'copied');
          setTimeout(() => { btn.textContent = t('common', 'copyErrorCode'); }, 1800);
        }
      }
    }, t('common', 'copyErrorCode'))
    : null;

  const glyph = safeType === 'success' ? 'checkCircle'
    : safeType === 'error' ? 'alertCircle'
      : safeType === 'warn' ? 'alertTriangle'
        : '';

  const toastEl = h(
    'div',
    { className: 'toast', dataset: { type: safeType } },
    glyph ? h('span', { className: 'toast-icon' }, icon(glyph, 16)) : null,
    h('div', { className: 'toast-text' }, String(message || '')),
    copyBtn
  );

  host.appendChild(toastEl);

  const dismiss = () => {
    toastEl.classList.add('is-leaving');
    setTimeout(() => toastEl.remove(), 260);
  };

  setTimeout(dismiss, duration);
  return { dismiss, el: toastEl };
}
