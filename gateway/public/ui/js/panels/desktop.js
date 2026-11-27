/**
 * Panel 3: Browser & Virtual Desktop Control (hidden & disabled on mini variant).
 * Single source of truth for resolution, idle sleep, CDP, sidebar tab, and AI screenshot defaults.
 *
 * Background status polls never rebuild this form while it has unsaved edits
 * (ctx.state.desktopDirty): `patchDesktopRuntime()` only updates the runtime
 * indicators, timer text and action availability in place.
 */

import { h, clear, richText } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { apiJson } from '../lib/api.js';
import { createNotice, createStateDot } from '../components/pill.js';
import { askConfirm } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import {
  button, actions as actionGroup, pageHeader, section, settingRow, textInput, selectInput, formFooter, kvList, emptyState
} from '../components/ui.js';

const PRESET_RESOLUTIONS = ['1440x900', '1920x1080', '1280x720', '1600x900', '2560x1440'];
const IDLE_OPTIONS = [10, 30, 60, 120, 0];
const REFS = Symbol('desktopRefs');

function deriveRuntime(status) {
  const d = status?.desktop || {};
  const desktopEnabled = d.enabled !== false;
  const isRunning = Boolean(d.running);
  const master = desktopEnabled
    ? { state: 'done', text: t('desktop', 'masterEnabledPill') }
    : { state: 'idle', text: t('desktop', 'masterDisabledPill') };
  const runtime = !desktopEnabled
    ? { state: 'idle', text: t('desktop', 'statusMasterDisabled') }
    : isRunning
      ? { state: 'done', text: t('desktop', 'statusRunningCdp') }
      : { state: 'idle', text: t('desktop', 'statusSleeping') };
  const timerText = d.remainingMinutes
    ? t('desktop', 'timerCountdown', { minutes: d.remainingMinutes })
    : (Number(d.idleTimeoutMinutes) > 0
      ? t('desktop', 'timerIdlePolicy', { minutes: d.idleTimeoutMinutes })
      : t('desktop', 'timerAlwaysOn'));
  return { d, desktopEnabled, isRunning, master, runtime, timerText };
}

function swapDot(host, spec) {
  if (!host) return;
  clear(host);
  host.appendChild(createStateDot(spec));
}

/**
 * Patch only runtime indicators / timer / button availability (no form rebuild).
 */
export function patchDesktopRuntime(container, ctx) {
  const refs = container && container[REFS];
  if (!refs || ctx.state.isMini) return;
  const rt = deriveRuntime(ctx.state.status);
  swapDot(refs.masterHost, rt.master);
  swapDot(refs.runtimeHost, rt.runtime);
  swapDot(refs.runtimeRowHost, rt.runtime);
  if (refs.timerEl && refs.timerEl.textContent !== rt.timerText) refs.timerEl.textContent = rt.timerText;
  refs.masterEnableBtn.disabled = rt.desktopEnabled;
  refs.masterDisableBtn.disabled = !rt.desktopEnabled;
  refs.startBtn.disabled = !rt.desktopEnabled || rt.isRunning;
  refs.stopBtn.disabled = !rt.desktopEnabled || !rt.isRunning;
  refs.restartBtn.disabled = !rt.desktopEnabled;
  refs.keepAliveBtn.disabled = !rt.desktopEnabled || !rt.isRunning;
  refs.keepAliveInput.disabled = !rt.desktopEnabled;
  refs.vncLink.classList.toggle('is-disabled', !rt.desktopEnabled);
  if (rt.desktopEnabled) refs.vncLink.removeAttribute('aria-disabled');
  else refs.vncLink.setAttribute('aria-disabled', 'true');
}

export function renderDesktopPanel(container, ctx) {
  const { status, isMini } = ctx.state;
  if (isMini) {
    clear(container);
    container[REFS] = null;
    container.append(
      pageHeader({ title: t('shell', 'navDesktop') }),
      createNotice({
        level: 'warn',
        title: t('desktop', 'miniUnsupportedTitle'),
        body: t('desktop', 'miniUnsupportedBody')
      })
    );
    return;
  }

  if (!status) {
    clear(container);
    container[REFS] = null;
    container.append(
      pageHeader({ title: t('desktop', 'desktopCardTitle'), desc: t('desktop', 'desktopCardDesc') }),
      emptyState(t('common', 'loading'))
    );
    return;
  }

  const rt = deriveRuntime(status);
  const { d, desktopEnabled, isRunning } = rt;
  const vncHref = status?.paths?.vnc || ctx.vncPath || '/vnc/';

  const curW = Number(d.width) || 1440;
  const curH = Number(d.height) || 900;
  const curResStr = `${curW}x${curH}`;
  const isPreset = PRESET_RESOLUTIONS.includes(curResStr);

  // 1. Master switch
  async function handleMasterSwitch(enable) {
    const live = deriveRuntime(ctx.state.status);
    const ok = await askConfirm({
      title: enable ? t('desktop', 'confirmMasterEnableTitle') : t('desktop', 'confirmMasterDisableTitle'),
      iconName: enable ? 'play' : 'alertTriangle',
      iconTone: enable ? 'success' : 'danger',
      destructive: !enable,
      confirmText: enable ? t('desktop', 'confirmEnableBtn') : t('desktop', 'confirmDisableBtn'),
      confirmKind: enable ? 'primary' : 'danger',
      body: h(
        'div',
        { className: 'modal-stack' },
        kvList([
          [t('desktop', 'kvCurrentState'), live.desktopEnabled ? t('desktop', 'masterEnabledPill') : t('desktop', 'masterDisabledPill')],
          [t('desktop', 'kvTargetState'), enable ? t('desktop', 'masterEnabledPill') : t('desktop', 'masterDisabledPill')],
          [t('desktop', 'kvPluginBody'), t('desktop', 'kvPluginKept')]
        ]),
        createNotice({
          level: enable ? 'info' : 'warn',
          title: enable ? t('desktop', 'masterEnableNoticeTitle') : t('desktop', 'masterDisableNoticeTitle'),
          body: richText(enable ? t('desktop', 'masterEnableNoticeBody') : t('desktop', 'masterDisableNoticeBody'))
        }),
        !enable
          ? createNotice({
            level: 'danger',
            title: t('desktop', 'masterPersistWarnTitle'),
            body: t('desktop', 'masterPersistWarnBody')
          })
          : null
      )
    });
    if (!ok) return;

    const btn = enable ? masterEnableBtn : masterDisableBtn;
    btn.disabled = true;
    try {
      const r = await apiJson(`${ctx.adminPath}/api/desktop/master`, {
        method: 'POST',
        json: { enabled: enable, restart: true },
        timeoutMs: 60000
      });
      if (!r.ok) {
        showToast(r.message, { type: 'error', errorCode: r.errorCode });
      } else if (r.data?.dshRestarted) {
        showToast(enable ? t('desktop', 'toastMasterEnabled') : t('desktop', 'toastMasterDisabled'), 'success');
      } else {
        showToast(r.data?.warning || t('desktop', 'toastMasterRestartWarn'), 'warn');
      }
      await ctx.actions.refreshStatus();
    } finally {
      patchDesktopRuntime(container, ctx);
    }
  }

  const masterEnableBtn = button({
    size: 'sm',
    variant: desktopEnabled ? 'outline' : 'primary',
    iconName: 'play',
    label: t('desktop', 'enableBrowserBtn'),
    disabled: desktopEnabled,
    onClick: () => handleMasterSwitch(true)
  });
  const masterDisableBtn = button({
    size: 'sm',
    variant: 'danger',
    iconName: 'square',
    label: t('desktop', 'disableBrowserBtn'),
    disabled: !desktopEnabled,
    onClick: () => handleMasterSwitch(false)
  });

  const masterHost = h('span', { className: 'state-host' }, createStateDot(rt.master));
  const masterSection = section({
    title: t('desktop', 'masterCardTitle'),
    desc: richText(t('desktop', 'masterCardDesc')),
    aside: masterHost,
    children: [
      settingRow({
        label: t('desktop', 'masterScopeTitle'),
        desc: richText(t('desktop', 'masterScopeDesc')),
        control: actionGroup(masterEnableBtn, masterDisableBtn),
        auto: true
      })
    ]
  });

  // 2. Runtime control
  const keepAliveInput = textInput({
    type: 'number',
    id: 'dtKeepAlive',
    min: 1,
    max: 1440,
    placeholder: t('desktop', 'keepAlivePlaceholder'),
    title: t('desktop', 'keepAlivePlaceholder'),
    disabled: !desktopEnabled
  });

  const startBtn = button({
    size: 'sm',
    variant: isRunning || !desktopEnabled ? 'outline' : 'primary',
    iconName: 'play',
    label: t('desktop', 'startBtn'),
    disabled: !desktopEnabled || isRunning,
    onClick: async () => {
      const durationMinutes = parseInt(keepAliveInput.value, 10) || undefined;
      const r = await apiJson(`${ctx.adminPath}/api/desktop/start`, {
        method: 'POST',
        json: durationMinutes ? { durationMinutes } : {},
        timeoutMs: 45000
      });
      if (r.ok) showToast(t('desktop', 'toastStarted'), 'success');
      else showToast(r.message, { type: 'error', errorCode: r.errorCode });
      await ctx.actions.refreshStatus();
    }
  });
  const stopBtn = button({
    size: 'sm',
    variant: 'danger',
    iconName: 'square',
    label: t('desktop', 'stopBtn'),
    disabled: !desktopEnabled || !isRunning,
    onClick: async () => {
      const r = await apiJson(`${ctx.adminPath}/api/desktop/stop`, { method: 'POST', timeoutMs: 30000 });
      if (r.ok) showToast(t('desktop', 'toastStopped'), 'success');
      else showToast(r.message, { type: 'error', errorCode: r.errorCode });
      await ctx.actions.refreshStatus();
    }
  });
  const restartBtn = button({
    size: 'sm',
    iconName: 'refresh',
    label: t('desktop', 'restartBtn'),
    disabled: !desktopEnabled,
    onClick: async () => {
      const r = await apiJson(`${ctx.adminPath}/api/desktop/restart`, { method: 'POST', timeoutMs: 45000 });
      if (r.ok) showToast(t('desktop', 'toastRestarted'), 'success');
      else showToast(r.message, { type: 'error', errorCode: r.errorCode });
      await ctx.actions.refreshStatus();
    }
  });
  const keepAliveBtn = button({
    size: 'sm',
    label: t('desktop', 'keepAliveBtn'),
    disabled: !desktopEnabled || !isRunning,
    onClick: async () => {
      const mins = parseInt(keepAliveInput.value, 10) || 30;
      const r = await apiJson(`${ctx.adminPath}/api/desktop/keepalive`, {
        method: 'POST',
        json: { durationMinutes: mins }
      });
      if (r.ok) showToast(t('desktop', 'toastKeepAlive', { minutes: mins }), 'success');
      else showToast(r.message, { type: 'error', errorCode: r.errorCode });
      await ctx.actions.refreshStatus();
    }
  });
  const vncLink = button({
    size: 'sm',
    variant: 'ghost',
    iconName: 'external',
    label: t('desktop', 'openNoVncBtn'),
    href: vncHref,
    target: '_blank',
    disabled: !desktopEnabled
  });

  const runtimeRowHost = h('span', { className: 'state-host' }, createStateDot(rt.runtime));
  const timerEl = h('span', { className: 'desktop-timer' }, rt.timerText);

  // 3. Parameters form (dirty-tracked)
  const customWInput = textInput({ type: 'number', min: 640, max: 3840, value: String(curW), placeholder: '1440', 'aria-label': t('desktop', 'customResLabel') });
  const customHInput = textInput({ type: 'number', min: 480, max: 2160, value: String(curH), placeholder: '900', 'aria-label': t('desktop', 'customResLabel') });
  const customResRow = settingRow({
    label: t('desktop', 'customResLabel'),
    control: h('div', { className: 'field-pair' }, customWInput, h('span', { className: 'field-pair-sep' }, '×'), customHInput),
    hidden: isPreset
  });

  const resSelect = selectInput(
    {
      id: 'dtResolution',
      onChange: () => {
        customResRow.hidden = resSelect.value !== 'custom';
      }
    },
    [
      ...PRESET_RESOLUTIONS.map((val) => h('option', {
        value: val,
        selected: isPreset && curResStr === val
      }, val === '1440x900' ? `${val} (${t('desktop', 'resDefaultTag')})` : val)),
      h('option', { value: 'custom', selected: !isPreset }, t('desktop', 'resCustomOption'))
    ]
  );

  const curIdle = d.idleTimeoutMinutes !== undefined ? Number(d.idleTimeoutMinutes) : 30;
  const idleOpts = IDLE_OPTIONS.includes(curIdle) ? IDLE_OPTIONS : [...IDLE_OPTIONS, curIdle];
  const idleSelect = selectInput({ id: 'dtIdle' },
    idleOpts.map((mins) => h('option', { value: String(mins), selected: curIdle === mins },
      mins === 0 ? t('desktop', 'idleNever') : t('desktop', 'idleMinutes', { minutes: mins })
    ))
  );

  const cdpSelect = selectInput({ id: 'dtCdp' }, [
    h('option', { value: 'true', selected: d.enableCdp !== false }, t('desktop', 'cdpEnabledOpt')),
    h('option', { value: 'false', selected: d.enableCdp === false }, t('desktop', 'cdpDisabledOpt'))
  ]);
  const cdpPortInput = textInput({ type: 'number', id: 'dtCdpPort', min: 1024, max: 65535, value: String(d.cdpPort || 9222) });
  const shotQualitySelect = selectInput({ id: 'dtShotQuality' }, [
    h('option', { value: 'high', selected: (d.screenshotQuality || 'high') === 'high' }, t('desktop', 'qualityHigh')),
    h('option', { value: 'medium', selected: d.screenshotQuality === 'medium' }, t('desktop', 'qualityMedium')),
    h('option', { value: 'low', selected: d.screenshotQuality === 'low' }, t('desktop', 'qualityLow'))
  ]);
  const shotDirInput = textInput({ id: 'dtShotDir', value: d.screenshotDir || '', placeholder: t('desktop', 'shotDirPlaceholder'), title: t('desktop', 'shotDirPlaceholder') });
  const sidebarTabSelect = selectInput({ id: 'dtSidebarTab' }, [
    h('option', { value: 'false', selected: !d.enableSidebarTab }, t('desktop', 'sidebarTabOff')),
    h('option', { value: 'true', selected: Boolean(d.enableSidebarTab) }, t('desktop', 'sidebarTabOn'))
  ]);

  const saveCfgBtn = button({
    variant: 'primary',
    iconName: 'check',
    label: t('desktop', 'saveConfigBtn'),
    onClick: async () => {
      let width = 1440;
      let height = 900;
      if (resSelect.value === 'custom') {
        width = parseInt(customWInput.value, 10) || 1440;
        height = parseInt(customHInput.value, 10) || 900;
      } else {
        const [pw, ph] = resSelect.value.split('x');
        width = parseInt(pw, 10) || 1440;
        height = parseInt(ph, 10) || 900;
      }

      const payload = {
        width,
        height,
        idleTimeoutMinutes: parseInt(idleSelect.value, 10) || 0,
        enableCdp: cdpSelect.value === 'true',
        cdpPort: parseInt(cdpPortInput.value, 10) || 9222,
        screenshotQuality: shotQualitySelect.value || 'high',
        screenshotDir: shotDirInput.value.trim(),
        enableSidebarTab: sidebarTabSelect.value === 'true'
      };

      saveCfgBtn.disabled = true;
      try {
        const r = await apiJson(`${ctx.adminPath}/api/desktop/config`, {
          method: 'POST',
          json: payload
        });
        if (!r.ok) {
          showToast(r.message, { type: 'error', errorCode: r.errorCode });
        } else {
          const changed = Object.keys(r.data?.changed || {});
          showToast(
            changed.length
              ? t('desktop', 'toastConfigSavedChanged', { fields: changed.join(', ') })
              : t('desktop', 'toastConfigSavedNoChange'),
            'success'
          );
          if (ctx.actions.markDesktopClean) ctx.actions.markDesktopClean();
          await ctx.actions.refreshStatus();
          ctx.actions.renderMain();
        }
      } finally {
        saveCfgBtn.disabled = false;
      }
    }
  });

  const runtimeSection = section({
    title: t('desktop', 'desktopCardTitle'),
    aside: vncLink,
    children: [
      settingRow({
        label: h('span', { className: 'row-title-state' }, t('dsh', 'statusLabel'), runtimeRowHost),
        desc: timerEl,
        control: actionGroup(startBtn, stopBtn, restartBtn),
        auto: true
      }),
      settingRow({
        label: t('desktop', 'keepAliveLabel'),
        htmlFor: 'dtKeepAlive',
        control: h('div', { className: 'field-inline' }, keepAliveInput, keepAliveBtn),
        wide: true,
        dataset: { desktopForm: '1' }
      })
    ]
  });

  const paramsSection = h(
    'div',
    { dataset: { desktopForm: '1' } },
    section({
      title: t('desktop', 'paramsTitle'),
      desc: richText(t('desktop', 'authorityHint')),
      children: [
        settingRow({ label: t('desktop', 'resolutionLabel'), htmlFor: 'dtResolution', control: resSelect }),
        customResRow,
        settingRow({ label: t('desktop', 'idleTimeoutLabel'), htmlFor: 'dtIdle', control: idleSelect }),
        settingRow({ label: t('desktop', 'cdpLabel'), htmlFor: 'dtCdp', control: cdpSelect }),
        settingRow({ label: t('desktop', 'cdpPortLabel'), htmlFor: 'dtCdpPort', control: cdpPortInput }),
        settingRow({ label: t('desktop', 'shotQualityLabel'), htmlFor: 'dtShotQuality', control: shotQualitySelect }),
        settingRow({ label: t('desktop', 'shotDirLabel'), htmlFor: 'dtShotDir', control: shotDirInput, wide: true }),
        settingRow({ label: t('desktop', 'sidebarTabLabel'), htmlFor: 'dtSidebarTab', control: sidebarTabSelect }),
        formFooter(saveCfgBtn)
      ]
    })
  );

  clear(container);
  container.append(
    pageHeader({ title: t('shell', 'navDesktop'), desc: t('desktop', 'desktopCardDesc') }),
    masterSection,
    runtimeSection,
    paramsSection
  );

  container[REFS] = {
    masterHost,
    runtimeHost: null,
    runtimeRowHost,
    timerEl,
    masterEnableBtn,
    masterDisableBtn,
    startBtn,
    stopBtn,
    restartBtn,
    keepAliveBtn,
    keepAliveInput,
    vncLink
  };
}
