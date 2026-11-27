/**
 * Status primitives ported from dsh-client-ui-primitives:
 *   - StateDot  (10px slot / 6px semantic core + plain secondary label)
 *   - Tag       (fixed capsule geometry, palette-only tones)
 *   - Callout   (quiet inline notice; tinted only for genuine warnings / errors)
 * Strict enum whitelists for every tone/state attribute.
 */

import { h, icon } from '../lib/dom.js';

const DOT_STATES = new Set(['done', 'warning', 'error', 'idle', 'info', 'ongoing']);
const TAG_TONES = new Set(['outline', 'solid', 'neutral', 'quiet', 'success', 'info', 'warning', 'danger']);
const NOTICE_LEVELS = new Set(['info', 'success', 'warn', 'danger']);

export function normalizeLevel(level) {
  if (level === 'warning') return 'warn';
  if (level === 'neutral') return 'idle';
  return ['success', 'info', 'warn', 'danger', 'idle'].includes(level) ? level : 'idle';
}

/** Map legacy pill kinds onto StateDot states. */
function kindToState(kind, spinner) {
  if (spinner) return 'ongoing';
  const k = normalizeLevel(kind);
  if (k === 'success') return 'done';
  if (k === 'warn') return 'warning';
  if (k === 'danger') return 'error';
  if (k === 'info') return 'info';
  return 'idle';
}

export function spinnerGlyph(size = 12) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'state-spinner');
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'state-spinner-motion');
  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', '12');
  track.setAttribute('cy', '12');
  track.setAttribute('r', '9');
  track.setAttribute('class', 'state-spinner-track');
  const arc = document.createElementNS(NS, 'circle');
  arc.setAttribute('cx', '12');
  arc.setAttribute('cy', '12');
  arc.setAttribute('r', '9');
  arc.setAttribute('class', 'state-spinner-arc');
  g.append(track, arc);
  s.appendChild(g);
  return s;
}

/**
 * StateDot + label.
 * @param {{ state?: string, text?: string, title?: string, className?: string }} opts
 */
export function createStateDot({ state = 'idle', text = '', title = '', className = '' } = {}) {
  const safe = DOT_STATES.has(state) ? state : 'idle';
  return h(
    'span',
    { className: `state${className ? ' ' + className : ''}`, title: title || undefined, dataset: { state: safe } },
    safe === 'ongoing' ? spinnerGlyph(12) : h('span', { className: 'state-dot', dataset: { state: safe }, 'aria-hidden': 'true' }),
    text ? h('span', { className: 'state-text' }, text) : null
  );
}

/** Legacy API: status pills now render as quiet StateDot labels. */
export function createPill({ kind = 'idle', text = '', spinner = false, title = '', onClick = null } = {}) {
  const node = createStateDot({ state: kindToState(kind, spinner), text, title });
  if (typeof onClick === 'function') {
    return h('button', { type: 'button', className: 'state-button', onClick, title: title || undefined }, node);
  }
  return node;
}

/**
 * Tag capsule.
 * @param {{ tone?: string, text?: string, title?: string }} opts
 */
export function createTag({ tone = 'neutral', text = '', title = '' } = {}) {
  const safe = TAG_TONES.has(tone) ? tone : 'neutral';
  return h('span', { className: 'tag', dataset: { tone: safe }, title: title || undefined }, text);
}

/** Legacy API: chips map onto restrained Tag tones (rainbow tones collapse to neutral). */
export function createChip({ tone = 'idle', text = '', title = '' } = {}) {
  const map = {
    success: 'success',
    info: 'neutral',
    warn: 'warning',
    warning: 'warning',
    danger: 'danger',
    purple: 'neutral',
    idle: 'neutral',
    neutral: 'neutral',
    outline: 'outline',
    quiet: 'quiet',
    solid: 'solid'
  };
  return createTag({ tone: map[tone] || 'neutral', text, title });
}

/**
 * Quiet callout. Info/success stay neutral; warn/danger tint with their own state colour.
 */
export function createNotice({ level = 'info', title = '', body = null, actions = null, compact = false } = {}) {
  const mapped = level === 'warning' ? 'warn' : level;
  const safeLevel = NOTICE_LEVELS.has(mapped) ? mapped : 'info';
  const iconName =
    safeLevel === 'danger' ? 'alertCircle'
      : safeLevel === 'warn' ? 'alertTriangle'
        : safeLevel === 'success' ? 'checkCircle'
          : 'info';

  return h(
    'div',
    {
      className: `callout${compact ? ' is-compact' : ''}`,
      dataset: { level: safeLevel },
      role: safeLevel === 'danger' || safeLevel === 'warn' ? 'alert' : 'status'
    },
    h('span', { className: 'callout-icon' }, icon(iconName, 16)),
    h(
      'div',
      { className: 'callout-content' },
      title ? h('div', { className: 'callout-title' }, title) : null,
      body ? h('div', { className: 'callout-body' }, body) : null,
      actions ? h('div', { className: 'callout-actions' }, actions) : null
    )
  );
}
