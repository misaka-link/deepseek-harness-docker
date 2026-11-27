/**
 * Safe DOM builders, SVG icon factory, and whitelisted rich-text renderer.
 * Pure node-tree construction only (zero raw HTML string sinks).
 */

import { DSH_ICONS } from './dsh-art.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create a DOM element safely.
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs && typeof attrs === 'object') {
    for (const [key, val] of Object.entries(attrs)) {
      if (val === undefined || val === null || val === false) continue;
      if (key === 'class' || key === 'className') {
        el.className = String(val);
      } else if (key === 'style' && typeof val === 'object') {
        for (const [sk, sv] of Object.entries(val)) {
          if (sv !== undefined && sv !== null) {
            if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
            else el.style[sk] = String(sv);
          }
        }
      } else if (key === 'dataset' && typeof val === 'object') {
        for (const [dk, dv] of Object.entries(val)) {
          if (dv !== undefined && dv !== null) el.dataset[dk] = String(dv);
        }
      } else if (key.startsWith('on') && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (key === 'value' || key === 'checked' || key === 'selected' || key === 'disabled' || key === 'readOnly' || key === 'hidden') {
        el[key] = val;
      } else if (val === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(parent, items) {
  for (const child of items) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
  return parent;
}

export function clear(el) {
  if (el) el.replaceChildren();
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

/**
 * Interpolate `{param}` placeholders into plain text.
 * @param {string} template
 * @param {Record<string, any>} [params]
 * @returns {string}
 */
export function interpolate(template, params = null) {
  const str = String(template ?? '');
  if (!params) return str;
  return str.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, k) => {
    const v = params[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Safe rich-text builder supporting ONLY whitelisted static tags from i18n templates:
 * `<b>...</b>`, `<code>...</code>`, and `<a data-href-key="...">...</a>`.
 * Parameters (`{name}`) are substituted AFTER tag parsing as literal Text nodes,
 * making XSS via untrusted parameters structurally impossible.
 *
 * @param {string} template
 * @param {Record<string, any>} [params]
 * @param {Record<string, { href?: string, target?: string, onClick?: (e: Event) => void }>} [links]
 * @returns {DocumentFragment}
 */
/**
 * Decode the handful of HTML character references dictionaries use inside static
 * markup (e.g. `&lt;port&gt;`, `&amp;&amp;`). Output is only ever assigned to
 * textContent, so decoding cannot introduce markup.
 */
function decodeEntities(str) {
  return String(str).replace(/&(lt|gt|amp|quot|#39);/g, (_, e) => (
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : "'"
  ));
}

export function richText(template, params = null, links = null) {
  const f = document.createDocumentFragment();
  const src = String(template ?? '');
  const tokenRe = /<(b|code)>([\s\S]*?)<\/\1>|<a\s+data-href-key="([A-Za-z0-9_.-]+)">([\s\S]*?)<\/a>/g;
  let lastIndex = 0;
  let match;
  while ((match = tokenRe.exec(src)) !== null) {
    if (match.index > lastIndex) {
      f.appendChild(document.createTextNode(interpolate(decodeEntities(src.slice(lastIndex, match.index)), params)));
    }
    if (match[1]) {
      const node = document.createElement(match[1]);
      node.textContent = interpolate(decodeEntities(match[2]), params);
      f.appendChild(node);
    } else if (match[3]) {
      const linkKey = match[3];
      const spec = (links && links[linkKey]) || {};
      const a = document.createElement('a');
      a.textContent = interpolate(decodeEntities(match[4]), params);
      a.href = spec.href || '#';
      if (spec.target) {
        a.target = spec.target;
        if (spec.target === '_blank') a.rel = 'noopener noreferrer';
      }
      if (typeof spec.onClick === 'function') {
        a.addEventListener('click', (e) => {
          if (!spec.href || spec.href === '#') e.preventDefault();
          spec.onClick(e);
        });
      }
      f.appendChild(a);
    }
    lastIndex = tokenRe.lastIndex;
  }
  if (lastIndex < src.length) {
    f.appendChild(document.createTextNode(interpolate(decodeEntities(src.slice(lastIndex)), params)));
  }
  return f;
}

/**
 * Pure SVG element builder (Lucide-aligned stroke icons).
 */
export function svg(viewBox, shapes, attrs = {}) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('fill', attrs.fill || 'none');
  if (!attrs.fill || attrs.fill === 'none') {
    el.setAttribute('stroke', attrs.stroke || 'currentColor');
    el.setAttribute('stroke-width', String(attrs.strokeWidth || 1.9));
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
  }
  if (attrs.width) el.setAttribute('width', String(attrs.width));
  if (attrs.height) el.setAttribute('height', String(attrs.height));
  if (attrs.className) el.setAttribute('class', attrs.className);
  el.setAttribute('aria-hidden', 'true');
  for (const [tag, sAttrs] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(sAttrs)) {
      node.setAttribute(k, String(v));
    }
    el.appendChild(node);
  }
  return el;
}

const ICONS = {
  cpu: [
    ['rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 }],
    ['rect', { x: 9, y: 9, width: 6, height: 6 }],
    ['path', { d: 'M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3' }]
  ],
  puzzle: [
    ['path', { d: 'M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z' }]
  ],
  monitor: [
    ['rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }],
    ['line', { x1: 8, y1: 21, x2: 16, y2: 21 }],
    ['line', { x1: 12, y1: 17, x2: 12, y2: 21 }]
  ],
  archive: [
    ['rect', { x: 2, y: 4, width: 20, height: 5, rx: 1 }],
    ['path', { d: 'M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9' }],
    ['path', { d: 'M10 13h4' }]
  ],
  settings: [
    ['circle', { cx: 12, cy: 12, r: 3 }],
    ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }]
  ],
  menu: [
    ['line', { x1: 4, y1: 6, x2: 20, y2: 6 }],
    ['line', { x1: 4, y1: 12, x2: 20, y2: 12 }],
    ['line', { x1: 4, y1: 18, x2: 20, y2: 18 }]
  ],
  panelLeft: [
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
    ['line', { x1: 9, y1: 3, x2: 9, y2: 21 }]
  ],
  workspace: [
    ['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]
  ],
  external: [
    ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
    ['polyline', { points: '15 3 21 3 21 9' }],
    ['line', { x1: 10, y1: 14, x2: 21, y2: 3 }]
  ],
  github: [
    ['path', { d: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4' }],
    ['path', { d: 'M9 18c-4.51 2-5-2-7-2' }]
  ],
  globe: [
    ['circle', { cx: 12, cy: 12, r: 10 }],
    ['line', { x1: 2, y1: 12, x2: 22, y2: 12 }],
    ['path', { d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' }]
  ],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    ['path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41' }]
  ],
  moon: [
    ['path', { d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' }]
  ],
  logout: [
    ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }],
    ['polyline', { points: '16 17 21 12 16 7' }],
    ['line', { x1: 21, y1: 12, x2: 9, y2: 12 }]
  ],
  refresh: [
    ['polyline', { points: '23 4 23 10 17 10' }],
    ['polyline', { points: '1 20 1 14 7 14' }],
    ['path', { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }]
  ],
  play: [
    ['polygon', { points: '6 3 20 12 6 21 6 3' }]
  ],
  square: [
    ['rect', { x: 5, y: 5, width: 14, height: 14, rx: 2 }]
  ],
  trash: [
    ['polyline', { points: '3 6 5 6 21 6' }],
    ['path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }],
    ['path', { d: 'M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }]
  ],
  download: [
    ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ['polyline', { points: '7 10 12 15 17 10' }],
    ['line', { x1: 12, y1: 15, x2: 12, y2: 3 }]
  ],
  upload: [
    ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ['polyline', { points: '17 8 12 3 7 8' }],
    ['line', { x1: 12, y1: 3, x2: 12, y2: 15 }]
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 8 }],
    ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]
  ],
  eye: [
    ['path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }]
  ],
  eyeOff: [
    ['path', { d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94' }],
    ['path', { d: 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19' }],
    ['line', { x1: 1, y1: 1, x2: 23, y2: 23 }]
  ],
  copy: [
    ['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }],
    ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]
  ],
  check: [
    ['polyline', { points: '20 6 9 17 4 12' }]
  ],
  checkCircle: [
    ['path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }],
    ['polyline', { points: '22 4 12 14.01 9 11.01' }]
  ],
  alertTriangle: [
    ['path', { d: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }],
    ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }],
    ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }]
  ],
  alertCircle: [
    ['circle', { cx: 12, cy: 12, r: 10 }],
    ['line', { x1: 12, y1: 8, x2: 12, y2: 12 }],
    ['line', { x1: 12, y1: 16, x2: 12.01, y2: 16 }]
  ],
  shield: [
    ['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]
  ],
  info: [
    ['circle', { cx: 12, cy: 12, r: 10 }],
    ['line', { x1: 12, y1: 16, x2: 12, y2: 12 }],
    ['line', { x1: 12, y1: 8, x2: 12.01, y2: 8 }]
  ],
  x: [
    ['line', { x1: 18, y1: 6, x2: 6, y2: 18 }],
    ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]
  ],
  chevronDown: [
    ['polyline', { points: '6 9 12 15 18 9' }]
  ],
  plus: [
    ['line', { x1: 12, y1: 5, x2: 12, y2: 19 }],
    ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]
  ],
  terminal: [
    ['polyline', { points: '4 17 10 11 4 5' }],
    ['line', { x1: 12, y1: 19, x2: 20, y2: 19 }]
  ],
  wrench: [
    ['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]
  ],
  lock: [
    ['rect', { x: 3, y: 11, width: 18, height: 11, rx: 2 }],
    ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]
  ],
  history: [
    ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
    ['path', { d: 'M3 3v5h5' }],
    ['path', { d: 'M12 7v5l4 2' }]
  ],
  package: [
    ['path', { d: 'M16.5 9.4l-9-5.19' }],
    ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }],
    ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }],
    ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }]
  ],
  key: [
    ['circle', { cx: 7.5, cy: 15.5, r: 5.5 }],
    ['path', { d: 'M21 2l-9.6 9.6' }],
    ['path', { d: 'M15.5 7.5l3 3L22 7l-3-3' }]
  ]
};

/**
 * Official DSH glyph mapping (dsh-client-ui-primitives icon artwork, medium 1.3px stroke).
 * Names not listed here fall back to the Lucide-aligned set above, drawn at an
 * equivalent ~1.3px rendered stroke so both families share one optical weight.
 */
const DSH_GLYPHS = {
  workspace: 'new-chat-outline',
  newChat: 'new-chat-outline',
  search: 'search-outline',
  eye: 'eye-outline',
  eyeOff: 'eye-off-outline',
  globe: 'globe-outline',
  settings: 'settings-outline',
  panelLeft: 'panel-left-outline',
  menu: 'panel-left-outline',
  plus: 'plus-outline',
  check: 'check-outline',
  chevronDown: 'chevron-down-outline',
  chevronRight: 'chevron-right-outline',
  x: 'close-outline',
  copy: 'copy-outline',
  refresh: 'refresh-outline',
  external: 'right-up-outline',
  trash: 'trash-outline',
  alertCircle: 'warning-outline',
  alertTriangle: 'warning-triangle-outline',
  checkCircle: 'check-circle-outline',
  download: 'download-outline',
  upload: 'upload-outline',
  play: 'play-outline',
  puzzle: 'cordis-plugin-outline',
  sun: 'light-outline',
  moon: 'dark-outline',
  system: 'followsystem-outline',
  info: 'info-outline',
  archive: 'archive-outline',
  shield: 'shield-outline',
  history: 'clock-outline',
  clock: 'clock-outline',
  database: 'database-outline',
  gauge: 'gauge-outline',
  sliders: 'sliders-two-outline',
  link: 'link-outline',
  layers: 'layers-outline',
  code: 'code-outline',
  more: 'ellipsis-outline',
  save: 'save-outline',
  user: 'user-outline',
  folder: 'folder-open-outline',
  data: 'data-outline'
};

function buildArt(parent, nodes) {
  for (const node of nodes) {
    const [tag, attrs, children] = node;
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    if (Array.isArray(children)) buildArt(el, children);
    parent.appendChild(el);
  }
}

function dshIcon(glyph, size, className) {
  const art = DSH_ICONS[glyph];
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', art.viewBox || '0 0 16 16');
  for (const [k, v] of Object.entries(art.root || {})) el.setAttribute(k, String(v));
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', `dsh-icon${className ? ' ' + className : ''}`);
  buildArt(el, art.children || []);
  return el;
}

export function icon(name, size = 16, className = '') {
  const glyph = DSH_GLYPHS[name];
  if (glyph && DSH_ICONS[glyph]) return dshIcon(glyph, size, className);
  const shapes = ICONS[name] || ICONS.info;
  const strokeWidth = Math.round((1.3 * 24 / Math.max(10, size)) * 100) / 100;
  return svg('0 0 24 24', shapes, { width: size, height: size, className: `dsh-icon${className ? ' ' + className : ''}`, strokeWidth });
}
