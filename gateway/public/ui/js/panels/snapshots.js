/**
 * Panel 4: Configuration Snapshots & Backups.
 * Supports async backup job polling, 409 BUSY handling, full/config-only creation,
 * .tar.gz upload import, inspection details, dual environment version labels, and dual-mode restore.
 */

import { h, clear, richText } from '../lib/dom.js';
import { t, getLocaleTag } from '../lib/i18n.js';
import { apiJson } from '../lib/api.js';
import { formatBytes, formatDateTime, formatElapsed, suiteVerText } from '../lib/format.js';
import { createNotice, createStateDot, createTag, spinnerGlyph } from '../components/pill.js';
import { openModal, askConfirm } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { button, actions as actionGroup, pageHeader, textInput, kvList, metaLine, emptyState, optionCard } from '../components/ui.js';
import { openRestoreModeModal } from '../modals/restore-mode.js';

function openCreateSnapshotModal(ctx) {
  let snapType = 'full';
  const noteInput = textInput({ id: 'snapNote', placeholder: t('snapshots', 'createNotePlaceholder') });

  const radioFull = h('input', {
    type: 'radio',
    className: 'radio',
    name: 'newSnapType',
    value: 'full',
    checked: true,
    onChange: () => {
      snapType = 'full';
      syncCards();
    }
  });
  const radioConfig = h('input', {
    type: 'radio',
    className: 'radio',
    name: 'newSnapType',
    value: 'config',
    onChange: () => {
      snapType = 'config';
      syncCards();
    }
  });

  const cardFull = optionCard({
    input: radioFull,
    title: t('snapshots', 'createTypeFullTitle'),
    desc: richText(t('snapshots', 'createTypeFullDesc'))
  });
  const cardConfig = optionCard({
    input: radioConfig,
    title: t('snapshots', 'createTypeConfigTitle'),
    tag: createTag({ tone: 'outline', text: t('snapshots', 'lightweightTag') }),
    desc: richText(t('snapshots', 'createTypeConfigDesc'))
  });

  function syncCards() {
    cardFull.classList.toggle('is-selected', snapType === 'full');
    cardConfig.classList.toggle('is-selected', snapType === 'config');
  }
  syncCards();

  const cancelBtn = h('button', { type: 'button', className: 'btn', onClick: () => modal.close() }, t('common', 'cancel'));
  const submitBtn = h('button', {
    type: 'button',
    className: 'btn btn-primary',
    onClick: async () => {
      const name = noteInput.value.trim();
      const type = snapType;
      modal.close();

      const r = await apiJson(`${ctx.adminPath}/api/snapshots/create`, {
        method: 'POST',
        json: { name, type }
      });

      if (r.status === 202 && r.ok && r.data?.job) {
        ctx.actions.startSnapshotPolling(r.data.job);
        showToast(t('snapshots', 'toastPackingStarted'), 'info');
      } else if (r.ok && r.data?.snapshot) {
        showToast(t('snapshots', 'toastCreated', { file: r.data.snapshot.filename }), 'success');
        await ctx.actions.refreshSnapshots();
      } else if (r.status === 409 || r.data?.code === 'BUSY' || r.errorCode === 'SNAPSHOT_BUSY') {
        showToast(r.message || t('errors', 'SNAPSHOT_BUSY'), 'warn');
        await ctx.actions.refreshSnapshots();
      } else {
        showToast(r.message, { type: 'error', errorCode: r.errorCode });
        await ctx.actions.refreshSnapshots();
      }
    }
  }, t('snapshots', 'startCreateBtn'));

  const modal = openModal({
    title: t('snapshots', 'createModalTitle'),
    content: h(
      'div',
      { className: 'modal-stack' },
      h('div', { className: 'field' },
        h('label', { className: 'field-label', for: 'snapNote' }, t('snapshots', 'createNoteLabel')),
        noteInput
      ),
      h('div', { className: 'field' },
        h('div', { className: 'field-label' }, t('snapshots', 'createScopeLabel')),
        h('div', { className: 'option-cards' }, cardFull, cardConfig)
      )
    ),
    footer: [cancelBtn, submitBtn]
  });
}

async function openInspectModal(ctx, snap) {
  const r = await apiJson(`${ctx.adminPath}/api/snapshots/inspect?file=${encodeURIComponent(snap.filename)}`, {
    timeoutMs: 12000
  });
  if (!r.ok) {
    showToast(r.message, { type: 'error', errorCode: r.errorCode });
    return;
  }
  const info = r.data || {};
  const isLegacySchema1 = Boolean(
    info.schemaVersion === 1 ||
    info.legacySettingsWarning ||
    info.configModel === 'settings.yaml' ||
    snap.configModel === 'settings.yaml'
  );

  const kv = kvList([
    [t('snapshots', 'colFile'), h('code', null, snap.filename)],
    [t('snapshots', 'colSize'), snap.sizeFormatted || formatBytes(snap.sizeBytes, getLocaleTag())],
    [t('snapshots', 'colCreatedAt'), formatDateTime(snap.createdAt, getLocaleTag())],
    [t('snapshots', 'inspectHasSessions'), createStateDot({ state: info.hasSessions ? 'done' : 'idle', text: info.hasSessions ? t('common', 'yes') : t('common', 'no') })],
    [t('snapshots', 'inspectHasAttachments'), createStateDot({ state: info.hasAttachments ? 'done' : 'idle', text: info.hasAttachments ? t('common', 'yes') : t('common', 'no') })],
    [t('snapshots', 'inspectConfigModel'), h('code', null, info.configModel || snap.configModel || (info.schemaVersion ? `Schema ${info.schemaVersion}` : t('common', 'unknown')))],
    [t('snapshots', 'restoreLiveSessions'), info.current && typeof info.current.sessionCount === 'number' ? t('snapshots', 'liveSessionCount', { count: info.current.sessionCount }) : t('common', 'unknown')]
  ]);

  const closeBtn = h('button', { type: 'button', className: 'btn btn-primary', onClick: () => modal.close() }, t('common', 'close'));
  const modal = openModal({
    title: t('snapshots', 'inspectModalTitle'),
    content: h(
      'div',
      { className: 'modal-stack' },
      kv,
      isLegacySchema1
        ? createNotice({ level: 'warn', title: t('snapshots', 'legacySchemaTitle'), body: richText(t('snapshots', 'legacySchemaBody')) })
        : null
    ),
    footer: [closeBtn]
  });
}

async function recoverAfterRestoreDisconnect(ctx) {
  showToast(t('dsh', 'sseInterruptedToast'), 'warn');
  const deadline = Date.now() + 15 * 60 * 1000;
  let sawRestoreActive = false;
  let idleReadyStreak = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const [snapRes, hzRes] = await Promise.all([
      apiJson(`${ctx.adminPath}/api/snapshots`, { timeoutMs: 10000, skipAuthRedirect: true }),
      apiJson('/healthz', { timeoutMs: 10000, skipAuthRedirect: true })
    ]);
    if (snapRes.status === 401) {
      return { recovered: false, authLost: true };
    }
    const activeTask = snapRes.ok ? snapRes.data?.activeTask : undefined;
    const dshReady = Boolean(hzRes.ok && hzRes.data?.dsh?.ready);

    if (activeTask && activeTask.type === 'restore') {
      sawRestoreActive = true;
      idleReadyStreak = 0;
      continue;
    }

    if (snapRes.ok && !activeTask && dshReady) {
      idleReadyStreak += 1;
      if (sawRestoreActive || idleReadyStreak >= 2) {
        return { recovered: true };
      }
    } else {
      idleReadyStreak = 0;
    }
  }
  return { recovered: false };
}

async function handleRestoreClick(ctx, snap) {
  let inspectData = null;
  const r = await apiJson(`${ctx.adminPath}/api/snapshots/inspect?file=${encodeURIComponent(snap.filename)}`, {
    timeoutMs: 10000
  });
  if (r.ok) inspectData = r.data;

  openRestoreModeModal({
    filename: snap.filename,
    inspectData,
    snapshotMeta: snap,
    onConfirm: async ({ filename, mode }) => {
      ctx.state.localSnapshotTask = mode === 'config-only' ? t('snapshots', 'taskRestoringConfig') : t('snapshots', 'taskRestoringFull');
      ctx.actions.renderMain();
      const restoreTimeoutMs = Math.max(600000, Number(ctx.state.snapshots?.snapshotTimeoutMs) || 1800000);
      try {
        const res = await apiJson(`${ctx.adminPath}/api/snapshots/restore`, {
          method: 'POST',
          json: { filename, mode },
          timeoutMs: restoreTimeoutMs
        });
        if (res.ok) {
          const fixed = Number(res.data?.repairedLinks) || 0;
          const respMode = res.data?.mode || mode;
          const msgKey = respMode === 'config-only'
            ? (fixed > 0 ? 'toastRestoredConfigFixed' : 'toastRestoredConfig')
            : (fixed > 0 ? 'toastRestoredFullFixed' : 'toastRestoredFull');
          showToast(t('snapshots', msgKey, { count: fixed }), 'success');
          await ctx.actions.refreshStatus();
        } else if (res.status === 0 || res.status === 502 || res.status === 504) {
          const rec = await recoverAfterRestoreDisconnect(ctx);
          if (rec.recovered) {
            const msgKey = mode === 'config-only' ? 'toastRestoredConfig' : 'toastRestoredFull';
            showToast(t('snapshots', msgKey), 'success');
            await ctx.actions.refreshStatus();
          } else if (rec.authLost) {
            showToast(t('errors', 'AUTH_REQUIRED'), 'warn');
          } else {
            showToast(res.message || t('snapshots', 'toastPollTimeout'), { type: 'error', errorCode: res.errorCode });
          }
        } else {
          showToast(res.message, { type: 'error', errorCode: res.errorCode });
        }
      } finally {
        ctx.state.localSnapshotTask = '';
        await ctx.actions.refreshSnapshots();
      }
    }
  });
}

async function handleDeleteSnapshot(ctx, snap) {
  const ok = await askConfirm({
    title: t('snapshots', 'confirmDeleteTitle'),
    iconName: 'trash',
    iconTone: 'danger',
    destructive: true,
    confirmText: t('common', 'delete'),
    confirmKind: 'danger',
    body: createNotice({
      level: 'danger',
      title: t('snapshots', 'confirmDeleteWarnTitle'),
      body: richText(t('snapshots', 'confirmDeleteWarnBody'), { file: snap.filename })
    })
  });
  if (!ok) return;

  const r = await apiJson(`${ctx.adminPath}/api/snapshots/delete`, {
    method: 'POST',
    json: { filename: snap.filename }
  });
  if (r.ok) {
    showToast(t('snapshots', 'toastDeleted'), 'success');
  } else {
    showToast(r.message, { type: 'error', errorCode: r.errorCode });
  }
  await ctx.actions.refreshSnapshots();
}

export function renderSnapshotsPanel(container, ctx) {
  const snapData = ctx.state.snapshots;
  const list = Array.isArray(snapData?.snapshots) ? snapData.snapshots : [];
  const job = ctx.state.snapshotJob || (snapData?.job?.status === 'running' ? snapData.job : null);
  const activeTask = snapData?.activeTask;
  const localTask = ctx.state.localSnapshotTask || '';
  const isBusy = Boolean(
    (job && job.status === 'running') ||
    localTask ||
    (activeTask && (!job || job.status === 'running' || activeTask.type !== 'backup'))
  );

  // Hidden file input for .tar.gz import
  const fileInput = h('input', {
    type: 'file',
    accept: '.tar.gz',
    hidden: true,
    onChange: async (e) => {
      const file = e.currentTarget.files && e.currentTarget.files[0];
      e.currentTarget.value = '';
      if (!file) return;
      if (!file.name.endsWith('.tar.gz')) {
        showToast(t('snapshots', 'toastInvalidExtension'), 'warn');
        return;
      }
      const ok = await askConfirm({
        title: t('snapshots', 'confirmImportTitle'),
        iconName: 'upload',
        iconTone: 'info',
        confirmText: t('snapshots', 'confirmImportBtn'),
        confirmKind: 'primary',
        body: createNotice({
          level: 'info',
          title: t('snapshots', 'confirmImportNoticeTitle'),
          body: richText(t('snapshots', 'confirmImportNoticeBody'), {
            file: file.name,
            size: formatBytes(file.size, getLocaleTag())
          })
        })
      });
      if (!ok) return;

      ctx.state.localSnapshotTask = t('snapshots', 'taskImporting', { file: file.name });
      ctx.actions.renderMain();
      try {
        const r = await apiJson(`${ctx.adminPath}/api/snapshots/import?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-filename': encodeURIComponent(file.name)
          },
          body: file,
          timeoutMs: 300000
        });
        if (r.ok) {
          showToast(t('snapshots', 'toastImported', { file: r.data?.snapshot?.filename || file.name }), 'success');
        } else {
          showToast(r.message, { type: 'error', errorCode: r.errorCode });
        }
      } finally {
        ctx.state.localSnapshotTask = '';
        await ctx.actions.refreshSnapshots();
      }
    }
  });

  // Async job / busy task progress
  let taskBanner = null;
  if (job && job.status === 'running') {
    const elapsed = formatElapsed(job.elapsedMs);
    const bytes = formatBytes(job.progressBytes || 0, getLocaleTag());
    taskBanner = h(
      'div',
      { className: 'progress' },
      h('div', { className: 'progress-head' },
        h('div', { className: 'progress-label' },
          spinnerGlyph(14),
          h('span', null, t('snapshots', 'jobPackingTitle', { elapsed, size: bytes }))
        ),
        createTag({ tone: 'outline', text: t('snapshots', 'jobBackgroundTag') })
      ),
      h('div', { className: 'progress-track is-indeterminate', 'aria-hidden': 'true' }, h('span', { className: 'progress-fill' })),
      h('div', { className: 'progress-hint' }, t('snapshots', 'jobNonBlockingHint'))
    );
  } else if (localTask || (activeTask && activeTask.type !== 'backup')) {
    taskBanner = h('div', { className: 'progress is-inline' },
      h('div', { className: 'progress-label' },
        spinnerGlyph(14),
        h('span', null, localTask || activeTask.label || t('snapshots', 'taskRunningGeneric'))
      )
    );
  }

  let listEl;
  if (!snapData) {
    listEl = emptyState(t('common', 'loading'));
  } else if (list.length === 0) {
    listEl = emptyState(t('snapshots', 'emptyList'));
  } else {
    listEl = h(
      'div',
      { className: 'list surface' },
      list.map((s) => {
        const isDefault = String(s.filename || '').includes('default');
        const isConfig = s.type === 'config' || String(s.filename || '').startsWith('dsh-config-');
        const envParts = [];
        if (s.projectVersion) envParts.push(`${t('shell', 'suiteLabel')} ${suiteVerText(s.projectVersion, t)}`);
        if (s.dshVersion) envParts.push(`DSH v${s.dshVersion}`);
        if (envParts.length === 0) envParts.push(t('snapshots', 'unmarkedLegacy'));

        return h(
          'div',
          { className: 'list-row' },
          h('div', { className: 'list-main' },
            h('div', { className: 'list-title' },
              h('span', { className: 'list-name is-ellipsis', title: s.filename }, s.filename),
              createTag({ tone: isConfig ? 'outline' : 'neutral', text: isConfig ? t('snapshots', 'typeConfigOnly') : t('snapshots', 'typeFull') }),
              isDefault ? createTag({ tone: 'outline', text: t('snapshots', 'tagDefault') }) : null,
              s.legacyLocation ? createTag({ tone: 'warning', text: t('snapshots', 'tagLegacyDir') }) : null
            ),
            h('div', { className: 'list-meta' },
              metaLine(
                s.sizeFormatted || formatBytes(s.sizeBytes, getLocaleTag()),
                formatDateTime(s.createdAt, getLocaleTag()),
                ...envParts
              )
            )
          ),
          h('div', { className: 'list-actions' },
            button({ size: 'sm', variant: 'ghost', label: t('snapshots', 'inspectBtn'), onClick: () => openInspectModal(ctx, s) }),
            button({ size: 'sm', label: t('snapshots', 'restoreBtn'), disabled: isBusy, onClick: () => handleRestoreClick(ctx, s) }),
            button({
              size: 'sm',
              variant: 'ghost',
              iconName: 'download',
              iconOnly: true,
              title: t('snapshots', 'downloadBtn'),
              href: `${ctx.adminPath}/api/snapshots/download?file=${encodeURIComponent(s.filename)}`
            }),
            button({
              size: 'sm',
              variant: 'ghost',
              iconName: 'trash',
              iconOnly: true,
              className: 'is-danger-icon',
              disabled: isBusy,
              title: t('common', 'delete'),
              onClick: () => handleDeleteSnapshot(ctx, s)
            })
          )
        );
      })
    );
  }

  clear(container);
  container.append(
    pageHeader({
      title: t('snapshots', 'cardTitle'),
      desc: t('snapshots', 'cardDesc'),
      aside: actionGroup(
        fileInput,
        button({ size: 'sm', variant: 'ghost', iconName: 'refresh', label: t('plugins', 'refreshBtn'), onClick: () => ctx.actions.refreshSnapshots() }),
        button({ size: 'sm', iconName: 'upload', label: t('snapshots', 'importBtn'), disabled: isBusy, onClick: () => fileInput.click() }),
        button({ size: 'sm', variant: 'primary', iconName: 'plus', label: t('snapshots', 'createBtn'), disabled: isBusy, onClick: () => openCreateSnapshotModal(ctx) })
      )
    }),
    ...(taskBanner ? [h('div', { className: 'page-banner' }, taskBanner)] : []),
    listEl
  );
}
