// Draws the shared layout two ways: exact pages (same spots as the PDF) and a phone reading view.

import { PAGE, createMeasurer, fieldRect, layoutDocument, parseBody } from './shared/layout.js';
import { FIELD_TYPES, SENDER_ROLE, displayValue, isImageType } from './shared/fields.js';

const NS = 'http://www.w3.org/2000/svg';
const ROLE_COLORS = ['#2f6fdf', '#1d8a4e', '#8e44ad', '#d35400', '#0f766e', '#be185d'];
export const SENDER_COLOR = '#b07d12';

let measurePromise;
export function getMeasure() {
  measurePromise ||= import('../vendor/pdf-lib-1.17.1.esm.min.js').then((PDFLib) => createMeasurer(PDFLib));
  return measurePromise;
}

export function roleColor(role, roles) {
  if (role === SENDER_ROLE) return SENDER_COLOR;
  const i = roles.indexOf(role);
  return ROLE_COLORS[(i < 0 ? roles.length : i) % ROLE_COLORS.length];
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export async function layoutFor(body, fields) {
  const measure = await getMeasure();
  return layoutDocument(body, fields, measure);
}

function pageSvg(lp, layout, byN, footer) {
  const svg = svgEl('svg', { viewBox: `0 0 ${PAGE.w} ${PAGE.h}`, 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
  for (const line of lp.lines) {
    for (const it of line.items) {
      if (it.kind === 'text') {
        const t = svgEl('text', {
          x: it.x,
          y: line.baseline,
          'font-size': it.size,
          'font-family': 'Helvetica, Arial, "Liberation Sans", sans-serif',
          'font-weight': it.bold ? 700 : 400,
          textLength: it.w.toFixed(2),
          lengthAdjust: 'spacingAndGlyphs',
          fill: '#000',
        });
        t.textContent = it.text;
        svg.append(t);
      } else if (it.kind === 'box') {
        const f = it.ref.field !== undefined ? byN.get(it.ref.field) : null;
        if (f && f.type === 'checkbox') continue;
        svg.append(svgEl('line', { x1: it.x, x2: it.x + it.w, y1: it.y + it.h, y2: it.y + it.h, stroke: '#8c8c8c', 'stroke-width': 0.6 }));
      }
    }
  }
  const foot = svgEl('text', { x: PAGE.margin, y: PAGE.h - 30, 'font-size': 8, fill: '#777', 'font-family': 'Helvetica, Arial, sans-serif' });
  foot.textContent = footer;
  svg.append(foot);
  return svg;
}

function boxContent(f, value) {
  if (value === undefined || value === null || value === '' || value === false) return null;
  if (isImageType(f.type)) return value.png ? h('img', { src: value.png, alt: f.type === 'signature' ? 'Signature' : 'Initials' }) : null;
  if (f.type === 'checkbox') return h('span', { text: '✓' });
  return h('span', { class: 'label', text: displayValue(f, value) });
}

// Renders every page. options:
//   roles: role names in order, values: { n: value }, selected: n,
//   isMine(f): field is editable here, showEmpty: show prompts on empty boxes,
//   onFieldPointerDown(e, f, el), onPagePointerDown(e, pageIndex, pageEl), zoom (1 = fit width)
export function renderPages(container, layout, fields, options = {}) {
  const roles = options.roles || [];
  const values = options.values || {};
  const byN = new Map(fields.map((f) => [Number(f.n), f]));
  container.replaceChildren();
  const pageEls = [];
  layout.pages.forEach((lp, i) => {
    const pageEl = h('div', { class: 'page', 'data-page': i, style: { width: `${(options.zoom || 1) * 100}%` } });
    pageEl.append(pageSvg(lp, layout, byN, `${options.title || ''}  |  Page ${i + 1} of ${layout.pages.length}`));
    const overlay = h('div', { class: 'overlay' });
    pageEl.append(overlay);
    if (options.onPagePointerDown) pageEl.addEventListener('pointerdown', (e) => options.onPagePointerDown(e, i, pageEl));
    pageEls.push({ pageEl, overlay });
    container.append(pageEl);
  });
  for (const f of fields) {
    const r = fieldRect(f, layout);
    if (!r || !pageEls[r.page]) continue;
    const mine = options.isMine ? options.isMine(f) : true;
    const value = values[f.n];
    const content = boxContent(f, value);
    const el = h(
      'div',
      {
        class: `fbox${content ? ' filled' : ''}${!mine ? ' readonly' : ''}${options.selected === f.n ? ' selected' : ''}`,
        'data-n': f.n,
        role: mine ? 'button' : null,
        tabindex: mine ? '0' : null,
        'aria-label': `Field ${f.n}: ${f.label || FIELD_TYPES[f.type].label}`,
        style: {
          left: `${(r.x / PAGE.w) * 100}%`,
          top: `${(r.y / PAGE.h) * 100}%`,
          width: `${(r.w / PAGE.w) * 100}%`,
          height: `${(r.h / PAGE.h) * 100}%`,
        },
      },
      options.showNumbers ? h('span', { class: 'num', text: f.n }) : null,
      content || (options.showEmpty && mine ? h('span', { class: 'label', text: f.label || FIELD_TYPES[f.type].label }) : null),
    );
    el.style.setProperty('--role', roleColor(f.role, roles));
    if (options.selected === f.n && !r.anchored && options.resizable) el.append(h('span', { class: 'handle', 'data-handle': '1' }));
    if (options.onFieldPointerDown && mine) el.addEventListener('pointerdown', (e) => options.onFieldPointerDown(e, f, el));
    pageEls[r.page].overlay.append(el);
  }
  return pageEls;
}

// Phone reading view: real text at a readable size, fields as tappable chips in place.
export function renderReader(container, body, fields, layout, options = {}) {
  const roles = options.roles || [];
  const values = options.values || {};
  const byN = new Map(fields.map((f) => [Number(f.n), f]));
  const blocks = parseBody(body);
  // Fields placed on the page (not in the text) appear after the paragraph closest to them.
  const after = new Map();
  const anchoredSet = new Set(Object.keys(layout.fieldRects).map(Number));
  for (const f of fields) {
    if (anchoredSet.has(f.n)) continue;
    const r = fieldRect(f, layout);
    let best = blocks.length - 1;
    if (r && layout.pages[r.page]) {
      let dist = Infinity;
      for (const line of layout.pages[r.page].lines) {
        const d = Math.abs(line.y + line.h / 2 - (r.y + r.h / 2));
        if (d < dist) {
          dist = d;
          best = line.blockIndex;
        }
      }
    }
    if (!after.has(best)) after.set(best, []);
    after.get(best).push(f);
  }

  const chip = (f) => {
    const value = values[f.n];
    const fixed = f.role === SENDER_ROLE;
    const mine = options.isMine ? options.isMine(f) : false;
    const has = !(value === undefined || value === null || value === '' || (f.type === 'checkbox' && value !== true));
    if (fixed) return h('span', { class: 'fchip fixed', text: displayValue(f, value) || '(left blank)' });
    let inner;
    if (has && isImageType(f.type)) inner = h('img', { src: value.png, alt: f.label || 'Signature' });
    else if (has) inner = h('span', { text: f.type === 'checkbox' ? '✓ Yes' : displayValue(f, value) });
    else inner = h('span', { text: mine ? f.label || FIELD_TYPES[f.type].prompt : `${f.role}: ${f.label || FIELD_TYPES[f.type].label}` });
    const el = h(mine ? 'button' : 'span', { class: `fchip ${mine ? (has ? 'done' : 'todo') : 'other'}`, 'data-n': f.n, type: mine ? 'button' : null }, inner);
    el.style.setProperty('--role', roleColor(f.role, roles));
    if (mine && options.onTap) el.addEventListener('click', () => options.onTap(f));
    return el;
  };

  const runsTo = (runs, parent) => {
    for (const run of runs) {
      if (run.kind === 'text') parent.append(run.bold ? h('strong', { text: run.text }) : document.createTextNode(run.text));
      else if (run.kind === 'field') {
        const f = byN.get(run.n);
        parent.append(f ? chip(f) : h('span', { class: 'blank' }, ' '));
      } else parent.append(h('span', { class: 'blank' }, ' '));
    }
  };

  container.replaceChildren();
  blocks.forEach((b, i) => {
    let el = null;
    if (b.type === 'h1') el = h('h2');
    else if (b.type === 'h2') el = h('h3');
    else if (b.type === 'li') el = h('div', { class: `li${b.level === 2 ? ' l2' : ''}` });
    else if (b.type === 'p') {
      el = h('p');
      if (b.marker) el.append(h('span', { class: 'num', text: b.marker }));
    }
    if (el) {
      runsTo(b.runs, el);
      container.append(el);
    }
    for (const f of after.get(i) || []) container.append(h('p', {}, chip(f)));
  });
}
