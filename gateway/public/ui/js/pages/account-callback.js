/**
 * DeepSeek Account OAuth Manual Callback Page (/account/callback).
 */

import { h, icon, clear, richText } from '../lib/dom.js';
import { initTheme, subscribeTheme } from '../lib/theme.js';
import { initI18n, subscribeLocale, t } from '../lib/i18n.js';
import { apiJson } from '../lib/api.js';
import { spinnerGlyph } from '../components/pill.js';
import { standaloneShell, standaloneHead, standaloneField } from '../components/standalone.js';

async function bootAccountCallback() {
  initTheme();
  await initI18n();

  const root = document.getElementById('app');
  if (!root) return;

  let linkValue = '';
  let submitting = false;
  let outputText = '';
  let outputState = ''; // '' | 'ok' | 'err'

  function render() {
    document.title = t('auth', 'callbackPageTitle');

    const textarea = h('textarea', {
      id: 'callbackLinkInput',
      className: 'input textarea',
      value: linkValue,
      rows: 4,
      placeholder: 'http://localhost:3080/oauth/callback?code=...&state=...',
      disabled: submitting,
      onInput: (e) => { linkValue = e.currentTarget.value; }
    });

    const submitBtn = h(
      'button',
      {
        type: 'submit',
        className: 'btn btn-primary',
        disabled: submitting
      },
      submitting ? spinnerGlyph(14) : icon('key', 16),
      h('span', { className: 'btn-label' }, submitting ? t('common', 'submitting') : t('auth', 'callbackSubmitBtn'))
    );

    const form = h(
      'form',
      {
        className: 'standalone-form',
        onSubmit: async (e) => {
          e.preventDefault();
          const link = linkValue.trim();
          if (!link || submitting) return;
          submitting = true;
          outputState = '';
          outputText = t('common', 'submitting');
          render();

          const r = await apiJson('/account/callback', {
            method: 'POST',
            json: { link },
            timeoutMs: 25000
          });

          submitting = false;
          const extra = r.data?.status ? ` / DSH ${r.data.status}` : '';
          if (r.ok) {
            outputState = 'ok';
            outputText = `[OK] ${r.data?.message || t('auth', 'callbackSuccess')} (HTTP ${r.status}${extra})`;
          } else {
            outputState = 'err';
            outputText = `[ERR] ${r.message} (HTTP ${r.status || 'ERR'}${extra})`;
          }
          render();
        }
      },
      standaloneField({ label: t('auth', 'callbackInputLabel'), htmlFor: 'callbackLinkInput', control: textarea }),
      h('div', { className: 'actions' },
        submitBtn,
        h('a', { href: '/', className: 'btn btn-ghost' }, icon('workspace', 16), h('span', { className: 'btn-label' }, t('shell', 'openWorkspace')))
      )
    );

    const shell = standaloneShell({
      onPrefsChanged: render,
      width: 'md',
      children: [
        standaloneHead({ title: t('auth', 'callbackHeading'), desc: richText(t('auth', 'callbackDesc')), align: 'start' }),
        form,
        outputText
          ? h('pre', { className: 'log-box is-compact', dataset: { state: outputState || 'pending' } }, outputText)
          : null,
        h('p', { className: 'field-hint' }, t('auth', 'callbackTip'))
      ]
    });

    clear(root);
    root.appendChild(shell);
  }

  subscribeLocale(render);
  subscribeTheme(render);
  render();
}

bootAccountCallback();
