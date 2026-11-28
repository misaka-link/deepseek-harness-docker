/**
 * Panel 1: DSH Core Service, Version Switching, Rollback Point, Version Store Cache, and Live Logs.
 */

import { h, icon, clear, richText } from '../lib/dom.js';
import { t, getLocaleTag } from '../lib/i18n.js';
import { apiJson } from '../lib/api.js';
import { openSseStream, consumeSseStream } from '../lib/sse.js';
import { compareSemver } from '../lib/semver.js';
import { formatBytes, formatDateTime, formatElapsed, formatTime } from '../lib/format.js';
import { createNotice, createStateDot, createTag, spinnerGlyph } from '../components/pill.js';
import { button, actions as actionGroup, pageHeader, section, settingRow, selectInput, switchInput, statStrip, metaLine, emptyState, formFooter } from '../components/ui.js';
import { askConfirm, openModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { openSwitchConfirmModal } from '../modals/switch-confirm.js';

const PRESET_REGISTRIES = [
  { url: 'https://registry.npmmirror.com', labelKey: 'registryMirror' },
  { url: 'https://registry.npmjs.org', labelKey: 'registryOfficial' }
];

function getEvalItem(ctx, version) {
  return (ctx.state.dshVersions && ctx.state.dshVersions.versionEvaluations && ctx.state.dshVersions.versionEvaluations[version]) || null;
}

function resolveProgressLabel(payload) {
  if (payload.labelKey) {
    const k = String(payload.labelKey).replace(/^dsh\./, '');
    const translated = t('dsh', k, payload.params || null);
    if (translated !== k) return translated;
  }
  return payload.label || t('common', 'loading');
}

function buildLogText(ctx) {
  const logsData = ctx.state.dshLogs;
  const status = ctx.state.status;
  const curVer = status?.dsh?.version || ctx.state.dshVersions?.current || '';
  const proxyPort = status?.paths?.proxyPort || 3080;

  if (ctx.state.switching || ctx.state.terminalLines.length > 0) {
    return ctx.state.terminalLines.join('\n');
  }

  if (!logsData) {
    return t('dsh', 'logConnecting');
  }

  const stateLabel = logsData.running
    ? (logsData.ready ? t('dsh', 'statusReady') : t('dsh', 'statusStarting'))
    : (logsData.manualStopped ? t('dsh', 'statusManualStopped') : t('dsh', 'statusStopped'));

  const lines = [
    `[${t('dsh', 'logEnvHeader')}]`,
    '----------------------------------------------------------------------',
    `${t('dsh', 'logCoreVer')} : ${curVer ? 'v' + curVer : t('common', 'unknown')} (${stateLabel})`,
    `${t('dsh', 'logPorts')} : ${proxyPort} (internal: 3079)`,
    `${t('dsh', 'logProcess')} : PID ${logsData.pid || '--'} | ${logsData.running ? 'Active' : 'Stopped'}`,
    '----------------------------------------------------------------------'
  ];

  if (logsData.exitInfo && !logsData.running) {
    lines.push(
      `[!] ${t('dsh', 'logExitedBanner', {
        code: logsData.exitInfo.code ?? '--',
        signal: logsData.exitInfo.sig || t('common', 'none'),
        time: formatTime(logsData.exitInfo.time, getLocaleTag())
      })}`,
      '----------------------------------------------------------------------'
    );
  }

  const recent = Array.isArray(logsData.recentLogs) ? logsData.recentLogs : [];
  if (recent.length > 0) {
    lines.push(...recent);
  } else {
    lines.push(t('dsh', 'logEmpty'));
  }
  return lines.join('\n');
}

async function recoverAfterStreamBreak(ctx, kind, targetVersion) {
  const opLabel = kind === 'rollback' ? t('dsh', 'opRollback') : t('dsh', 'opSwitch');
  ctx.actions.appendTerminalLine(`[!] ${t('dsh', 'sseInterruptedLog', { op: opLabel })}`);
  ctx.actions.setSwitchProgress({
    visible: true,
    step: 3,
    total: 5,
    percent: 60,
    label: t('dsh', 'sseRecoveringLabel'),
    mode: 'install'
  });
  showToast(t('dsh', 'sseInterruptedToast'), 'warn');

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await ctx.actions.refreshStatus();
      await ctx.actions.refreshDshVersions(false);
      await ctx.actions.refreshRollback();
      await ctx.actions.refreshVersionStore();
      const running = ctx.state.status?.dsh?.version;
      if (running && (!targetVersion || running === targetVersion)) {
        ctx.actions.setSwitchProgress({
          visible: true,
          step: 5,
          total: 5,
          percent: 100,
          label: t('dsh', 'sseRecoveredDone', { version: running }),
          mode: 'install'
        });
        ctx.actions.appendTerminalLine(`[OK] ${t('dsh', 'sseRecoveredDone', { version: running })}`);
        showToast(t('dsh', 'sseRecoveredDone', { version: running }), 'success');
        return;
      }
    } catch {}
  }
  ctx.actions.appendTerminalLine(`[i] ${t('dsh', 'sseRecoverTimeout')}`);
  showToast(t('dsh', 'sseRecoverTimeout'), 'warn');
}

async function runPreSwitchSnapshot(ctx, version) {
  ctx.actions.setSwitchProgress({
    visible: true,
    step: 1,
    total: 5,
    percent: 8,
    label: t('dsh', 'progressPreSnapshot'),
    mode: 'install'
  });

  const snapRes = await apiJson(`${ctx.adminPath}/api/snapshots/create`, {
    method: 'POST',
    json: { name: `pre-switch-to-${version}` },
    timeoutMs: 30000
  });

  if (snapRes.ok && snapRes.data?.snapshot) {
    ctx.actions.appendTerminalLine(`[OK] ${t('dsh', 'logPreSnapshotOk', { file: snapRes.data.snapshot.filename || '' })}`);
    await ctx.actions.refreshSnapshots();
    return;
  }

  if (snapRes.ok && (snapRes.status === 202 || snapRes.data?.job)) {
    const startedAt = Date.now();
    const initialTimeout = Number(snapRes.data?.job?.timeoutMs) || Number(ctx.state.snapshots?.snapshotTimeoutMs) || 30 * 60 * 1000;
    let deadlineMs = initialTimeout + 5 * 60 * 1000;

    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      if (Date.now() - startedAt > deadlineMs) {
        ctx.actions.appendTerminalLine(`[!] ${t('dsh', 'logPreSnapshotWarn', { error: t('snapshots', 'toastPollTimeout') })}`);
        await ctx.actions.refreshSnapshots();
        return;
      }

      const jr = await apiJson(`${ctx.adminPath}/api/snapshots/job`, { timeoutMs: 15000, skipAuthRedirect: true });
      if (jr.status === 401) {
        ctx.actions.appendTerminalLine(`[!] ${t('dsh', 'logPreSnapshotWarn', { error: t('errors', 'AUTH_REQUIRED') })}`);
        return;
      }
      if (!jr.ok) continue;

      const job = jr.data?.job;
      if (!job) {
        ctx.actions.appendTerminalLine(`[!] ${t('dsh', 'logPreSnapshotWarn', { error: t('snapshots', 'toastJobLost') })}`);
        await ctx.actions.refreshSnapshots();
        return;
      }

      if (Number(job.timeoutMs) > 0) {
        deadlineMs = Number(job.timeoutMs) + 5 * 60 * 1000;
      }

      if (job.status === 'running') {
        const bytes = formatBytes(job.progressBytes || 0, getLocaleTag());
        const elapsed = formatElapsed(job.elapsedMs ?? (Date.now() - startedAt));
        ctx.actions.setSwitchProgress({
          visible: true,
          step: 1,
          total: 5,
          percent: 10,
          label: t('snapshots', 'jobPackingTitle', { elapsed, size: bytes }),
          mode: 'install'
        });
      } else if (job.status === 'success') {
        ctx.actions.appendTerminalLine(`[OK] ${t('dsh', 'logPreSnapshotOk', { file: job.filename || '' })}`);
        await ctx.actions.refreshSnapshots();
        return;
      } else if (job.status === 'error') {
        ctx.actions.appendTerminalLine(`[!] ${t('dsh', 'logPreSnapshotWarn', { error: job.error || t('errors', 'UNKNOWN') })}`);
        await ctx.actions.refreshSnapshots();
        return;
      }
    }
  }

  ctx.actions.appendTerminalLine(`[!] ${t('dsh', 'logPreSnapshotWarn', { error: snapRes.message })}`);
}

async function runInstallStream(ctx, { version, archiveCurrent, wantSnapshot }) {
  ctx.actions.setSwitching(true);
  ctx.actions.clearTerminal();
  ctx.actions.setSwitchProgress({
    visible: true,
    step: 1,
    total: 5,
    percent: 5,
    label: t('dsh', 'progressPreparing'),
    mode: 'install'
  });
  ctx.actions.appendTerminalLine('======================================================================');
  ctx.actions.appendTerminalLine(`[${formatTime(Date.now(), getLocaleTag())}] ${t('dsh', 'logStartSwitch', { version })}`);

  let sse = null;
  try {
    if (wantSnapshot) {
      await runPreSwitchSnapshot(ctx, version);
    }

    sse = await openSseStream(`${ctx.adminPath}/api/dsh/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, archiveCurrent })
    });

    await consumeSseStream(sse, {
      onProgress: (p) => {
        ctx.actions.setSwitchProgress({
          visible: true,
          step: p.step || 1,
          total: p.total || 5,
          percent: p.percent ?? 0,
          label: resolveProgressLabel(p),
          mode: p.mode || 'install'
        });
      },
      onLog: (p) => {
        if (p.message) ctx.actions.appendTerminalLine(p.message);
      },
      onDone: async (p) => {
        if (p.ok) {
          ctx.actions.setSwitchProgress({
            visible: true,
            step: 5,
            total: 5,
            percent: 100,
            label: t('dsh', 'switchSuccessBanner', { version: p.version }),
            mode: 'install'
          });
          ctx.actions.appendTerminalLine(`[OK] ${t('dsh', 'switchSuccessBanner', { version: p.version })}`);
          showToast(t('dsh', 'switchSuccessBanner', { version: p.version }), 'success');
        } else if (p.rolledBack) {
          ctx.actions.setSwitchProgress({
            visible: true,
            step: 3,
            total: 3,
            percent: 100,
            label: t('dsh', 'switchRolledBackBanner', { version: p.version }),
            mode: 'rollback'
          });
          ctx.actions.appendTerminalLine(`[!] ${t('dsh', 'switchRolledBackBanner', { version: p.version })}`);
          showToast(t('dsh', 'switchRolledBackBanner', { version: p.version }), 'warn');
        } else {
          const msg = p.error || t('errors', 'DSH_INSTALL_FAILED', { step: 'install' });
          ctx.actions.setSwitchProgress({
            visible: true,
            step: 1,
            total: 5,
            percent: 0,
            label: t('dsh', 'switchFailedBanner', { error: msg }),
            mode: 'rollback'
          });
          ctx.actions.appendTerminalLine(`[ERR] ${msg}`);
          showToast(t('dsh', 'switchFailedBanner', { error: msg }), { type: 'error', errorCode: p.errorCode });
        }
        await Promise.all([
          ctx.actions.refreshStatus(),
          ctx.actions.refreshDshVersions(false),
          ctx.actions.refreshVersionStore(),
          ctx.actions.refreshRollback(),
          ctx.actions.refreshSnapshots()
        ]);
      }
    });
  } catch (err) {
    if (sse) {
      await recoverAfterStreamBreak(ctx, 'install', version);
    } else {
      ctx.actions.appendTerminalLine(`[ERR] ${err.message}`);
      ctx.actions.setSwitchProgress({
        visible: true,
        step: 1,
        total: 5,
        percent: 0,
        label: t('dsh', 'switchFailedBanner', { error: err.message }),
        mode: 'rollback'
      });
      showToast(err.message, { type: 'error', errorCode: err.errorCode });
    }
  } finally {
    if (sse) sse.close();
    await Promise.all([
      ctx.actions.refreshStatus(),
      ctx.actions.refreshDshVersions(false),
      ctx.actions.refreshVersionStore(),
      ctx.actions.refreshRollback()
    ]);
    setTimeout(() => {
      ctx.actions.setSwitching(false);
    }, 2500);
  }
}

async function runRollbackRestoreStream(ctx, rb) {
  ctx.actions.setSwitching(true);
  ctx.actions.clearTerminal();
  ctx.actions.setSwitchProgress({
    visible: true,
    step: 1,
    total: 5,
    percent: 10,
    label: t('dsh', 'progressRollbackPreparing'),
    mode: 'install'
  });
  ctx.actions.appendTerminalLine('======================================================================');
  ctx.actions.appendTerminalLine(`[${formatTime(Date.now(), getLocaleTag())}] ${t('dsh', 'logStartRollback', { version: rb.version || t('common', 'unknown') })}`);

  let sse = null;
  try {
    sse = await openSseStream(`${ctx.adminPath}/api/dsh/rollback/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    await consumeSseStream(sse, {
      onProgress: (p) => {
        ctx.actions.setSwitchProgress({
          visible: true,
          step: p.step || 1,
          total: p.total || 5,
          percent: p.percent ?? 0,
          label: resolveProgressLabel(p),
          mode: p.mode || 'install'
        });
      },
      onLog: (p) => {
        if (p.message) ctx.actions.appendTerminalLine(p.message);
      },
      onDone: async (p) => {
        if (p.ok) {
          ctx.actions.setSwitchProgress({
            visible: true,
            step: 5,
            total: 5,
            percent: 100,
            label: t('dsh', 'rollbackSuccessBanner', { version: p.version }),
            mode: 'install'
          });
          showToast(t('dsh', 'rollbackSuccessBanner', { version: p.version }), 'success');
        } else if (p.rolledBack) {
          ctx.actions.setSwitchProgress({
            visible: true,
            step: 3,
            total: 3,
            percent: 100,
            label: t('dsh', 'rollbackRevertedBanner', { version: p.version }),
            mode: 'rollback'
          });
          showToast(t('dsh', 'rollbackRevertedBanner', { version: p.version }), 'warn');
        } else {
          const msg = p.error || t('errors', 'UNKNOWN');
          ctx.actions.setSwitchProgress({
            visible: true,
            step: 1,
            total: 5,
            percent: 0,
            label: t('dsh', 'rollbackFailedBanner', { error: msg }),
            mode: 'rollback'
          });
          showToast(t('dsh', 'rollbackFailedBanner', { error: msg }), { type: 'error', errorCode: p.errorCode });
        }
        await Promise.all([
          ctx.actions.refreshStatus(),
          ctx.actions.refreshDshVersions(false),
          ctx.actions.refreshRollback()
        ]);
      }
    });
  } catch (err) {
    if (sse) {
      await recoverAfterStreamBreak(ctx, 'rollback', rb.version);
    } else {
      ctx.actions.appendTerminalLine(`[ERR] ${err.message}`);
      showToast(err.message, { type: 'error', errorCode: err.errorCode });
    }
  } finally {
    if (sse) sse.close();
    await Promise.all([
      ctx.actions.refreshStatus(),
      ctx.actions.refreshRollback()
    ]);
    setTimeout(() => {
      ctx.actions.setSwitching(false);
    }, 2500);
  }
}

function openAutoIsolatedModal(ctx) {
  const events = ctx.state.status?.autoIsolatedEvents || [];
  const listEl = events.length === 0
    ? emptyState(t('dsh', 'autoIsolatedEmpty'))
    : h(
      'div',
      { className: 'event-list' },
      events.map((ev) => h(
        'div',
        { className: 'event-item' },
        h('div', { className: 'event-head' },
          h('span', { className: 'event-title' }, ev.plugin),
          h('span', { className: 'event-time' }, formatDateTime(ev.time, getLocaleTag()))
        ),
        h('div', { className: 'event-reason' },
          `${t('dsh', 'autoIsolatedReason')}: ${ev.reason || t('common', 'unknown')}`
        ),
        h('pre', { className: 'log-box is-compact' }, ev.logSnippet || t('dsh', 'autoIsolatedNoSnippet'))
      ))
    );

  const clearBtn = h('button', {
    type: 'button',
    className: 'btn btn-danger-ghost',
    onClick: async () => {
      const r = await apiJson(`${ctx.adminPath}/api/dsh/auto-heal/clear`, { method: 'POST' });
      if (r.ok) {
        modal.close();
        showToast(t('dsh', 'autoIsolatedCleared'), 'success');
        await Promise.all([ctx.actions.refreshStatus(), ctx.actions.refreshPlugins()]);
      } else {
        showToast(r.message, { type: 'error', errorCode: r.errorCode });
      }
    }
  }, t('dsh', 'autoIsolatedClearBtn'));

  const closeBtn = h('button', {
    type: 'button',
    className: 'btn btn-primary',
    onClick: () => modal.close()
  }, t('common', 'close'));

  const modal = openModal({
    title: t('dsh', 'autoIsolatedModalTitle'),
    iconName: 'shield',
    iconTone: 'warn',
    wide: true,
    content: h('div', { className: 'modal-stack' },
      h('p', { className: 'modal-text' }, t('dsh', 'autoIsolatedModalDesc')),
      listEl
    ),
    footer: [clearBtn, closeBtn],
    footerBetween: true
  });
}

function runtimeDot(status) {
  const isRunning = Boolean(status?.dsh?.running);
  const isReady = Boolean(status?.dsh?.ready);
  if (!status) return { state: 'ongoing', text: t('common', 'loading') };
  if (isRunning && isReady) return { state: 'done', text: t('dsh', 'statusReady') };
  if (isRunning) return { state: 'ongoing', text: t('dsh', 'statusStarting') };
  if (status?.dsh?.manualStopped) return { state: 'idle', text: t('dsh', 'statusManualStopped') };
  if (status?.dsh?.lastExitInfo) return { state: 'error', text: t('dsh', 'statusCrashed') };
  return { state: 'idle', text: t('dsh', 'statusStopped') };
}

function liveLogState(liveLogsData) {
  if (!liveLogsData) return { state: 'idle', text: t('dsh', 'statusStopped') };
  if (liveLogsData.running) {
    return liveLogsData.ready
      ? { state: 'done', text: `${t('dsh', 'statusReady')} · PID ${liveLogsData.pid || '--'}` }
      : { state: 'ongoing', text: t('dsh', 'statusStarting') };
  }
  return { state: 'idle', text: t('dsh', 'statusStopped') };
}

export function renderDshPanel(container, ctx) {
  const { status, dshVersions, versionStore, rollbackPoint, snapshots, versionCheck, switching, switchProgress } = ctx.state;
  const curVer = status?.dsh?.version || dshVersions?.current || '';
  const latestVer = dshVersions?.latest || dshVersions?.distTags?.latest || versionCheck?.dsh?.latest || '';
  const adaptedList = Array.isArray(dshVersions?.adaptedVersions) ? dshVersions.adaptedVersions : [];
  const cachedList = Array.isArray(dshVersions?.cachedVersions) ? dshVersions.cachedVersions : [];
  const allVersions = Array.isArray(dshVersions?.versions) ? dshVersions.versions : [];
  const distTags = dshVersions?.distTags || {};

  const isRunning = Boolean(status?.dsh?.running);
  const isReady = Boolean(status?.dsh?.ready);
  const isManualStopped = Boolean(status?.dsh?.manualStopped);
  const isCurAdapted = curVer ? adaptedList.includes(curVer) : false;

  const selectedVersion = ctx.state.selectedVersion || (allVersions.includes(curVer) ? curVer : (allVersions[0] || ''));
  ctx.state.selectedVersion = selectedVersion;

  const selectedEval = getEvalItem(ctx, selectedVersion);
  const isSelectedDanger = Boolean(selectedEval && selectedEval.level === 'danger');
  const isSelectedUnsupported = isSelectedDanger && (selectedEval.kind === 'engine-unsupported' || selectedEval.action === 'blocked-legacy');
  const isSelectedAdapted = selectedVersion ? adaptedList.includes(selectedVersion) : false;
  const isSelectedCached = selectedVersion ? cachedList.includes(selectedVersion) : false;
  const isSelectedCurrent = Boolean(selectedVersion && selectedVersion === curVer);

  const realSnapshotCount = Array.isArray(snapshots?.snapshots) ? snapshots.snapshots.length : 0;
  const currentRegistry = status?.npmRegistry || dshVersions?.registry || PRESET_REGISTRIES[0].url;
  const isUpToDate = Boolean(curVer && latestVer && compareSemver(curVer, latestVer) >= 0);
  const rt = runtimeDot(status);

  // 0a. Suite container ENV vs image version mismatch banner (Issue #24)
  const projStatus = status?.project || {};
  const projCheck = versionCheck?.project || {};
  const hasVersionMismatch = Boolean(projCheck.versionMismatch || projStatus.versionMismatch);
  let versionMismatchBanner = null;
  if (hasVersionMismatch) {
    const isEnvConflict = Boolean(projCheck.envConflict || projStatus.envConflict);
    const envVer = projCheck.envVersion || projStatus.envVersion || '';
    const imageVer = projCheck.imageVersion || projStatus.imageVersion || projCheck.current || projStatus.version || '';
    versionMismatchBanner = createNotice({
      level: 'warn',
      title: t('version', 'envMismatchTitle'),
      body: isEnvConflict && envVer
        ? richText(t('version', 'envMismatchBody'), { envVersion: envVer, imageVersion: imageVer })
        : richText(t('version', 'sourceMismatchBody'), { version: imageVer }),
      actions: actionGroup(
        button({
          size: 'sm',
          label: t('shell', 'versionHub'),
          onClick: () => ctx.actions.openVersionHub()
        })
      )
    });
  }

  // 0b. Crash auto-isolation banner (genuine warning)
  const isolatedEvents = status?.autoIsolatedEvents || [];
  let autoIsolatedBanner = null;
  if (isolatedEvents.length > 0) {
    const latestEv = isolatedEvents[0];
    autoIsolatedBanner = createNotice({
      level: 'warn',
      title: t('dsh', 'autoIsolatedTitle'),
      body: richText(t('dsh', 'autoIsolatedBody'), {
        plugin: latestEv.plugin || '',
        reason: latestEv.reason || '',
        time: formatTime(latestEv.time, getLocaleTag())
      }),
      actions: actionGroup(
        button({ size: 'sm', label: t('dsh', 'autoIsolatedInspectBtn'), onClick: () => openAutoIsolatedModal(ctx) }),
        button({
          size: 'sm',
          variant: 'ghost',
          label: t('dsh', 'autoIsolatedDismissBtn'),
          onClick: async () => {
            const r = await apiJson(`${ctx.adminPath}/api/dsh/auto-heal/clear`, { method: 'POST' });
            if (r.ok) {
              await ctx.actions.refreshStatus();
            } else {
              showToast(r.message, { type: 'error', errorCode: r.errorCode });
            }
          }
        })
      )
    });
  }

  // 1. Overview stat strip
  const latestTagLabel = latestVer === distTags.alpha ? 'alpha'
    : latestVer === distTags.next ? 'next'
      : latestVer === distTags.latest ? 'latest'
        : 'npm';

  const overview = statStrip([
    {
      label: t('dsh', 'heroCurrentTitle'),
      aside: adaptedList.length > 0 && curVer
        ? createTag({ tone: isCurAdapted ? 'outline' : 'warning', text: isCurAdapted ? t('dsh', 'optAdapted') : t('dsh', 'optUnadapted') })
        : null,
      value: curVer && curVer !== 'unknown' ? `v${curVer}` : t('common', 'unknown'),
      meta: metaLine(
        createStateDot(rt),
        `${t('dsh', 'portLabel')} ${status?.paths?.proxyPort || 3080}`,
        `PID ${status?.dsh?.pid || '--'}`
      )
    },
    {
      label: t('dsh', 'heroLatestTitle'),
      aside: latestVer ? createTag({ tone: 'outline', text: latestTagLabel }) : null,
      value: latestVer ? `v${latestVer}` : t('common', 'unknown'),
      meta: metaLine(
        isUpToDate
          ? t('dsh', 'heroUpToDate')
          : (latestVer ? h('span', { className: 'text-strong' }, t('dsh', 'heroNewAvailable', { version: latestVer })) : null),
        !isUpToDate && latestVer && allVersions.includes(latestVer)
          ? h('button', {
            type: 'button',
            className: 'link-btn',
            onClick: () => {
              ctx.state.selectedVersion = latestVer;
              ctx.actions.renderMain();
            }
          }, t('dsh', 'quickSelectLatestBtn'))
          : null,
        h('a', {
          href: versionCheck?.dsh?.upstreamReleases || 'https://github.com/deepseek-ai/deepseek-harness/releases',
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'link-quiet'
        }, t('version', 'releaseNotes'), icon('external', 12))
      )
    },
    {
      label: t('dsh', 'heroSafetyTitle'),
      value: t('dsh', 'heroSnapshotsReady', { count: realSnapshotCount }),
      meta: metaLine(
        t('dsh', 'heroCachedEngines', { count: cachedList.length }),
        currentRegistry.includes('npmmirror') ? t('dsh', 'registryMirrorShort') : t('dsh', 'registryOfficialShort')
      )
    }
  ]);

  // 2. Service control
  const startBtn = button({
    size: 'sm',
    variant: isRunning ? 'outline' : 'primary',
    iconName: 'play',
    label: t('dsh', 'btnStart'),
    disabled: isRunning || switching,
    onClick: async () => {
      ctx.actions.appendTerminalLine(`>>> ${t('dsh', 'logStartingDsh')}`);
      const r = await apiJson(`${ctx.adminPath}/api/dsh/start`, { method: 'POST', timeoutMs: 60000 });
      if (r.ok) showToast(t('dsh', 'toastStartOk'), 'success');
      else showToast(r.message, { type: 'error', errorCode: r.errorCode });
      await ctx.actions.refreshStatus();
    }
  });
  const stopBtn = button({
    size: 'sm',
    variant: 'danger',
    iconName: 'square',
    label: t('dsh', 'btnStop'),
    disabled: !isRunning || switching,
    onClick: async () => {
      const ok = await askConfirm({
        title: t('dsh', 'confirmStopTitle'),
        iconName: 'alertTriangle',
        iconTone: 'warn',
        body: createNotice({ level: 'warn', title: t('dsh', 'confirmStopNoticeTitle'), body: richText(t('dsh', 'confirmStopNoticeBody')) }),
        confirmText: t('dsh', 'btnConfirmStop'),
        confirmKind: 'danger'
      });
      if (!ok) return;
      const r = await apiJson(`${ctx.adminPath}/api/dsh/stop`, { method: 'POST', timeoutMs: 30000 });
      if (r.ok) showToast(t('dsh', 'toastStopOk'), 'success');
      else showToast(r.message, { type: 'error', errorCode: r.errorCode });
      await ctx.actions.refreshStatus();
    }
  });
  const restartBtn = button({
    size: 'sm',
    iconName: 'refresh',
    label: t('dsh', 'btnRestart'),
    disabled: switching,
    onClick: async () => {
      const ok = await askConfirm({
        title: t('dsh', 'confirmRestartTitle'),
        iconName: 'refresh',
        iconTone: 'info',
        body: h('p', { className: 'modal-text' }, t('dsh', 'confirmRestartBody')),
        confirmText: t('dsh', 'btnConfirmRestart'),
        confirmKind: 'primary'
      });
      if (!ok) return;
      const r = await apiJson(`${ctx.adminPath}/api/dsh/restart`, { method: 'POST', timeoutMs: 60000 });
      if (r.ok) showToast(t('dsh', 'toastRestartOk'), 'success');
      else showToast(r.message, { type: 'error', errorCode: r.errorCode });
      await ctx.actions.refreshStatus();
    }
  });

  const detailText = isRunning
    ? (isReady ? t('dsh', 'detailReady') : t('dsh', 'detailStarting'))
    : (isManualStopped ? t('dsh', 'detailManualStopped') : t('dsh', 'detailStopped'));

  const serviceSection = section({
    title: t('dsh', 'sectionService'),
    children: [
      settingRow({
        label: h('span', { className: 'row-title-state' }, t('dsh', 'statusLabel'), createStateDot(rt)),
        desc: detailText,
        control: actionGroup(startBtn, stopBtn, restartBtn),
        auto: true
      })
    ]
  });

  // 3. Registry + target version
  const registrySelect = selectInput(
    {
      disabled: switching,
      'aria-label': t('dsh', 'registryLabel'),
      onChange: async (e) => {
        const reg = e.currentTarget.value;
        const r = await apiJson(`${ctx.adminPath}/api/dsh/registry`, {
          method: 'POST',
          json: { registry: reg }
        });
        if (r.ok) {
          showToast(t('dsh', 'toastRegistrySaved', { registry: reg }), 'success');
          await Promise.all([ctx.actions.refreshStatus(), ctx.actions.refreshDshVersions(true)]);
        } else {
          showToast(r.message, { type: 'error', errorCode: r.errorCode });
          await ctx.actions.refreshStatus();
        }
      }
    },
    [
      ...PRESET_REGISTRIES.map((p) => h('option', { value: p.url, selected: currentRegistry === p.url }, `${t('dsh', p.labelKey)} (${p.url.replace(/^https?:\/\//, '')})`)),
      !PRESET_REGISTRIES.some((p) => p.url === currentRegistry) && currentRegistry
        ? h('option', { value: currentRegistry, selected: true }, currentRegistry)
        : null
    ]
  );

  const versionSelect = selectInput(
    {
      disabled: switching || allVersions.length === 0,
      'aria-label': t('dsh', 'targetVersionLabel'),
      onChange: (e) => {
        ctx.state.selectedVersion = e.currentTarget.value;
        ctx.actions.renderMain();
      }
    },
    allVersions.length === 0
      ? [h('option', { value: '' }, t('dsh', 'loadingVersions'))]
      : allVersions.map((v) => {
        const matchedTags = Object.entries(distTags).filter(([, tv]) => tv === v).map(([tk]) => tk);
        const ev = getEvalItem(ctx, v);
        const parts = [v];
        if (matchedTags.length) parts.push(`(${matchedTags.join(', ')})`);
        if (ev?.level === 'danger') {
          parts.push(`[${t('dsh', 'optIncompatible')}]`);
        } else if (adaptedList.includes(v)) {
          parts.push(`[${t('dsh', 'optAdapted')}]`);
        } else {
          parts.push(`[${t('dsh', 'optUnadapted')}]`);
        }
        if (cachedList.includes(v)) parts.push(`[${t('dsh', 'optCached')}]`);
        if (v === curVer) parts.push(`★ ${t('dsh', 'optCurrent')}`);
        return h('option', { value: v, selected: v === selectedVersion }, parts.join(' '));
      })
  );

  let selectionNotice = null;
  if (selectedVersion) {
    if (isSelectedUnsupported) {
      selectionNotice = createNotice({
        level: 'danger',
        title: t('dsh', 'evalUnsupportedTitle'),
        body: richText(t('dsh', 'evalUnsupportedInline'), {
          version: selectedVersion,
          floor: selectedEval?.params?.floor || ''
        })
      });
    } else if (isSelectedDanger) {
      selectionNotice = createNotice({
        level: 'danger',
        title: t('dsh', 'evalBreakingTitle'),
        body: richText(t('dsh', 'evalBreakingInline'), { version: selectedVersion })
      });
    } else if (!isSelectedCurrent && !isSelectedAdapted) {
      selectionNotice = createNotice({
        level: 'warn',
        title: t('dsh', 'evalUnadaptedTitle'),
        body: richText(t('dsh', 'evalUnadaptedInline'), { version: selectedVersion })
      });
    }
  }

  let quickHint = null;
  if (selectedVersion) {
    let text = '';
    let tone = '';
    if (isSelectedDanger) {
      text = isSelectedUnsupported ? t('dsh', 'hintUnsupportedBlocked') : t('dsh', 'hintBreakingBlocked');
      tone = 'danger';
    } else if (isSelectedCurrent) {
      text = t('dsh', 'hintCurrent');
    } else if (isSelectedAdapted) {
      text = isSelectedCached ? t('dsh', 'hintAdaptedCached') : t('dsh', 'hintAdaptedOnline');
    } else if (isSelectedCached) {
      text = t('dsh', 'hintCachedInstant');
    } else {
      text = t('dsh', 'hintNpmDownload');
    }
    quickHint = h('span', { className: tone ? `text-${tone}` : undefined }, text);
  }

  // Progress pipeline widget
  const stepNames = [
    t('dsh', 'stepPrecheck'),
    t('dsh', 'stepSnapshot'),
    t('dsh', 'stepDeploy'),
    t('dsh', 'stepPluginHeal'),
    t('dsh', 'stepHealthProbe')
  ];
  const pct = Math.min(100, Math.max(0, switchProgress?.percent || 0));
  const isRbMode = switchProgress?.mode === 'rollback';
  const progressPanel = switchProgress?.visible
    ? h(
      'div',
      { className: 'progress', dataset: { mode: isRbMode ? 'rollback' : 'install' } },
      h('div', { className: 'progress-head' },
        h('div', { className: 'progress-label' },
          pct < 100 && !isRbMode ? spinnerGlyph(14) : icon(isRbMode ? 'alertTriangle' : 'checkCircle', 14),
          h('span', null, switchProgress.label)
        ),
        h('span', { className: 'progress-pct' }, `${Math.round(pct)}%`)
      ),
      h('div', { className: 'progress-track' },
        h('div', { className: 'progress-fill', style: { width: `${pct}%` } })
      ),
      h(
        'ol',
        { className: 'steps' },
        stepNames.map((label, idx) => {
          const stepNo = idx + 1;
          const st = isRbMode
            ? 'rollback'
            : stepNo < switchProgress.step || (pct >= 100 && stepNo <= switchProgress.step)
              ? 'done'
              : stepNo === switchProgress.step
                ? 'active'
                : 'pending';
          return h(
            'li',
            { className: 'step', dataset: { state: st } },
            h('span', { className: 'step-dot' }, st === 'done' ? icon('check', 10) : String(stepNo)),
            h('span', { className: 'step-label' }, label)
          );
        })
      )
    )
    : null;

  const installBtn = button({
    variant: 'primary',
    label: isSelectedDanger ? t('dsh', 'switchBlockedBtn') : t('dsh', 'installSwitchBtn'),
    disabled: switching || !selectedVersion || isSelectedDanger,
    title: isSelectedDanger ? t('dsh', 'switchBlockedTooltip') : '',
    onClick: () => {
      openSwitchConfirmModal({
        targetVersion: selectedVersion,
        currentVersion: curVer,
        evalItem: selectedEval,
        isCached: isSelectedCached,
        isAdapted: isSelectedAdapted,
        alreadyArchivedCurrent: cachedList.includes(curVer),
        rollbackPoint,
        upstreamReleases: versionCheck?.dsh?.upstreamReleases,
        estimatedBytes: dshVersions?.estimatedBytes,
        onGoSnapshots: () => ctx.actions.switchTab('snapshots'),
        onConfirm: (opts) => runInstallStream(ctx, opts)
      });
    }
  });

  const refreshVersionsBtn = button({
    iconName: 'refresh',
    label: t('dsh', 'refreshVersionsBtn'),
    disabled: switching,
    onClick: async () => {
      await ctx.actions.refreshDshVersions(true);
      showToast(t('dsh', 'toastVersionsRefreshed'), 'info');
    }
  });

  const versionSection = section({
    title: t('dsh', 'sectionVersion'),
    children: [
      settingRow({ label: t('dsh', 'registryLabel'), control: registrySelect, wide: true }),
      settingRow({ label: t('dsh', 'targetVersionLabel'), desc: quickHint, control: versionSelect, wide: true }),
      selectionNotice,
      formFooter(installBtn, refreshVersionsBtn),
      progressPanel
    ]
  });

  // 4. In-place rollback point
  const rb = rollbackPoint;
  const rbEval = rb?.version ? getEvalItem(ctx, rb.version) : null;
  const rbBlockedByFloor = Boolean(rbEval && rbEval.level === 'danger');
  const rbCanRestore = Boolean(rb?.exists && rb.canRestore && !rbBlockedByFloor && !switching);

  let rollbackBody;
  if (!rb) {
    rollbackBody = emptyState(t('common', 'loading'));
  } else if (!rb.exists) {
    rollbackBody = h('div', { className: 'empty-block' },
      h('div', { className: 'empty-block-title' }, t('dsh', 'rollbackEmptyTitle')),
      h('div', { className: 'empty-block-desc' }, t('dsh', 'rollbackEmptyBody'))
    );
  } else {
    rollbackBody = settingRow({
      label: h('span', { className: 'row-title-state' },
        h('span', { className: 'mono' }, `v${rb.version || t('common', 'unknown')}`),
        createTag({ tone: 'neutral', text: t('dsh', 'rollbackSpareTag') }),
        !rb.abiMatches ? createTag({ tone: 'warning', text: t('dsh', 'abiMismatched') }) : null,
        rbBlockedByFloor ? createTag({ tone: 'danger', text: t('version', 'badgeIncompatible') }) : null
      ),
      desc: metaLine(
        rb.sizeFormatted || formatBytes(rb.sizeBytes, getLocaleTag()),
        t('dsh', 'createdAt', { time: formatDateTime(rb.createdAt, getLocaleTag()) }),
        rb.abiMatches ? t('dsh', 'abiMatched') : null
      ),
      auto: true,
      control: actionGroup(
        button({
          size: 'sm',
          iconName: 'history',
          label: t('dsh', 'btnRestoreRollback'),
          disabled: !rbCanRestore,
          onClick: async () => {
            const ok = await askConfirm({
              title: t('dsh', 'confirmRollbackRestoreTitle'),
              iconName: 'history',
              iconTone: 'warn',
              body: createNotice({
                level: 'warn',
                title: t('dsh', 'confirmRollbackRestoreHead', { version: rb.version || t('common', 'unknown') }),
                body: richText(t('dsh', 'confirmRollbackRestoreBody'))
              }),
              confirmText: t('dsh', 'btnRestoreRollback'),
              confirmKind: 'primary'
            });
            if (!ok) return;
            runRollbackRestoreStream(ctx, rb);
          }
        }),
        button({
          size: 'sm',
          variant: 'danger',
          iconName: 'trash',
          label: t('dsh', 'btnDeleteRollback'),
          disabled: switching,
          onClick: async () => {
            const ok = await askConfirm({
              title: t('dsh', 'confirmRollbackDeleteTitle'),
              iconName: 'trash',
              iconTone: 'danger',
              destructive: true,
              body: createNotice({
                level: 'danger',
                title: t('dsh', 'confirmRollbackDeleteHead'),
                body: richText(t('dsh', 'confirmRollbackDeleteBody'), { size: rb.sizeFormatted || '' })
              }),
              confirmText: t('dsh', 'btnDeleteRollback'),
              confirmKind: 'danger'
            });
            if (!ok) return;
            const r = await apiJson(`${ctx.adminPath}/api/dsh/rollback`, { method: 'DELETE' });
            if (r.ok) {
              const freed = r.data?.freedBytes ? formatBytes(r.data.freedBytes, getLocaleTag()) : (rb.sizeFormatted || '');
              showToast(t('dsh', 'toastRollbackDeleted', { size: freed }), 'success');
              await ctx.actions.refreshRollback();
            } else {
              showToast(r.message, { type: 'error', errorCode: r.errorCode });
            }
          }
        })
      )
    });
  }

  const rollbackSection = section({
    title: t('dsh', 'rollbackCardTitle'),
    desc: richText(t('dsh', 'rollbackCardDesc')),
    aside: createTag({ tone: 'outline', text: t('dsh', 'rollbackSlotBadge') }),
    children: [rollbackBody]
  });

  // 5. Persistent version store
  const storeEntries = Array.isArray(versionStore?.versions) ? versionStore.versions : [];
  const gcBtn = button({
    size: 'sm',
    iconName: 'trash',
    label: t('dsh', 'btnRunGc'),
    disabled: switching || storeEntries.length === 0,
    onClick: async () => {
      const dry = await apiJson(`${ctx.adminPath}/api/dsh/versions/gc`, {
        method: 'POST',
        json: { dryRun: true }
      });
      if (!dry.ok) {
        showToast(dry.message, { type: 'error', errorCode: dry.errorCode });
        return;
      }
      const rem = dry.data?.removed || [];
      if (rem.length === 0) {
        showToast(t('dsh', 'toastGcNothing'), 'info');
        return;
      }
      const ok = await askConfirm({
        title: t('dsh', 'confirmGcTitle'),
        iconName: 'trash',
        iconTone: 'warn',
        body: createNotice({
          level: 'warn',
          body: richText(t('dsh', 'confirmGcBody'), {
            count: rem.length,
            size: formatBytes(dry.data?.freedBytes || 0, getLocaleTag())
          })
        }),
        confirmText: t('dsh', 'btnRunGc'),
        confirmKind: 'danger'
      });
      if (!ok) return;
      const res = await apiJson(`${ctx.adminPath}/api/dsh/versions/gc`, { method: 'POST', json: { dryRun: false } });
      if (res.ok) {
        showToast(t('dsh', 'toastGcDone', {
          count: (res.data?.removed || []).length,
          size: formatBytes(res.data?.freedBytes || 0, getLocaleTag())
        }), 'success');
        await Promise.all([ctx.actions.refreshVersionStore(), ctx.actions.refreshDshVersions(false)]);
      } else {
        showToast(res.message, { type: 'error', errorCode: res.errorCode });
      }
    }
  });

  const storeMeta = versionStore
    ? h('div', { className: 'section-meta' }, metaLine(
      createStateDot({
        state: versionStore.persisted ? 'done' : 'warning',
        text: versionStore.persisted ? t('dsh', 'storePersisted') : t('dsh', 'storeEphemeral')
      }),
      `${t('dsh', 'storeUsed')} ${formatBytes(versionStore.totalSizeBytes || 0, getLocaleTag())}`,
      versionStore.freeBytes != null ? `${t('dsh', 'storeFree')} ${formatBytes(versionStore.freeBytes, getLocaleTag())}` : null
    ))
    : null;

  const storeList = storeEntries.length === 0
    ? emptyState(t('dsh', 'storeEmpty'))
    : h(
      'div',
      { className: 'list surface' },
      storeEntries.map((item) => {
        const itemEval = getEvalItem(ctx, item.version);
        const itemUnsupported = Boolean(itemEval && itemEval.level === 'danger');
        const canSwitchItem = !item.active && !itemUnsupported && item.ready && !switching;
        const canDeleteItem = !item.active && !item.pinned && !switching;

        return h(
          'div',
          { className: 'list-row' },
          h('div', { className: 'list-main' },
            h('div', { className: 'list-title' },
              h('span', { className: 'mono' }, `v${item.version}`),
              item.active ? createStateDot({ state: 'done', text: t('dsh', 'storeTagActive') }) : null,
              item.pinned ? createTag({ tone: 'outline', text: t('dsh', 'storeTagPinned') }) : null,
              itemUnsupported ? createTag({ tone: 'danger', text: t('version', 'badgeIncompatible') }) : null,
              !item.ready ? createTag({ tone: 'warning', text: t('dsh', 'storeTagUnready') }) : null
            ),
            h('div', { className: 'list-meta' },
              metaLine(formatBytes(item.sizeBytes || 0, getLocaleTag()), formatDateTime(item.lastUsedAt, getLocaleTag()))
            )
          ),
          h('div', { className: 'list-actions' },
            canSwitchItem
              ? button({
                size: 'sm',
                label: t('dsh', 'storeSwitchBtn'),
                onClick: () => {
                  ctx.state.selectedVersion = item.version;
                  openSwitchConfirmModal({
                    targetVersion: item.version,
                    currentVersion: curVer,
                    evalItem: itemEval,
                    isCached: true,
                    isAdapted: adaptedList.includes(item.version),
                    alreadyArchivedCurrent: cachedList.includes(curVer),
                    rollbackPoint,
                    upstreamReleases: versionCheck?.dsh?.upstreamReleases,
                    onGoSnapshots: () => ctx.actions.switchTab('snapshots'),
                    onConfirm: (opts) => runInstallStream(ctx, opts)
                  });
                }
              })
              : null,
            button({
              size: 'sm',
              variant: 'ghost',
              iconName: 'trash',
              iconOnly: true,
              className: 'is-danger-icon',
              disabled: !canDeleteItem,
              title: item.active ? t('dsh', 'storeDeleteActiveHint') : item.pinned ? t('dsh', 'storeDeletePinnedHint') : t('common', 'delete'),
              onClick: async () => {
                const ok = await askConfirm({
                  title: t('dsh', 'confirmDeleteCacheTitle'),
                  iconName: 'trash',
                  iconTone: 'danger',
                  destructive: true,
                  body: createNotice({
                    level: 'danger',
                    body: richText(t('dsh', 'confirmDeleteCacheBody'), {
                      version: item.version,
                      size: formatBytes(item.sizeBytes || 0, getLocaleTag())
                    })
                  }),
                  confirmText: t('common', 'delete'),
                  confirmKind: 'danger'
                });
                if (!ok) return;
                const r = await apiJson(`${ctx.adminPath}/api/dsh/versions/${encodeURIComponent(item.version)}`, { method: 'DELETE' });
                if (r.ok) {
                  showToast(t('dsh', 'toastCacheDeleted', { version: item.version }), 'success');
                  await Promise.all([ctx.actions.refreshVersionStore(), ctx.actions.refreshDshVersions(false)]);
                } else {
                  showToast(r.message, { type: 'error', errorCode: r.errorCode });
                }
              }
            })
          )
        );
      })
    );

  const storeSection = section({
    title: t('dsh', 'storeCardTitle'),
    desc: t('dsh', 'storeCardDesc'),
    aside: gcBtn,
    children: [storeMeta, storeList]
  });

  // 6. Live logs
  const autoScrollInput = switchInput({
    checked: ctx.state.autoScroll,
    ariaLabel: t('dsh', 'autoScrollLabel'),
    onChange: (e) => {
      ctx.actions.setAutoScroll(e.currentTarget.checked);
      if (e.currentTarget.checked) {
        termEl.scrollTop = termEl.scrollHeight;
      }
    }
  });

  const termEl = h('pre', { id: 'dshLiveTerminal', className: 'log-box' }, buildLogText(ctx));
  const liveBadgeHost = h('span', { id: 'dshLiveBadgeHost' }, createStateDot(liveLogState(ctx.state.dshLogs)));

  const logsSection = section({
    title: h('span', { className: 'row-title-state' }, t('dsh', 'logsCardTitle'), liveBadgeHost),
    aside: actionGroup(
      h('label', { className: 'inline-switch' }, autoScrollInput, h('span', null, t('dsh', 'autoScrollLabel'))),
      button({ size: 'sm', iconName: 'refresh', label: t('dsh', 'refreshLogsBtn'), onClick: () => ctx.actions.refreshLogs(true) }),
      button({
        size: 'sm',
        variant: 'ghost',
        label: t('dsh', 'clearLogsBtn'),
        onClick: () => {
          ctx.actions.clearTerminal();
          termEl.textContent = t('dsh', 'logCleared');
        }
      })
    ),
    children: [termEl]
  });

  clear(container);
  container.append(
    pageHeader({ title: t('dsh', 'coreCardTitle'), desc: t('dsh', 'coreCardDesc') }),
    ...(versionMismatchBanner ? [h('div', { className: 'page-banner' }, versionMismatchBanner)] : []),
    ...(autoIsolatedBanner ? [h('div', { className: 'page-banner' }, autoIsolatedBanner)] : []),
    overview,
    serviceSection,
    versionSection,
    rollbackSection,
    storeSection,
    logsSection
  );

  if (ctx.state.autoScroll) {
    termEl.scrollTop = termEl.scrollHeight;
  }
}

/**
 * Lightweight live log patch (called every 3s without touching interactive controls).
 */
export function patchDshLogs(container, ctx) {
  const termEl = container.querySelector('#dshLiveTerminal');
  if (termEl) {
    const nextText = buildLogText(ctx);
    if (termEl.textContent !== nextText) {
      termEl.textContent = nextText;
      if (ctx.state.autoScroll) {
        termEl.scrollTop = termEl.scrollHeight;
      }
    }
  }
  const badgeHost = container.querySelector('#dshLiveBadgeHost');
  if (badgeHost && ctx.state.dshLogs) {
    clear(badgeHost);
    badgeHost.appendChild(createStateDot(liveLogState(ctx.state.dshLogs)));
  }
}
