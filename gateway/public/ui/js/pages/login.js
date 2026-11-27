/**
 * Login Page (/login).
 * Preserves strict WHATWG URL same-origin redirect validation, shake animation, and live i18n/theme switching.
 */

import { h, icon, clear } from '../lib/dom.js';
import { initTheme, subscribeTheme } from '../lib/theme.js';
import { initI18n, subscribeLocale, t } from '../lib/i18n.js';
import { apiJson } from '../lib/api.js';
import { createNotice, createStateDot, spinnerGlyph } from '../components/pill.js';
import { standaloneShell, standaloneHead, standaloneField } from '../components/standalone.js';

function getSafeRedirect(raw) {
  if (!raw || typeof raw !== 'string') return '/';
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin !== window.location.origin) return '/';
    const path = parsed.pathname + parsed.search + parsed.hash;
    if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\') || /[\x00-\x1f\s]/.test(path)) {
      return '/';
    }
    return path;
  } catch {
    return '/';
  }
}

async function bootLogin() {
  initTheme();
  await initI18n();

  const root = document.getElementById('app');
  if (!root) return;

  const redirectUrl = getSafeRedirect(new URLSearchParams(window.location.search).get('redirect'));
  let tokenValue = '';
  let showPwd = false;
  let errorText = '';
  let submitting = false;
  let successMode = false;

  function render() {
    document.title = t('auth', 'loginPageTitle');

    const tokenInput = h('input', {
      type: showPwd ? 'text' : 'password',
      id: 'tokenInput',
      className: 'input input-lg has-trailing',
      value: tokenValue,
      placeholder: t('auth', 'tokenPlaceholder'),
      'aria-label': t('auth', 'tokenLabel'),
      autocomplete: 'current-password',
      required: true,
      disabled: submitting || successMode,
      onInput: (e) => { tokenValue = e.currentTarget.value; }
    });

    const eyeBtn = h('button', {
      type: 'button',
      className: 'field-trailing',
      'aria-label': showPwd ? t('auth', 'hidePassword') : t('auth', 'showPassword'),
      title: showPwd ? t('auth', 'hidePassword') : t('auth', 'showPassword'),
      onClick: () => {
        showPwd = !showPwd;
        render();
      }
    }, icon(showPwd ? 'eyeOff' : 'eye', 16));

    const submitBtn = h(
      'button',
      {
        type: 'submit',
        className: 'btn btn-primary btn-lg btn-block',
        disabled: submitting || successMode
      },
      submitting ? spinnerGlyph(14) : null,
      h('span', { className: 'btn-label' }, successMode ? t('auth', 'loginRedirecting') : submitting ? t('auth', 'verifying') : t('auth', 'enterWorkspaceBtn'))
    );

    const form = h(
      'form',
      {
        className: 'standalone-form',
        onSubmit: async (e) => {
          e.preventDefault();
          const trimmed = tokenValue.trim();
          if (!trimmed || submitting) return;

          errorText = '';
          submitting = true;
          render();

          const r = await apiJson('/__auth/verify', {
            method: 'POST',
            json: { token: trimmed },
            timeoutMs: 15000,
            skipAuthRedirect: true
          });

          if (r.ok) {
            submitting = false;
            successMode = true;
            render();
            setTimeout(() => { window.location.href = redirectUrl; }, 260);
          } else {
            submitting = false;
            errorText = r.message || t('errors', 'AUTH_INVALID_TOKEN');
            render();
            const c = root.querySelector('.standalone-col');
            if (c) {
              c.classList.remove('is-shaking');
              void c.offsetWidth;
              c.classList.add('is-shaking');
            }
            const inp = root.querySelector('#tokenInput');
            if (inp) inp.focus();
          }
        }
      },
      standaloneField({
        label: t('auth', 'tokenLabel'),
        htmlFor: 'tokenInput',
        control: h('div', { className: 'field-with-trailing' }, tokenInput, eyeBtn)
      }),
      submitBtn
    );

    const shell = standaloneShell({
      onPrefsChanged: render,
      children: [
        standaloneHead({ desc: t('auth', 'loginSubtitle') }),
        errorText ? createNotice({ level: 'danger', body: errorText }) : null,
        form
      ],
      footer: createStateDot({ state: 'done', text: t('auth', 'gatewayFooter') })
    });

    clear(root);
    root.appendChild(shell);
    if (!submitting && !successMode) {
      setTimeout(() => { try { tokenInput.focus(); } catch {} }, 10);
    }
  }

  subscribeLocale(render);
  subscribeTheme(render);
  render();
}

bootLogin();
