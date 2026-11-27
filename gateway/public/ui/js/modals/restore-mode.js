/**
 * Snapshot Restore Scope Selection Modal ('config-only' vs 'full').
 * Context-aware defaults based on live session count, archive content, and Schema 1 legacy detection.
 */

import { h, richText } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { suiteVerText } from '../lib/format.js';
import { openModal } from '../components/modal.js';
import { createTag, createNotice } from '../components/pill.js';
import { kvList, optionCard } from '../components/ui.js';

export function openRestoreModeModal({ filename, inspectData, snapshotMeta, onConfirm }) {
  const inspectOk = Boolean(inspectData && inspectData.ok !== false);
  const hasSessions = inspectOk && typeof inspectData.hasSessions === 'boolean'
    ? inspectData.hasSessions
    : null;
  const sessionCount = inspectOk && inspectData.current && typeof inspectData.current.sessionCount === 'number'
    ? inspectData.current.sessionCount
    : null;

  const isLegacySchema1 = Boolean(
    inspectData?.schemaVersion === 1 ||
    inspectData?.legacySettingsWarning ||
    inspectData?.configModel === 'settings.yaml' ||
    snapshotMeta?.configModel === 'settings.yaml'
  );

  // Context-aware default selection
  let selectedMode = null;
  const fullDisabled = hasSessions === false;
  if (hasSessions === false) {
    selectedMode = 'config-only';
  } else if (hasSessions === true && sessionCount === 0) {
    selectedMode = 'full';
  }

  const contentTypeText = hasSessions === false
    ? t('snapshots', 'typeConfigOnly')
    : hasSessions === true
      ? t('snapshots', 'typeFull')
      : t('common', 'unknown');

  const dshVer = inspectData?.dshVersion || snapshotMeta?.dshVersion || '';
  const projVer = inspectData?.projectVersion || snapshotMeta?.projectVersion || '';
  const envText = [
    projVer ? `${t('shell', 'suiteLabel')} ${suiteVerText(projVer, t)}` : '',
    dshVer ? `DSH v${dshVer}` : ''
  ].filter(Boolean).join(' · ');

  const metaBox = kvList([
    [t('snapshots', 'restoreTargetFile'), h('code', null, filename)],
    [t('snapshots', 'restoreContentType'), contentTypeText],
    [
      t('snapshots', 'restoreLiveSessions'),
      h('span', { className: sessionCount > 0 ? 'text-danger' : undefined },
        sessionCount !== null ? t('snapshots', 'liveSessionCount', { count: sessionCount }) : t('common', 'unknown'))
    ],
    envText ? [t('snapshots', 'colEnvVersion'), envText] : null
  ]);

  const legacyNotice = isLegacySchema1
    ? createNotice({
      level: 'warn',
      title: t('snapshots', 'legacySchemaTitle'),
      body: richText(t('snapshots', 'legacySchemaBody'))
    })
    : null;

  const conflictNotice = (hasSessions === true && sessionCount > 0)
    ? createNotice({
      level: 'danger',
      title: t('snapshots', 'overwriteRiskTitle'),
      body: richText(t('snapshots', 'overwriteRiskIntro'), { count: sessionCount })
    })
    : null;

  const radioConfig = h('input', {
    type: 'radio',
    className: 'radio',
    name: 'restoreScopeMode',
    value: 'config-only',
    checked: selectedMode === 'config-only',
    onChange: () => {
      selectedMode = 'config-only';
      syncUI();
    }
  });

  const radioFull = h('input', {
    type: 'radio',
    className: 'radio',
    name: 'restoreScopeMode',
    value: 'full',
    checked: selectedMode === 'full',
    disabled: fullDisabled,
    onChange: () => {
      if (fullDisabled) return;
      selectedMode = 'full';
      syncUI();
    }
  });

  const cardConfig = optionCard({
    input: radioConfig,
    title: t('snapshots', 'modeConfigOnlyTitle'),
    tag: createTag({ tone: 'success', text: t('snapshots', 'modeConfigOnlyTag') }),
    desc: richText(t('snapshots', 'modeConfigOnlyDesc'))
  });

  const cardFull = optionCard({
    input: radioFull,
    title: t('snapshots', 'modeFullTitle'),
    tag: fullDisabled ? createTag({ tone: 'danger', text: t('snapshots', 'noSessionsInArchiveTag') }) : null,
    desc: t('snapshots', 'modeFullDesc'),
    disabled: fullDisabled
  });

  const riskHost = h('div', { className: 'risk-host' });

  const cancelBtn = h('button', {
    type: 'button',
    className: 'btn',
    onClick: () => modal.close()
  }, t('common', 'cancel'));

  const submitBtn = h('button', {
    type: 'button',
    className: 'btn',
    disabled: true,
    onClick: () => {
      if (!selectedMode) return;
      const mode = selectedMode;
      modal.close();
      onConfirm({ filename, mode });
    }
  }, t('snapshots', 'selectRestoreScopeFirst'));

  function syncUI() {
    cardConfig.classList.toggle('is-selected', selectedMode === 'config-only');
    cardFull.classList.toggle('is-selected', !fullDisabled && selectedMode === 'full');
    cardFull.classList.toggle('is-danger', !fullDisabled && selectedMode === 'full');

    riskHost.replaceChildren();
    if (selectedMode === 'config-only') {
      riskHost.appendChild(createNotice({
        level: 'success',
        title: t('snapshots', 'riskSafeTitle'),
        body: richText(
          sessionCount > 0 ? t('snapshots', 'riskSafeBodyCount') : t('snapshots', 'riskSafeBodyGeneric'),
          { count: sessionCount || 0 }
        )
      }));
      submitBtn.disabled = false;
      submitBtn.className = 'btn btn-primary';
      submitBtn.textContent = t('snapshots', 'confirmRestoreConfigOnly');
    } else if (selectedMode === 'full') {
      riskHost.appendChild(createNotice({
        level: 'danger',
        title: t('snapshots', 'overwriteRiskTitle'),
        body: richText(
          sessionCount > 0 ? t('snapshots', 'riskFullBodyCount') : t('snapshots', 'riskFullBodyGeneric'),
          { count: sessionCount || 0 }
        )
      }));
      submitBtn.disabled = false;
      submitBtn.className = 'btn btn-danger';
      submitBtn.textContent = t('snapshots', 'confirmRestoreFull');
    } else {
      riskHost.appendChild(createNotice({
        level: 'warn',
        title: t('snapshots', 'riskSelectTitle'),
        body: richText(
          sessionCount > 0 ? t('snapshots', 'riskSelectBodyCount') : t('snapshots', 'riskSelectBodyGeneric'),
          { count: sessionCount || 0 }
        )
      }));
      submitBtn.disabled = true;
      submitBtn.className = 'btn';
      submitBtn.textContent = t('snapshots', 'selectRestoreScopeFirst');
    }
  }

  syncUI();

  const modal = openModal({
    title: t('snapshots', 'restoreModalTitle'),
    iconName: 'history',
    iconTone: conflictNotice ? 'warn' : '',
    closeOnBackdrop: false,
    content: h(
      'div',
      { className: 'modal-stack' },
      metaBox,
      legacyNotice,
      conflictNotice,
      h('div', { className: 'field' },
        h('div', { className: 'field-label' }, t('snapshots', 'restoreScopeLabel')),
        h('div', { className: 'option-cards' }, cardConfig, cardFull)
      ),
      riskHost
    ),
    footer: [cancelBtn, submitBtn]
  });

  return modal;
}
