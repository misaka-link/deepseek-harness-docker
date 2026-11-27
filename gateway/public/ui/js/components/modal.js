/**
 * Accessible Modal Dialog & Promise-based Confirmation Dialog.
 * Geometry ported from dsh-client-ui-primitives Modal.module.css:
 * full-viewport layer + mask, secondary-layer card with prominent elevation,
 * 22/24/12 header, 24px content column, trailing-edge footer actions.
 */

import { h, icon } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

const openModals = [];
let keyHandlerBound = false;

function syncBodyScroll() {
  document.body.style.overflow = openModals.length > 0 ? 'hidden' : '';
}

function getFocusable(root) {
  return Array.from(
    root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
  ).filter((el) => el.offsetParent !== null);
}

function bindGlobalKeys() {
  if (keyHandlerBound) return;
  keyHandlerBound = true;
  document.addEventListener('keydown', (e) => {
    if (openModals.length === 0) return;
    const top = openModals[openModals.length - 1];
    if (e.key === 'Escape' && top.closeOnEsc) {
      e.preventDefault();
      top.close();
      return;
    }
    if (e.key === 'Tab') {
      const list = getFocusable(top.dialogEl);
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

let modalSeq = 0;

/**
 * Open a modal dialog.
 */
export function openModal({
  title = '',
  iconName = '',
  iconTone = '',
  wide = false,
  closeOnBackdrop = true,
  closeOnEsc = true,
  showCloseButton = true,
  content = null,
  footer = null,
  footerBetween = false,
  onClose = null
} = {}) {
  bindGlobalKeys();
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `dsh-modal-title-${++modalSeq}`;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const idx = openModals.indexOf(entry);
    if (idx >= 0) openModals.splice(idx, 1);
    backdrop.remove();
    syncBodyScroll();
    if (typeof onClose === 'function') {
      try { onClose(); } catch {}
    }
    if (prevFocus && document.body.contains(prevFocus)) {
      try { prevFocus.focus(); } catch {}
    }
  };

  // Restrained: only genuine warnings / errors carry a leading glyph (Modal `.warning` variant).
  const tone = iconTone === 'danger' || iconTone === 'warn' ? iconTone : '';
  const glyph = tone ? (tone === 'danger' ? 'alertCircle' : 'alertTriangle') : '';

  const bodyEl = h('div', { className: 'modal-body' }, content);
  const footerEl = footer
    ? h('div', { className: `modal-footer${footerBetween ? ' is-between' : ''}` }, footer)
    : null;

  const headerEl = h(
    'div',
    { className: 'modal-header' },
    h(
      'h2',
      { id: titleId, className: 'modal-title' },
      glyph ? h('span', { className: 'modal-title-icon', dataset: { tone } }, icon(glyph, 16)) : null,
      h('span', null, title)
    ),
    showCloseButton
      ? h('button', {
        type: 'button',
        className: 'modal-close',
        'aria-label': t('common', 'close'),
        onClick: close
      }, icon('x', 16))
      : null
  );

  const dialogEl = h(
    'div',
    {
      className: `modal-dialog${wide ? ' modal-dialog--wide' : ''}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1'
    },
    headerEl,
    bodyEl,
    footerEl
  );

  const mask = h('div', { className: 'modal-mask', 'aria-hidden': 'true' });

  const backdrop = h(
    'div',
    {
      className: 'modal-root',
      onClick: (e) => {
        if (closeOnBackdrop && (e.target === backdrop || e.target === mask)) close();
      }
    },
    mask,
    dialogEl
  );

  const entry = { backdrop, dialogEl, close, closeOnEsc };
  openModals.push(entry);
  document.body.appendChild(backdrop);
  syncBodyScroll();

  setTimeout(() => {
    const focusables = getFocusable(dialogEl).filter((el) => !el.classList.contains('modal-close'));
    const target = focusables[0] || dialogEl;
    try { target.focus(); } catch {}
  }, 20);

  return { close, backdrop, dialogEl, bodyEl, footerEl };
}

export function closeAllModals() {
  while (openModals.length > 0) {
    openModals[openModals.length - 1].close();
  }
}

/**
 * Show a standardized confirmation modal and resolve to boolean.
 */
export function askConfirm({
  title = '',
  iconName = 'info',
  iconTone = 'info',
  body = null,
  confirmText = '',
  cancelText = '',
  confirmKind = 'primary',
  destructive = false
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(val);
    };

    const btnClass = confirmKind === 'danger' ? 'btn btn-danger' : 'btn btn-primary';

    const okBtn = h('button', {
      type: 'button',
      className: btnClass,
      onClick: () => finish(true)
    }, confirmText || t('common', 'ok'));

    const cancelBtn = h('button', {
      type: 'button',
      className: 'btn',
      onClick: () => finish(false)
    }, cancelText || t('common', 'cancel'));

    const modal = openModal({
      title: title || t('common', 'confirmTitle'),
      iconName,
      iconTone,
      closeOnBackdrop: !destructive,
      content: body,
      footer: [cancelBtn, okBtn],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }
    });

    setTimeout(() => { try { okBtn.focus(); } catch {} }, 30);
  });
}
