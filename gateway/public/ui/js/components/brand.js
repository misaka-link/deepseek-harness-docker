/**
 * Official DSH brand lockup: whale mark + lowercase Montserrat `deepseek` wordmark
 * + solid `HARNESS` badge (geometry ported 1:1 from dsh-client-ui-primitives
 * BrandWordmark.tsx). Built with createElementNS only.
 */

import { WORDMARK_PARTS, WORDMARK_CLIPS } from '../lib/dsh-art.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
let clipSeq = 0;

function el(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
}

/**
 * @param {{ size?: number, includeMark?: boolean, className?: string, title?: string }} [opts]
 * @returns {SVGSVGElement}
 */
export function brandWordmark({ size = 24, includeMark = true, className = '', title = 'DeepSeek Harness' } = {}) {
  const width = includeMark ? 182 : 156;
  const seq = ++clipSeq;
  const svgEl = el('svg', {
    width: (size * width) / 24,
    height: size,
    viewBox: includeMark ? '0 0 182 24' : '26 0 156 24',
    fill: 'none',
    role: 'img',
    'aria-label': title,
    class: `brand-wordmark${className ? ' ' + className : ''}`
  });

  const defs = el('defs');
  const groups = {};
  for (const [name, rect] of Object.entries(WORDMARK_CLIPS)) {
    const id = `dshd-wordmark-${name}-${seq}`;
    const cp = el('clipPath', { id });
    cp.appendChild(el('rect', { ...rect, fill: 'white' }));
    defs.appendChild(cp);
    groups[name] = el('g', { 'clip-path': `url(#${id})` });
  }

  const placed = new Set();
  for (const [tag, attrs, fillKind, clip] of WORDMARK_PARTS) {
    if (!includeMark && clip === 'whale') continue;
    const node = el(tag, {
      ...attrs,
      fill: fillKind === 'c' ? 'currentColor' : 'var(--dsw-alias-label-primary-inverted)'
    });
    if (clip && groups[clip]) {
      groups[clip].appendChild(node);
      if (!placed.has(clip)) {
        placed.add(clip);
        svgEl.appendChild(groups[clip]);
      }
    } else {
      svgEl.appendChild(node);
    }
  }
  svgEl.appendChild(defs);
  return svgEl;
}

/**
 * Whale mark only (FishLogo geometry from the same artwork clip).
 */
export function brandMark({ size = 24, className = '' } = {}) {
  const seq = ++clipSeq;
  const svgEl = el('svg', {
    width: size,
    height: (size * 17.04) / 23.16,
    viewBox: '0.14 3.52 23.16 17.04',
    fill: 'none',
    'aria-hidden': 'true',
    class: `brand-mark${className ? ' ' + className : ''}`
  });
  const id = `dshd-mark-${seq}`;
  const defs = el('defs');
  const cp = el('clipPath', { id });
  cp.appendChild(el('rect', { ...WORDMARK_CLIPS.whale, fill: 'white' }));
  defs.appendChild(cp);
  const g = el('g', { 'clip-path': `url(#${id})` });
  for (const [tag, attrs, , clip] of WORDMARK_PARTS) {
    if (clip === 'whale') g.appendChild(el(tag, { ...attrs, fill: 'currentColor' }));
  }
  svgEl.append(g, defs);
  return svgEl;
}
