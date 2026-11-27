/**
 * Panel 5: Gateway, Access Security, Reverse Proxy, Self-Healing, Bundle Cleanup, and Appearance.
 * DSH SettingsForm layout: flat sections, hairline-separated horizontal rows
 * (label + description left, 300px control right; stacks below 640px).
 */

import { h, icon, clear, richText } from '../lib/dom.js';
import { t, SUPPORTED_LOCALES, LOCALE_META, getLocaleMode, setLocaleMode } from '../lib/i18n.js';
import { getThemeMode, setThemeMode } from '../lib/theme.js';
import { apiJson } from '../lib/api.js';
import { evaluatePasswordStrength } from '../lib/format.js';
import { createNotice, createTag } from '../components/pill.js';
import { openModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import {
  button, pageHeader, section, settingRow, textInput, selectInput, switchInput,
  checkbox, checkboxRow, formFooter, emptyState
} from '../components/ui.js';

const THEME_CUBES = [
  { id: 'dsh', icon: 'layers', labelKey: 'themeFollowDshShort' },
  { id: 'light', icon: 'sun', labelKey: 'themeLight' },
  { id: 'dark', icon: 'moon', labelKey: 'themeDark' },
  { id: 'system', icon: 'system', labelKey: 'themeSystem' }
];

export function renderStrengthMeter(pwd, { prompt = '' } = {}) {
  const res = evaluatePasswordStrength(pwd);
  const labels = ['', t('auth', 'strengthWeak'), t('auth', 'strengthFair'), t('auth', 'strengthGood'), t('auth', 'strengthStrong')];
  return h(
    'div',
    { className: 'strength', dataset: { level: String(res.score) } },
    h('div', { className: 'strength-bars', 'aria-hidden': 'true' },
      [1, 2, 3, 4].map((idx) => h('span', { className: `strength-seg${res.score >= idx ? ' is-on' : ''}` }))
    ),
    h('span', { className: 'strength-text' },
      res.isBlacklisted
        ? t('auth', 'strengthBlacklisted')
        : (res.score > 0 ? `${t('auth', 'strengthLabel')}: ${labels[res.score]}` : prompt)
    )
  );
}

/** Re-sync appearance cubes / language select after an external theme or locale change. */
export function syncAppearanceControls(container) {
  if (!container) return;
  const mode = getThemeMode();
  for (const cube of container.querySelectorAll('[data-theme-cube]')) {
    const sel = cube.dataset.themeCube === mode;
    cube.classList.toggle('is-selected', sel);
    cube.setAttribute('aria-pressed', sel ? 'true' : 'false');
  }
  const langSel = container.querySelector('[data-lang-select]');
  if (langSel && document.activeElement !== langSel) langSel.value = getLocaleMode();
}

function renderAppearanceSection(container) {
  const mode = getThemeMode();
  const cubes = h(
    'div',
    { className: 'theme-cubes', role: 'group', 'aria-label': t('shell', 'theme') },
    THEME_CUBES.map((c) => h(
      'button',
      {
        type: 'button',
        className: `theme-cube${mode === c.id ? ' is-selected' : ''}`,
        'aria-pressed': mode === c.id ? 'true' : 'false',
        dataset: { themeCube: c.id },
        onClick: () => {
          setThemeMode(c.id);
          syncAppearanceControls(container);
        }
      },
      icon(c.icon, 16),
      h('span', null, t('shell', c.labelKey))
    ))
  );

  const langSelect = selectInput(
    {
      dataset: { langSelect: '1' },
      'aria-label': t('shell', 'language'),
      onChange: async (e) => {
        await setLocaleMode(e.currentTarget.value);
      }
    },
    [
      h('option', { value: 'dsh', selected: getLocaleMode() === 'dsh' }, t('shell', 'followDsh')),
      ...SUPPORTED_LOCALES.map((id) => h('option', { value: id, selected: getLocaleMode() === id }, LOCALE_META[id].label))
    ]
  );

  return section({
    title: t('settings', 'appearanceCardTitle'),
    desc: t('settings', 'appearanceCardDesc'),
    children: [
      h('div', { className: 'setting-row is-stack setting-appearance' },
        h('div', { className: 'setting-text' }, h('div', { className: 'setting-label' }, t('shell', 'theme'))),
        cubes
      ),
      settingRow({ label: t('shell', 'language'), control: langSelect })
    ]
  });
}

export function renderSettingsPanel(container, ctx) {
  const { status, isMini } = ctx.state;

  if (!status) {
    clear(container);
    container.append(
      pageHeader({ title: t('settings', 'gatewayCardTitle'), desc: t('settings', 'gatewayCardDesc') }),
      emptyState(t('common', 'loading'))
    );
    return;
  }

  const paths = status?.paths || {};
  const d = status?.desktop || {};

  // ---- Gateway & access controls ----
  const portInput = textInput({ type: 'number', id: 'cfgPort', min: 1, max: 65535, value: String(paths.proxyPort || 3080) });
  const adminPathInput = textInput({ id: 'cfgAdminPath', value: paths.admin || '/admin', placeholder: '/admin' });
  const vncPathInput = textInput({ id: 'cfgVncPath', value: (paths.vnc || '/vnc').replace(/\/+$/, '') || '/vnc', placeholder: '/vnc' });

  let tokenVisible = false;
  const strengthHost = h('div', { className: 'field-under' });
  const tokenInput = textInput({
    type: 'password',
    id: 'cfgToken',
    className: 'has-trailing',
    autocomplete: 'new-password',
    placeholder: status?.hasAuthToken ? t('settings', 'tokenSetPlaceholder') : t('settings', 'tokenUnsetPlaceholder'),
    title: status?.hasAuthToken ? t('settings', 'tokenSetPlaceholder') : t('settings', 'tokenUnsetPlaceholder'),
    onInput: () => {
      clear(strengthHost);
      if (tokenInput.value) strengthHost.appendChild(renderStrengthMeter(tokenInput.value));
    }
  });
  const toggleEyeBtn = h('button', {
    type: 'button',
    className: 'field-trailing',
    'aria-label': t('auth', 'showPassword'),
    onClick: () => {
      tokenVisible = !tokenVisible;
      tokenInput.type = tokenVisible ? 'text' : 'password';
      toggleEyeBtn.setAttribute('aria-label', tokenVisible ? t('auth', 'hidePassword') : t('auth', 'showPassword'));
      clear(toggleEyeBtn);
      toggleEyeBtn.appendChild(icon(tokenVisible ? 'eyeOff' : 'eye', 16));
    }
  }, icon('eye', 16));

  const clearAuthCb = checkbox({ checked: false });
  const trustProxyCb = switchInput({ checked: Boolean(status?.trustProxy), ariaLabel: t('settings', 'trustProxyLabel'), id: 'cfgTrustProxy' });
  const publicHostInput = textInput({ id: 'cfgPublicHost', value: status?.publicHost || '', placeholder: t('settings', 'publicHostPlaceholder'), title: t('settings', 'publicHostPlaceholder') });

  // ---- Self-healing ----
  const autoHealSelect = selectInput({ id: 'cfgAutoHeal' }, [
    h('option', { value: 'true', selected: status?.autoHealPlugins !== false }, t('settings', 'autoHealOn')),
    h('option', { value: 'false', selected: status?.autoHealPlugins === false }, t('settings', 'autoHealOff'))
  ]);
  const autoHealMaxInput = textInput({ type: 'number', id: 'cfgAutoHealMax', min: 1, max: 20, value: String(status?.autoHealMaxPerBoot || 5) });

  // ---- Ghost bundle cleanup (pruneStaleBundles) ----
  const curPruneMode = status?.pruneStaleBundles || 'known';
  const pruneModeSelect = selectInput({ id: 'cfgPruneMode' }, [
    h('option', { value: 'known', selected: curPruneMode === 'known' }, t('settings', 'pruneKnown')),
    h('option', { value: 'all', selected: curPruneMode === 'all' }, t('settings', 'pruneAll')),
    h('option', { value: 'off', selected: curPruneMode === 'off' }, t('settings', 'pruneOff'))
  ]);
  const curPruneExtra = Array.isArray(status?.pruneBundlesExtra)
    ? status.pruneBundlesExtra.join(',')
    : String(status?.pruneBundlesExtra || '');
  const pruneExtraInput = textInput({ id: 'cfgPruneExtra', value: curPruneExtra, placeholder: t('settings', 'pruneExtraPlaceholder'), title: t('settings', 'pruneExtraPlaceholder') });

  function openDiffConfirmModal(payload, diffs, portChanged) {
    const bodyEl = h(
      'div',
      { className: 'modal-stack' },
      h('p', { className: 'modal-text' }, t('settings', 'confirmDiffIntro')),
      h('ul', { className: 'diff-list' }, diffs.map((line) => h('li', null, line))),
      portChanged ? createNotice({ level: 'warn', body: t('settings', 'portChangeWarn') }) : null
    );

    const cancelBtn = h('button', { type: 'button', className: 'btn', onClick: () => modal.close() }, t('common', 'cancel'));
    const confirmBtn = h('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: async () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = t('settings', 'savingRestarting');
        const r = await apiJson(`${ctx.adminPath}/api/config/save`, {
          method: 'POST',
          json: payload,
          timeoutMs: 25000
        });
        if (!r.ok) {
          showToast(r.message, { type: 'error', errorCode: r.errorCode });
          confirmBtn.disabled = false;
          confirmBtn.textContent = t('settings', 'confirmSaveBtn');
          return;
        }

        const newProtocol = window.location.protocol;
        const newHost = window.location.hostname;
        const newPort = r.data?.newPort || payload.proxyPort;
        const newAdminPath = r.data?.newAdminPath || payload.adminPath;
        const portPart = (newProtocol === 'http:' && newPort === 80) || (newProtocol === 'https:' && newPort === 443)
          ? ''
          : `:${newPort}`;
        const targetUrl = `${newProtocol}//${newHost}${portPart}${newAdminPath}/`;

        let cd = 3;
        const cdEl = h('p', { className: 'modal-hint' }, t('settings', 'redirectCountdown', { seconds: cd }));

        clear(modal.bodyEl);
        modal.bodyEl.appendChild(
          createNotice({
            level: 'success',
            title: t('settings', 'saveSuccessTitle'),
            body: h('div', null,
              h('div', null, t('settings', 'saveSuccessDesc')),
              h('code', { className: 'inline-url' }, targetUrl),
              cdEl
            )
          })
        );
        if (modal.footerEl) clear(modal.footerEl);

        const timer = setInterval(() => {
          cd -= 1;
          cdEl.textContent = t('settings', 'redirectCountdown', { seconds: Math.max(cd, 0) });
          if (cd <= 0) {
            clearInterval(timer);
            window.location.href = targetUrl;
          }
        }, 1000);
      }
    }, t('settings', 'confirmSaveBtn'));

    const modal = openModal({
      title: t('settings', 'confirmModalTitle'),
      iconName: 'settings',
      iconTone: portChanged ? 'warn' : '',
      closeOnBackdrop: false,
      content: bodyEl,
      footer: [cancelBtn, confirmBtn]
    });
  }

  function handlePrepareSave() {
    const newPort = parseInt(portInput.value, 10) || 3080;
    const newAdmin = adminPathInput.value.trim() || '/admin';
    const newVnc = isMini ? (paths.vnc ?? null) : (vncPathInput.value.trim() || '/vnc');
    const rawToken = tokenInput.value.trim();
    const clearAuth = Boolean(clearAuthCb.checked);
    const newTrustProxy = Boolean(trustProxyCb.checked);
    const newPublicHost = publicHostInput.value.trim();
    const newAutoHeal = autoHealSelect.value !== 'false';
    const newAutoHealMax = Math.max(1, Math.min(20, parseInt(autoHealMaxInput.value, 10) || 5));
    const newPruneMode = pruneModeSelect.value || 'known';
    const newPruneExtra = pruneExtraInput.value.trim();

    if (newPort < 1 || newPort > 65535) {
      showToast(t('errors', 'CONFIG_PORT_INVALID'), 'error');
      return;
    }

    const oldPort = Number(paths.proxyPort) || 3080;
    const oldAdmin = paths.admin || '/admin';
    const oldVnc = (paths.vnc || '/vnc').replace(/\/+$/, '') || '/vnc';
    const oldTrustProxy = Boolean(status?.trustProxy);
    const oldPublicHost = String(status?.publicHost || '').trim();
    const oldAutoHeal = status?.autoHealPlugins !== false;
    const oldAutoHealMax = Number(status?.autoHealMaxPerBoot) || 5;
    const oldPruneMode = status?.pruneStaleBundles || 'known';
    const oldPruneExtra = curPruneExtra.trim();

    const diffs = [];
    if (newPort !== oldPort) diffs.push(`${t('settings', 'portLabel')}: ${oldPort} → ${newPort}`);
    if (newAdmin !== oldAdmin) diffs.push(`${t('settings', 'adminPathLabel')}: ${oldAdmin} → ${newAdmin}`);
    if (!isMini && newVnc !== oldVnc) diffs.push(`${t('settings', 'vncPathLabel')}: ${oldVnc} → ${newVnc}`);
    if (rawToken) diffs.push(`${t('settings', 'tokenLabel')}: ${t('settings', 'diffTokenUpdated')}`);
    else if (clearAuth && status?.hasAuthToken) diffs.push(`${t('settings', 'tokenLabel')}: ${t('settings', 'diffTokenCleared')}`);
    if (newTrustProxy !== oldTrustProxy) diffs.push(`${t('settings', 'trustProxyLabel')}: ${oldTrustProxy} → ${newTrustProxy}`);
    if (newPublicHost !== oldPublicHost) diffs.push(`${t('settings', 'publicHostLabel')}: ${oldPublicHost || t('common', 'none')} → ${newPublicHost || t('common', 'none')}`);
    if (newAutoHeal !== oldAutoHeal) diffs.push(`${t('settings', 'autoHealLabel')}: ${oldAutoHeal} → ${newAutoHeal}`);
    if (newAutoHealMax !== oldAutoHealMax) diffs.push(`${t('settings', 'autoHealMaxLabel')}: ${oldAutoHealMax} → ${newAutoHealMax}`);
    if (newPruneMode !== oldPruneMode) diffs.push(`${t('settings', 'pruneModeLabel')}: ${oldPruneMode} → ${newPruneMode}`);
    if (newPruneExtra !== oldPruneExtra) diffs.push(`${t('settings', 'pruneExtraLabel')}: ${oldPruneExtra || t('common', 'none')} → ${newPruneExtra || t('common', 'none')}`);

    if (diffs.length === 0) {
      showToast(t('settings', 'toastNoChanges'), 'info');
      return;
    }

    const payload = {
      proxyPort: newPort,
      adminPath: newAdmin,
      vncPath: newVnc,
      authToken: rawToken || undefined,
      clearAuthToken: clearAuth,
      trustProxy: newTrustProxy,
      publicHost: newPublicHost,
      autoHealPlugins: newAutoHeal,
      autoHealMaxPerBoot: newAutoHealMax,
      pruneStaleBundles: newPruneMode,
      pruneBundlesExtra: newPruneExtra
    };

    openDiffConfirmModal(payload, diffs, newPort !== oldPort);
  }

  const gatewaySection = section({
    title: t('settings', 'sectionGateway'),
    aside: createTag({ tone: 'outline', text: t('settings', 'restartAppliesTag') }),
    children: [
      settingRow({ label: t('settings', 'portLabel'), htmlFor: 'cfgPort', control: portInput }),
      settingRow({ label: t('settings', 'adminPathLabel'), htmlFor: 'cfgAdminPath', control: adminPathInput }),
      !isMini
        ? settingRow({ label: t('settings', 'vncPathLabel'), htmlFor: 'cfgVncPath', control: vncPathInput, dataset: { desktopOnly: '1' } })
        : null,
      settingRow({
        label: t('settings', 'tokenLabel'),
        htmlFor: 'cfgToken',
        desc: checkboxRow({ input: clearAuthCb, label: t('settings', 'clearTokenLabel') }),
        control: h('div', { className: 'field-stack' },
          h('div', { className: 'field-with-trailing' }, tokenInput, toggleEyeBtn),
          strengthHost
        )
      }),
      settingRow({
        label: t('settings', 'trustProxyLabel'),
        htmlFor: 'cfgTrustProxy',
        desc: t('settings', 'trustProxyDesc'),
        control: trustProxyCb,
        auto: true
      }),
      settingRow({
        label: t('settings', 'publicHostLabel'),
        htmlFor: 'cfgPublicHost',
        desc: t('settings', 'publicHostHint'),
        control: publicHostInput,
        wide: true
      }),
      !isMini
        ? settingRow({
          label: t('settings', 'desktopReadOnlyTitle'),
          desc: t('settings', 'desktopReadOnlySummary', {
            res: `${d.width || 1440}x${d.height || 900}`,
            idle: d.idleTimeoutMinutes === 0 ? t('desktop', 'idleNever') : t('desktop', 'idleMinutes', { minutes: d.idleTimeoutMinutes ?? 30 }),
            cdp: d.enableCdp !== false ? `:${d.cdpPort || 9222}` : t('common', 'none')
          }),
          control: button({ size: 'sm', label: t('settings', 'goDesktopTabBtn'), iconName: 'chevronRight', onClick: () => ctx.actions.switchTab('desktop') }),
          auto: true,
          dataset: { desktopOnly: '1' }
        })
        : null
    ]
  });

  const autoHealSection = section({
    title: t('settings', 'autoHealLabel'),
    aside: createTag({ tone: 'outline', text: t('settings', 'experimentalTag') }),
    children: [
      settingRow({ label: t('settings', 'autoHealSwitchLabel'), htmlFor: 'cfgAutoHeal', control: autoHealSelect }),
      settingRow({ label: t('settings', 'autoHealMaxLabel'), htmlFor: 'cfgAutoHealMax', desc: t('settings', 'autoHealMaxHint'), control: autoHealMaxInput })
    ]
  });

  const pruneSection = section({
    title: t('settings', 'pruneModeLabel'),
    desc: richText(t('settings', 'pruneDesc')),
    aside: createTag({ tone: 'outline', text: t('settings', 'containerRestartTag') }),
    children: [
      settingRow({ label: t('settings', 'prunePolicyLabel'), htmlFor: 'cfgPruneMode', control: pruneModeSelect }),
      settingRow({ label: t('settings', 'pruneExtraLabel'), htmlFor: 'cfgPruneExtra', desc: richText(t('settings', 'pruneExtraHint')), control: pruneExtraInput, wide: true }),
      h('p', { className: 'section-footnote' }, richText(t('settings', 'pruneContainerWarn')))
    ]
  });

  const saveSection = h(
    'div',
    { className: 'section section-save' },
    createNotice({
      level: 'info',
      title: t('settings', 'portPathNoticeTitle'),
      body: richText(t('settings', 'portPathNoticeBody'))
    }),
    formFooter(
      button({ variant: 'primary', label: t('settings', 'saveRestartBtn'), onClick: handlePrepareSave }),
      button({
        label: t('settings', 'resetFormBtn'),
        onClick: async () => {
          await ctx.actions.refreshStatus();
          ctx.actions.renderMain();
        }
      })
    )
  );

  clear(container);
  container.append(
    pageHeader({ title: t('settings', 'gatewayCardTitle'), desc: t('settings', 'gatewayCardDesc') }),
    gatewaySection,
    autoHealSection,
    pruneSection,
    saveSection,
    renderAppearanceSection(container)
  );
}
