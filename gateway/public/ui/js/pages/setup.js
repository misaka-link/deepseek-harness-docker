/**
 * Initial Access Passcode Setup Page (/setup).
 * Includes dual-input confirmation, 4-level live strength meter, weak blacklist check,
 * and dynamic ADMIN_PATH redirect upon completion.
 */

import { h, icon, clear, richText } from '../lib/dom.js';
import { initTheme, subscribeTheme } from '../lib/theme.js';
import { initI18n, subscribeLocale, t } from '../lib/i18n.js';
import { apiJson, getAdminPath } from '../lib/api.js';
import { evaluatePasswordStrength, WEAK_PASSWORDS } from '../lib/format.js';
import { createNotice, spinnerGlyph } from '../components/pill.js';
import { standaloneShell, standaloneHead, standaloneField } from '../components/standalone.js';

const MIN_LEN = 6;

async function bootSetup() {
  initTheme();
  await initI18n();

  const root = document.getElementById('app');
  if (!root) return;

  let pwdVal = '';
  let confirmVal = '';
  let showPwd = false;
  let errorText = '';
  let okText = '';
  let submitting = false;

  function renderStrengthNodes(pwd) {
    const res = evaluatePasswordStrength(pwd);
    const labels = ['', t('auth', 'strengthWeak'), t('auth', 'strengthFair'), t('auth', 'strengthGood'), t('auth', 'strengthStrong')];
    return h(
      'div',
      { className: 'strength', dataset: { level: String(res.score) } },
      h('div', { className: 'strength-bars', 'aria-hidden': 'true' },
        [1, 2, 3, 4].map((idx) => h('span', { className: `strength-seg${res.score >= idx ? ' is-on' : ''}` }))
      ),
      h('span', { className: 'strength-text', 'aria-live': 'polite' },
        res.isBlacklisted
          ? t('auth', 'strengthBlacklisted')
          : (res.score > 0 ? `${t('auth', 'strengthLabel')}: ${labels[res.score]}` : t('auth', 'strengthPrompt'))
      )
    );
  }

  function render() {
    document.title = t('auth', 'setupPageTitle');

    const strengthHost = h('div', { className: 'field-under' }, renderStrengthNodes(pwdVal));
    const matchHintEl = h('div', { className: 'field-hint', 'aria-live': 'polite' });

    function updateDynamicHints() {
      clear(strengthHost);
      strengthHost.appendChild(renderStrengthNodes(pwdVal));
      matchHintEl.classList.remove('text-success', 'text-danger');
      if (!confirmVal) {
        matchHintEl.textContent = '';
      } else if (pwdVal === confirmVal) {
        matchHintEl.textContent = t('auth', 'passwordsMatch');
        matchHintEl.classList.add('text-success');
      } else {
        matchHintEl.textContent = t('auth', 'passwordsMismatch');
        matchHintEl.classList.add('text-danger');
      }
    }

    const locked = submitting || Boolean(okText);

    const pwdInput = h('input', {
      type: showPwd ? 'text' : 'password',
      id: 'setupPwd',
      className: 'input input-lg has-trailing',
      value: pwdVal,
      placeholder: t('auth', 'setupPwdPlaceholder'),
      autocomplete: 'new-password',
      disabled: locked,
      onInput: (e) => {
        pwdVal = e.currentTarget.value;
        updateDynamicHints();
      }
    });

    const pwd2Input = h('input', {
      type: showPwd ? 'text' : 'password',
      id: 'setupPwdConfirm',
      className: 'input input-lg',
      value: confirmVal,
      placeholder: t('auth', 'setupConfirmPlaceholder'),
      autocomplete: 'new-password',
      disabled: locked,
      onInput: (e) => {
        confirmVal = e.currentTarget.value;
        updateDynamicHints();
      }
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

    updateDynamicHints();

    const submitBtn = h(
      'button',
      {
        type: 'submit',
        className: 'btn btn-primary btn-lg btn-block',
        disabled: locked
      },
      submitting ? spinnerGlyph(14) : null,
      h('span', { className: 'btn-label' }, submitting ? t('auth', 'setupSaving') : t('auth', 'setupSubmitBtn'))
    );

    const form = h(
      'form',
      {
        className: 'standalone-form',
        autocomplete: 'off',
        onSubmit: async (e) => {
          e.preventDefault();
          errorText = '';
          okText = '';

          if (pwdVal.length < MIN_LEN) {
            errorText = t('auth', 'errMinLength', { min: MIN_LEN });
            render();
            return;
          }
          if (pwdVal !== confirmVal) {
            errorText = t('errors', 'SETUP_PASSWORD_MISMATCH');
            render();
            return;
          }
          if (WEAK_PASSWORDS.has(pwdVal.toLowerCase())) {
            errorText = t('errors', 'SETUP_PASSWORD_BLACKLISTED');
            render();
            return;
          }

          submitting = true;
          render();

          const r = await apiJson('/__auth/setup', {
            method: 'POST',
            json: { password: pwdVal, confirm: confirmVal },
            timeoutMs: 15000,
            skipAuthRedirect: true
          });

          submitting = false;
          if (r.ok) {
            okText = t('auth', 'setupSuccessRedirect');
            render();
            const target = `${getAdminPath()}/`;
            setTimeout(() => { window.location.href = target; }, 800);
          } else {
            errorText = r.message || t('errors', 'UNKNOWN');
            render();
          }
        }
      },
      standaloneField({
        label: t('auth', 'setupPwdLabel'),
        htmlFor: 'setupPwd',
        control: h('div', { className: 'field-with-trailing' }, pwdInput, eyeBtn),
        hint: strengthHost
      }),
      standaloneField({
        label: t('auth', 'setupConfirmLabel'),
        htmlFor: 'setupPwdConfirm',
        control: pwd2Input,
        hint: matchHintEl
      }),
      submitBtn
    );

    const rules = h(
      'ul',
      { className: 'rules-list' },
      [t('auth', 'setupRule1'), t('auth', 'setupRule2'), t('auth', 'setupRule3')].map((rule) => h(
        'li',
        null,
        h('span', { className: 'rules-icon' }, icon('check', 14)),
        h('span', null, richText(rule))
      ))
    );

    const shell = standaloneShell({
      onPrefsChanged: render,
      children: [
        standaloneHead({ title: t('auth', 'setupHeading'), desc: richText(t('auth', 'setupDesc')) }),
        errorText ? createNotice({ level: 'danger', body: errorText }) : null,
        okText ? createNotice({ level: 'success', body: okText }) : null,
        rules,
        form
      ]
    });

    clear(root);
    root.appendChild(shell);
  }

  subscribeLocale(render);
  subscribeTheme(render);
  render();
}

bootSetup();
