/**
 * Unified DSH Core Version Switch Confirmation Modal.
 * Strictly evaluates compatibility via structured backend `evalItem.level` / `evalItem.kind`.
 * Hard-blocks danger versions (legacy < floor or breaking major) with disabled Confirm button.
 */

import { h, icon, richText } from '../lib/dom.js';
import { t, getLocaleTag } from '../lib/i18n.js';
import { formatBytes } from '../lib/format.js';
import { openModal } from '../components/modal.js';
import { createTag, createNotice } from '../components/pill.js';
import { kvList, checkbox, checkboxRow } from '../components/ui.js';

export function openSwitchConfirmModal({
  targetVersion,
  currentVersion,
  evalItem,
  isCached,
  isAdapted,
  alreadyArchivedCurrent,
  rollbackPoint,
  upstreamReleases,
  estimatedBytes,
  onConfirm,
  onGoSnapshots
}) {
  const isDanger = Boolean(evalItem && evalItem.level === 'danger');
  const isLegacyFloorBlock = isDanger && (evalItem.kind === 'engine-unsupported' || evalItem.action === 'blocked-legacy');
  const isUnadapted = !isAdapted && !isDanger;

  const sourceText = isCached
    ? t('dsh', 'sourceCachedChip')
    : estimatedBytes
      ? t('dsh', 'sourceNpmWithSizeChip', { size: formatBytes(estimatedBytes, getLocaleTag()) })
      : t('dsh', 'sourceNpmChip');

  const adaptTag = isDanger
    ? createTag({ tone: 'danger', text: t('version', 'badgeIncompatible') })
    : isUnadapted
      ? createTag({ tone: 'warning', text: t('version', 'badgeUnadapted') })
      : createTag({ tone: 'outline', text: t('dsh', 'adaptedNoPullChip') });

  const summaryBox = kvList([
    [t('dsh', 'modalCurrentCore'), h('code', null, currentVersion ? `v${currentVersion}` : t('common', 'unknown'))],
    [t('dsh', 'modalTargetCore'), h('code', { className: 'text-strong' }, `v${targetVersion}`)],
    [t('dsh', 'modalSourceLabel'), sourceText],
    [t('dsh', 'modalAdaptLabel'), adaptTag]
  ]);

  // Structured compatibility notice
  let compatNotice = null;
  if (isLegacyFloorBlock) {
    const floorVer = evalItem?.params?.floor || '';
    compatNotice = createNotice({
      level: 'danger',
      title: t('dsh', 'evalUnsupportedTitle'),
      body: richText(t('dsh', 'evalUnsupportedModalBody'), { version: targetVersion, floor: floorVer })
    });
  } else if (isDanger) {
    compatNotice = createNotice({
      level: 'danger',
      title: t('dsh', 'evalBreakingTitle'),
      body: h(
        'div',
        null,
        h('div', null, richText(t('dsh', 'evalBreakingModalBody'), { version: targetVersion })),
        h('div', { className: 'callout-link' },
          h('a', {
            href: upstreamReleases || 'https://github.com/deepseek-ai/deepseek-harness/releases',
            target: '_blank',
            rel: 'noopener noreferrer'
          }, t('dsh', 'viewUpstreamReleases'), ' ', icon('external', 12))
        )
      )
    });
  } else if (isUnadapted) {
    compatNotice = createNotice({
      level: 'warn',
      title: t('dsh', 'evalUnadaptedTitle'),
      body: richText(t('dsh', 'evalUnadaptedModalBody'), { version: targetVersion })
    });
  } else {
    compatNotice = createNotice({
      level: 'success',
      title: t('dsh', 'evalAdaptedTitle', { version: targetVersion }),
      body: richText(t('dsh', 'evalAdaptedModalBody'), {
        version: targetVersion,
        current: currentVersion || t('common', 'unknown')
      })
    });
  }

  // Backup checkboxes
  const chkArchive = checkbox({ checked: true, disabled: Boolean(alreadyArchivedCurrent || isDanger) });
  const chkSnapshot = checkbox({ checked: false, disabled: Boolean(isDanger) });

  const backupBox = h(
    'div',
    { className: 'field' },
    h('div', { className: 'field-label' }, t('dsh', 'preSwitchBackupTitle')),
    h('div', { className: 'check-list' },
      checkboxRow({
        input: chkArchive,
        disabled: Boolean(alreadyArchivedCurrent || isDanger),
        label: [
          t('dsh', 'archiveCurrentLabel', { version: currentVersion ? `v${currentVersion}` : t('common', 'unknown') }),
          alreadyArchivedCurrent ? ` (${t('dsh', 'alreadyArchivedTag')})` : ''
        ],
        hint: t('dsh', 'archiveCurrentDesc')
      }),
      checkboxRow({
        input: chkSnapshot,
        disabled: Boolean(isDanger),
        label: t('dsh', 'exportSnapshotLabel'),
        hint: t('dsh', 'exportSnapshotDesc')
      })
    )
  );

  // Safety guarantee + optional rollback slot rotation info
  const safetyBlock = h(
    'div',
    { className: 'quiet-block' },
    h('div', { className: 'quiet-block-title' }, icon('shield', 14), t('dsh', 'rollbackGuaranteeTitle')),
    h('div', { className: 'quiet-block-body' }, richText(t('dsh', 'rollbackGuaranteeBody'))),
    rollbackPoint?.exists
      ? h('div', { className: 'quiet-block-body is-divided' }, richText(t('dsh', 'rollbackRotationNotice'), {
        version: rollbackPoint.version || t('common', 'unknown'),
        size: rollbackPoint.sizeFormatted || ''
      }))
      : null
  );

  const goSnapBtn = h('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => {
      modal.close();
      if (onGoSnapshots) onGoSnapshots();
    }
  }, t('dsh', 'goToSnapshotsBtn'));

  const cancelBtn = h('button', {
    type: 'button',
    className: 'btn',
    onClick: () => modal.close()
  }, t('common', 'cancel'));

  const confirmBtn = h('button', {
    type: 'button',
    className: 'btn btn-primary',
    disabled: isDanger,
    title: isDanger ? t('dsh', 'switchBlockedTooltip') : undefined,
    onClick: () => {
      const archiveCurrent = Boolean(chkArchive.checked);
      const wantSnapshot = Boolean(chkSnapshot.checked);
      modal.close();
      onConfirm({ version: targetVersion, archiveCurrent, wantSnapshot });
    }
  }, isDanger ? t('dsh', 'switchBlockedBtn') : t('dsh', 'confirmSwitchBtn'));

  const modal = openModal({
    title: t('dsh', 'switchModalTitle'),
    iconName: isDanger ? 'alertCircle' : 'shield',
    iconTone: isDanger ? 'danger' : '',
    closeOnBackdrop: !isDanger,
    content: h('div', { className: 'modal-stack' }, summaryBox, compatNotice, !isDanger ? backupBox : null, safetyBlock),
    footer: [goSnapBtn, h('span', { className: 'modal-footer-spacer' }), cancelBtn, confirmBtn]
  });

  return modal;
}
