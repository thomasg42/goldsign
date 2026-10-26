// Sender app: sign in with the owner PIN, write or pick a document, drop fields on it, send links,
// watch the status and download the signed PDF.

import { ApiError, api, ownerToken, setOwnerToken } from './api.js';
import { CONFIG } from './config.js';
import { SENDER_COLOR, h, layoutFor, renderPages, roleColor } from './render.js';
import { FIELD_TYPES, SENDER_ROLE, TYPE_KEYS, formatUtc, isImageType } from './shared/fields.js';
import { PAGE, fieldRect, replaceFieldToken, replaceNthBlank } from './shared/layout.js';
import { sendProblems } from './shared/rules.js';
import { describeEvent } from './shared/pdf.js';
import { savePdf } from './download.js';

const root = document.getElementById('app');

const A = {
  docs: [],
  templates: [],
  doc: null,
  draft: null,
  values: [],
  events: [],
  tab: 'text',
  layout: null,
  selected: null,
  armed: null,
  activeRole: null,
  zoom: 1,
  saveState: 'saved',
  links: [],
  ai: null,
  aiBusy: false,
};

// ---------- small UI helpers ----------

function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', text });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function topbar(...right) {
  const name = CONFIG.APP_NAME;
  const brand = /Sign$/.test(name) ? h('div', { class: 'brand' }, name.slice(0, -4), h('span', { text: 'Sign' })) : h('div', { class: 'brand', text: name });
  return h('header', { class: 'topbar' }, brand, h('div', { class: 'spacer' }), ...right);
}

function screen(right, ...children) {
  closeSheet();
  document.querySelector('.sticky-bar')?.remove();
  root.replaceChildren(topbar(...right), h('main', { class: 'wrap' }, ...children));
}

let sheetCleanup = null;
function closeSheet() {
  document.querySelector('.sheet')?.remove();
  document.querySelector('.sheet-backdrop')?.remove();
  sheetCleanup?.();
  sheetCleanup = null;
}

function openSheet(title, body, actions = [], { onClose } = {}) {
  closeSheet();
  const close = () => {
    closeSheet();
    onClose?.();
  };
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: close });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', { text: title }), body, actions.length ? h('div', { class: 'row end', style: { marginTop: '16px' } }, ...actions) : null);
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  sheetCleanup = () => document.removeEventListener('keydown', onKey);
  document.body.append(backdrop, sheet);
  return { sheet, close };
}

function statusChip(status) {
  return h('span', { class: `chip-status ${status}`, text: status });
}

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

function fail(err) {
  if (err instanceof ApiError && err.status === 401) {
    setOwnerToken('');
    showLogin('Please sign in again.');
    return true;
  }
  toast(err.message || 'Something went wrong.');
  return false;
}

function go(hash) {
  if (location.hash !== hash) history.pushState(null, '', hash);
  route();
}

// ---------- sign in ----------

function showLogin(note = '') {
  const pin = h('input', { type: 'password', id: 'pin', autocomplete: 'current-password' });
  const err = h('p', { class: 'error', role: 'alert', text: note });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Open');
  const form = h(
    'form',
    { class: 'card' },
    h('h1', { text: 'Sign in' }),
    h('p', { class: 'hint', text: 'Only the owner can send documents. Signers never need this.' }),
    h('label', { for: 'pin' }, 'Your PIN'),
    pin,
    err,
    h('div', { class: 'row', style: { marginTop: '14px' } }, btn),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    err.textContent = '';
    try {
      const { token } = await api('POST', '/api/login', { body: { pin: pin.value }, owner: false });
      setOwnerToken(token);
      go('#/');
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false;
    }
  });
  screen([], form);
  pin.focus();
}

// ---------- document list ----------

async function showList() {
  screen([h('button', { class: 'btn small', type: 'button', onclick: logout }, 'Sign out')], h('p', { class: 'hint', text: 'Loading...' }));
  try {
    const [d, t] = await Promise.all([api('GET', '/api/documents'), api('GET', '/api/templates')]);
    A.docs = d.documents;
    A.templates = t.templates;
  } catch (e) {
    fail(e);
    return;
  }
  const list = A.docs.length
    ? h(
        'ul',
        { class: 'doc-list' },
        ...A.docs.map((d) =>
          h(
            'li',
            {},
            h(
              'button',
              { type: 'button', onclick: () => go(`#/doc/${d.id}`) },
              h('span', { class: 'title', text: d.title }),
              h('span', { class: 'meta' }, statusChip(d.display_status), '  ', d.signers.map((s) => `${s.name || s.role} (${s.status})`).join(', ')),
              h('span', { class: 'meta', style: { display: 'block' }, text: `Updated ${when(d.updated_at)}` }),
            ),
          ),
        ),
      )
    : h('p', { class: 'card', text: 'No documents yet. Start one from a template or a blank page.' });
  screen(
    [h('button', { class: 'btn small', type: 'button', onclick: logout }, 'Sign out')],
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '12px' } }, h('h1', { text: 'Documents' }), h('button', { class: 'btn primary', type: 'button', onclick: newDocument }, 'New document')),
    list,
  );
}

function newDocument() {
  const make = async (template_id) => {
    closeSheet();
    try {
      const r = await api('POST', '/api/documents', { body: template_id ? { template_id } : {} });
      go(`#/doc/${r.document.id}/${template_id ? 'fields' : 'text'}`);
    } catch (e) {
      fail(e);
    }
  };
  openSheet(
    'New document',
    h(
      'div',
      { class: 'stack' },
      ...A.templates.map((t) => h('button', { class: 'btn', type: 'button', style: { width: '100%' }, onclick: () => make(t.id) }, `From template: ${t.name}`)),
      h('button', { class: 'btn', type: 'button', style: { width: '100%' }, onclick: () => make(null) }, 'Blank document'),
    ),
  );
}

async function logout() {
  try {
    await api('POST', '/api/logout');
  } catch {
    /* signing out locally is enough */
  }
  setOwnerToken('');
  showLogin();
}

// ---------- open a document ----------

async function openDoc(id, tab) {
  try {
    const r = await api('GET', `/api/documents/${id}`);
    loadDocResponse(r);
  } catch (e) {
    fail(e);
    return;
  }
  A.tab = A.doc.status === 'draft' ? tab || A.tab || 'text' : 'status';
  if (A.doc.status === 'draft' && !['text', 'fields', 'signers', 'send'].includes(A.tab)) A.tab = 'text';
  A.selected = null;
  A.armed = null;
  A.ai = null;
  await relayout();
  renderDoc();
}

function loadDocResponse(r) {
  A.doc = r.document;
  A.values = r.values;
  A.events = r.events;
  A.draft = {
    title: r.document.title,
    body: r.document.body,
    fields: r.document.fields.map((f) => ({ ...f })),
    signers: r.document.signers.map((s) => ({ id: s.id, role: s.role, name: s.name, email: s.email, phone: s.phone || '' })),
  };
  const roles = A.draft.signers.map((s) => s.role);
  if (!A.activeRole || (A.activeRole !== SENDER_ROLE && !roles.includes(A.activeRole))) A.activeRole = roles[roles.length - 1] || SENDER_ROLE;
}

async function relayout() {
  A.layout = await layoutFor(A.draft.body, A.draft.fields);
}

const roles = () => A.draft.signers.map((s) => s.role);
const senderValueMap = () => Object.fromEntries(A.draft.fields.filter((f) => f.role === SENDER_ROLE && f.value !== undefined).map((f) => [f.n, f.value]));
const nextN = () => A.draft.fields.reduce((m, f) => Math.max(m, f.n), 0) + 1;

// ---------- saving ----------

let saveTimer = null;
let saving = null;
let saveAgain = false;

function scheduleSave() {
  A.saveState = 'pending';
  paintSaveState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!A.doc || A.doc.status !== 'draft') return;
  if (saving) {
    saveAgain = true;
    return saving;
  }
  A.saveState = 'saving';
  paintSaveState();
  saving = (async () => {
    try {
      const r = await api('PUT', `/api/documents/${A.doc.id}`, { body: A.draft });
      A.doc = r.document;
      // Keep local edits, but pick up the ids the server gave new signers.
      r.document.signers.forEach((s, i) => {
        if (A.draft.signers[i] && !A.draft.signers[i].id) A.draft.signers[i].id = s.id;
      });
      A.saveState = 'saved';
    } catch (e) {
      A.saveState = 'error';
      if (!fail(e)) toast(`Not saved: ${e.message}`);
    } finally {
      saving = null;
      paintSaveState();
    }
  })();
  await saving;
  if (saveAgain) {
    saveAgain = false;
    await saveNow();
  }
}

function paintSaveState() {
  const el = document.getElementById('save-state');
  if (!el) return;
  el.textContent = { saved: 'Saved', saving: 'Saving...', pending: 'Editing...', error: 'Not saved. Check your connection.' }[A.saveState] || '';
}

// ---------- document screen ----------

function renderDoc() {
  const d = A.doc;
  const tabs = d.status === 'draft' ? [['text', 'Text'], ['fields', 'Fields'], ['signers', 'Signers'], ['send', 'Send']] : [];
  const tabBar = tabs.length
    ? h(
        'div',
        { class: 'tabs', role: 'tablist' },
        ...tabs.map(([key, label]) =>
          h('button', { type: 'button', role: 'tab', 'aria-selected': String(A.tab === key), onclick: async () => {
            await saveNow();
            go(`#/doc/${d.id}/${key}`);
          } }, label),
        ),
      )
    : null;
  const body = h('div', { id: 'tab-body' });
  screen(
    [h('button', { class: 'btn small', type: 'button', onclick: async () => {
      await saveNow();
      go('#/');
    } }, 'All documents')],
    h('div', { class: 'row', style: { marginTop: '12px', justifyContent: 'space-between' } }, h('h1', { text: A.draft.title || 'Untitled' }), statusChip(d.display_status || d.status)),
    d.status === 'draft' ? h('p', { class: 'saved-state', id: 'save-state' }) : null,
    tabBar,
    body,
  );
  paintSaveState();
  ({ text: renderText, fields: renderFields, signers: renderSigners, send: renderSend, status: renderStatus })[A.tab](body);
}

// ---------- Text tab ----------

function renderText(body) {
  const title = h('input', { id: 'doc-title', value: A.draft.title, maxlength: '200' });
  title.addEventListener('input', () => {
    A.draft.title = title.value;
    scheduleSave();
  });
  const area = h('textarea', { id: 'doc-body', spellcheck: 'true', 'aria-describedby': 'fmt-help' });
  area.value = A.draft.body;
  area.addEventListener('input', () => {
    A.draft.body = area.value;
    scheduleSave();
  });
  const insert = (fn) => () => {
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const v = area.value;
    const lineStart = v.lastIndexOf('\n', start - 1) + 1;
    const out = fn(v, start, end, lineStart);
    area.value = out.text;
    area.focus();
    area.setSelectionRange(out.caret, out.caret);
    A.draft.body = area.value;
    scheduleSave();
  };
  const prefix = (p) => insert((v, s, e, ls) => ({ text: v.slice(0, ls) + p + v.slice(ls), caret: s + p.length }));
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('button', { class: 'btn small', type: 'button', onclick: prefix('# ') }, 'Heading'),
    h('button', { class: 'btn small', type: 'button', onclick: insert((v, s, e) => ({ text: `${v.slice(0, s)}**${v.slice(s, e) || 'bold'}**${v.slice(e)}`, caret: e + 4 + (s === e ? 4 : 0) })) }, 'Bold'),
    h('button', { class: 'btn small', type: 'button', onclick: insert((v, s, e, ls) => {
      const nums = [...v.slice(0, ls).matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1]));
      const p = `${(nums.length ? Math.max(...nums) : 0) + 1}. `;
      return { text: v.slice(0, ls) + p + v.slice(ls), caret: s + p.length };
    }) }, 'Numbered'),
    h('button', { class: 'btn small', type: 'button', onclick: prefix('- ') }, 'Bullet'),
    h('button', { class: 'btn small', type: 'button', onclick: insert((v, s, e) => ({ text: `${v.slice(0, s)}[____]${v.slice(e)}`, caret: s + 6 })) }, 'Blank [____]'),
  );
  const aiBox = h('div', { class: 'card', id: 'ai-box' });
  body.append(
    h('label', { for: 'doc-title' }, 'Title'),
    title,
    h('label', { for: 'doc-body' }, 'Wording'),
    toolbar,
    area,
    h(
      'p',
      { class: 'hint', id: 'fmt-help' },
      'One paragraph per line. "# " makes a heading, "1. " a numbered clause, "- " a bullet, **text** bold. [____] is a blank you can drop a field on. [[7]] is where field 7 sits (added for you when you drop a field on a blank).',
    ),
    aiBox,
  );
  paintAi(aiBox);
}

function paintAi(box) {
  const run = async () => {
    await saveNow();
    A.aiBusy = true;
    paintAi(box);
    try {
      A.ai = await api('POST', '/api/ai/match-wording', { body: { title: A.draft.title, body: A.draft.body, fields: A.draft.fields, roles: roles() } });
      A.ai.suggestions = A.ai.suggestions.map((s) => ({ ...s, state: 'open' }));
    } catch (e) {
      if (!fail(e)) A.ai = { error: e.message };
    }
    A.aiBusy = false;
    paintAi(box);
  };
  const children = [
    h('h2', { text: 'AI helper: match the wording to the fields' }),
    h('p', { class: 'hint', text: 'Claude reads the wording and your fields and suggests edits. Nothing changes until you accept an edit. Numbers, names and prices are kept as written; anything that changes what someone agrees to is flagged.' }),
    h('button', { class: 'btn gold', type: 'button', disabled: A.aiBusy, onclick: run }, A.aiBusy ? 'Reading the document... (up to a minute)' : 'Suggest wording edits'),
  ];
  const ai = A.ai;
  if (ai?.error) children.push(h('p', { class: 'error', text: ai.error }));
  if (ai && !ai.error) {
    if (ai.summary) children.push(h('p', { text: ai.summary }));
    if (!ai.suggestions.length) children.push(h('p', { class: 'hint', text: 'No edits suggested.' }));
    for (const s of ai.suggestions) {
      const accept = async () => {
        const at = A.draft.body.indexOf(s.before);
        if (at < 0 || A.draft.body.indexOf(s.before, at + 1) >= 0) {
          s.state = 'stale';
        } else {
          A.draft.body = A.draft.body.slice(0, at) + s.after + A.draft.body.slice(at + s.before.length);
          s.state = 'accepted';
          const area = document.getElementById('doc-body');
          if (area) area.value = A.draft.body;
          scheduleSave();
          await relayout();
        }
        paintAi(box);
      };
      children.push(
        h(
          'div',
          { class: 'suggestion' },
          s.legal_change ? h('p', {}, h('span', { class: 'flag', text: 'Changes what someone agrees to' }), ' Review carefully, or ask your lawyer.') : null,
          h('p', {}, h('span', { class: 'before', text: s.before })),
          h('p', {}, h('span', { class: 'after', text: s.after })),
          h('p', { class: 'hint', text: s.reason }),
          s.state === 'open'
            ? h('div', { class: 'row' }, h('button', { class: 'btn small primary', type: 'button', onclick: accept }, 'Accept'), h('button', { class: 'btn small', type: 'button', onclick: () => ((s.state = 'skipped'), paintAi(box)) }, 'Skip'))
            : h('p', { class: 'hint', text: { accepted: 'Accepted.', skipped: 'Skipped.', stale: 'The text changed since this was suggested, so it was not applied.' }[s.state] }),
        ),
      );
    }
    if (ai.unmentioned_fields?.length) {
      children.push(h('h2', { text: 'Fields the wording does not explain' }), h('ul', {}, ...ai.unmentioned_fields.map((u) => h('li', { text: `Field ${u.field_number}: ${u.note}` }))));
    }
    if (ai.missing_fields?.length) {
      children.push(
        h('h2', { text: 'Places that ask for something but have no field' }),
        h('ul', {}, ...ai.missing_fields.map((m) => h('li', { text: `"${m.text}": add a ${FIELD_TYPES[m.suggested_type]?.label || m.suggested_type} field for the ${m.suggested_role}.` }))),
      );
    }
  }
  box.replaceChildren(...children);
}

// ---------- Fields tab (the builder) ----------

function defaultLabel(type, role) {
  if (role === SENDER_ROLE) return FIELD_TYPES[type].label;
  return FIELD_TYPES[type].prompt;
}

function blankAt(pageIndex, px, py) {
  return A.layout.blanks.find((b) => b.page === pageIndex && px >= b.x - 6 && px <= b.x + b.w + 6 && py >= b.y - 12 && py <= b.y + b.h + 6) || null;
}

function toPagePoint(pageEl, clientX, clientY) {
  const r = pageEl.getBoundingClientRect();
  return { px: ((clientX - r.left) / r.width) * PAGE.w, py: ((clientY - r.top) / r.height) * PAGE.h };
}

const pct = (v, total) => Math.round((v / total) * 10000) / 100;

async function placeField(type, pageIndex, px, py) {
  if (A.activeRole === SENDER_ROLE && isImageType(type)) {
    toast('Signatures and initials belong to a signer. Pick who signs first.');
    return;
  }
  const n = nextN();
  const f = { n, type, role: A.activeRole, label: defaultLabel(type, A.activeRole), required: type !== 'checkbox' };
  const blank = blankAt(pageIndex, px, py);
  if (blank) {
    A.draft.body = replaceNthBlank(A.draft.body, blank.index, `[[${n}]]`);
  } else {
    const base = FIELD_TYPES[type];
    const w = base.w;
    const hh = base.h + 6;
    f.page = pageIndex;
    f.x = pct(Math.max(0, Math.min(PAGE.w - w, px - w / 2)), PAGE.w);
    f.y = pct(Math.max(0, Math.min(PAGE.h - hh, py - hh / 2)), PAGE.h);
    f.w = pct(w, PAGE.w);
    f.h = pct(hh, PAGE.h);
  }
  A.draft.fields.push(f);
  A.selected = n;
  A.armed = null;
  await relayout();
  scheduleSave();
  paintBuilder();
  openFieldPanel(f);
}

async function fillEveryBlank() {
  const contexts = [];
  for (const line of A.draft.body.split('\n')) {
    for (const m of line.matchAll(/\[\s*_*\s*\]/g)) {
      const before = line
        .slice(0, m.index)
        .replace(/\[\[\d+\]\]|\[\s*_*\s*\]|[*#]/g, ' ')
        .replace(/^\s*(\d+\.|-)\s*/, '')
        .trim()
        .split(/\s+/)
        .slice(-6)
        .join(' ')
        .replace(/[:,(]+$/, '');
      contexts.push(before);
    }
  }
  if (!contexts.length) {
    toast('There are no empty blanks left.');
    return;
  }
  let n = nextN();
  contexts.forEach((ctx, i) => {
    A.draft.body = replaceNthBlank(A.draft.body, 0, `[[${n}]]`);
    A.draft.fields.push({ n, type: 'free_text', role: SENDER_ROLE, label: ctx || `Blank ${i + 1}`, required: true });
    n += 1;
  });
  await relayout();
  scheduleSave();
  paintBuilder();
  toast(`Added ${contexts.length} fields for you to fill in before sending.`);
}

function renderFields(body) {
  body.append(
    h('p', { class: 'hint', text: 'Pick who fills it, then tap a field type and tap the page or a blank line where it goes. You can also drag a type onto the page. Tap a box to edit it. Drag a box to move it.' }),
    h('div', { id: 'builder-controls' }),
    h('div', { class: 'pages', id: 'builder-pages' }),
  );
  paintBuilder();
}

function paintBuilder() {
  const controls = document.getElementById('builder-controls');
  const pagesEl = document.getElementById('builder-pages');
  if (!controls || !pagesEl) return;
  const rs = roles();
  const rolePick = h(
    'div',
    { class: 'roles-pick', role: 'group', 'aria-label': 'Who fills the next field' },
    ...[...rs, SENDER_ROLE].map((r) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(A.activeRole === r), onclick: () => ((A.activeRole = r), paintBuilder()) }, r === SENDER_ROLE ? 'Me, before sending' : r);
      b.style.setProperty('--role', roleColor(r, rs));
      return b;
    }),
  );
  const palette = h(
    'div',
    { class: 'palette', role: 'group', 'aria-label': 'Field types' },
    ...TYPE_KEYS.map((type) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(A.armed === type), 'data-type': type }, FIELD_TYPES[type].label);
      attachPaletteDrag(b, type);
      return b;
    }),
  );
  const zoom = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Page size' },
    ...[
      [1, 'Fit'],
      [1.5, '150%'],
      [2, '200%'],
    ].map(([z, label]) => h('button', { type: 'button', 'aria-pressed': String(A.zoom === z), onclick: () => ((A.zoom = z), paintBuilder()) }, label)),
  );
  controls.replaceChildren(
    h('div', { class: 'card stack' }, h('strong', { text: 'Who fills the next field' }), rolePick, h('strong', { text: 'Field types' }), palette, h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: fillEveryBlank }, 'Put a field on every blank'), zoom)),
    A.armed ? h('p', { class: 'big-note', role: 'status' }, `Now tap the page where the ${FIELD_TYPES[A.armed].label} field goes.`, ' ', h('button', { class: 'btn small', type: 'button', onclick: () => ((A.armed = null), paintBuilder()) }, 'Cancel')) : null,
  );
  renderPages(pagesEl, A.layout, A.draft.fields, {
    roles: rs,
    values: senderValueMap(),
    selected: A.selected,
    showEmpty: true,
    showNumbers: true,
    resizable: true,
    zoom: A.zoom,
    title: A.draft.title,
    onFieldPointerDown: fieldPointerDown,
  });
  // Highlight open blanks while a type is armed.
  if (A.armed) {
    for (const b of A.layout.blanks) {
      const pageEl = pagesEl.querySelector(`.page[data-page="${b.page}"] .overlay`);
      pageEl?.append(h('div', { class: 'blank-target', style: { left: `${(b.x / PAGE.w) * 100}%`, top: `${((b.y - 4) / PAGE.h) * 100}%`, width: `${(b.w / PAGE.w) * 100}%`, height: `${((b.h + 6) / PAGE.h) * 100}%` } }));
    }
  }
  pagesEl.onclick = (e) => {
    if (!A.armed || e.target.closest('.fbox')) return;
    const pageEl = e.target.closest('.page');
    if (!pageEl) return;
    const { px, py } = toPagePoint(pageEl, e.clientX, e.clientY);
    placeField(A.armed, Number(pageEl.dataset.page), px, py);
  };
}

function attachPaletteDrag(button, type) {
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost = null;
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) {
        ghost = h('div', { class: 'drag-ghost', text: FIELD_TYPES[type].label });
        document.body.append(ghost);
      }
      if (ghost) {
        ev.preventDefault();
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
      }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!ghost) {
        A.armed = A.armed === type ? null : type;
        paintBuilder();
        return;
      }
      ghost.remove();
      const pageEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.page');
      if (!pageEl) return;
      const { px, py } = toPagePoint(pageEl, ev.clientX, ev.clientY);
      placeField(type, Number(pageEl.dataset.page), px, py);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

function fieldPointerDown(e, f, el) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const resizing = Boolean(e.target.closest('[data-handle]'));
  const pageEl = el.closest('.page');
  const startX = e.clientX;
  const startY = e.clientY;
  const r0 = fieldRect(f, A.layout);
  let moved = false;
  let ghost = null;
  el.setPointerCapture?.(e.pointerId);
  const move = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    moved = true;
    ev.preventDefault();
    const rect = pageEl.getBoundingClientRect();
    const dxp = (dx / rect.width) * PAGE.w;
    const dyp = (dy / rect.height) * PAGE.h;
    if (resizing) {
      el.style.width = `${((Math.max(14, r0.w + dxp)) / PAGE.w) * 100}%`;
      el.style.height = `${((Math.max(10, r0.h + dyp)) / PAGE.h) * 100}%`;
    } else if (!r0.anchored) {
      el.style.left = `${((r0.x + dxp) / PAGE.w) * 100}%`;
      el.style.top = `${((r0.y + dyp) / PAGE.h) * 100}%`;
    } else {
      if (!ghost) {
        ghost = h('div', { class: 'drag-ghost', text: `Field ${f.n}` });
        document.body.append(ghost);
      }
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
    }
  };
  const up = async (ev) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    ghost?.remove();
    if (!moved) {
      A.selected = f.n;
      paintBuilder();
      openFieldPanel(f);
      return;
    }
    const rect = pageEl.getBoundingClientRect();
    const dxp = ((ev.clientX - startX) / rect.width) * PAGE.w;
    const dyp = ((ev.clientY - startY) / rect.height) * PAGE.h;
    if (resizing) {
      f.w = pct(Math.max(14, r0.w + dxp), PAGE.w);
      f.h = pct(Math.max(10, r0.h + dyp), PAGE.h);
    } else if (!r0.anchored) {
      // Free box: dropping it on a blank pins it into the text; elsewhere it just moves.
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.page') || pageEl;
      const { px, py } = toPagePoint(target, ev.clientX, ev.clientY);
      const page = Number(target.dataset.page);
      const blank = blankAt(page, px, py);
      if (blank) {
        A.draft.body = replaceNthBlank(A.draft.body, blank.index, `[[${f.n}]]`);
        delete f.page;
        delete f.x;
        delete f.y;
        delete f.w;
        delete f.h;
      } else {
        f.page = page;
        f.x = pct(Math.max(0, Math.min(PAGE.w - r0.w, r0.x + (target === pageEl ? dxp : px - r0.x - r0.w / 2))), PAGE.w);
        f.y = pct(Math.max(0, Math.min(PAGE.h - r0.h, r0.y + (target === pageEl ? dyp : py - r0.y - r0.h / 2))), PAGE.h);
      }
    } else {
      // Pinned box: drop on another blank to move it there, or anywhere else to unpin it.
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.page');
      if (!target) {
        paintBuilder();
        return;
      }
      const { px, py } = toPagePoint(target, ev.clientX, ev.clientY);
      const page = Number(target.dataset.page);
      const blank = blankAt(page, px, py);
      A.draft.body = replaceFieldToken(A.draft.body, f.n, '[____]');
      await relayout();
      if (blank) {
        const fresh = blankAt(page, px, py);
        if (fresh) A.draft.body = replaceNthBlank(A.draft.body, fresh.index, `[[${f.n}]]`);
      } else {
        f.page = page;
        f.x = pct(Math.max(0, Math.min(PAGE.w - r0.w, px - r0.w / 2)), PAGE.w);
        f.y = pct(Math.max(0, Math.min(PAGE.h - r0.h, py - r0.h / 2)), PAGE.h);
        f.w = pct(r0.w, PAGE.w);
        f.h = pct(r0.h + 4, PAGE.h);
      }
    }
    A.selected = f.n;
    await relayout();
    scheduleSave();
    paintBuilder();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function senderValueEditor(f, onChange) {
  const v = f.value;
  if (f.type === 'checkbox') {
    const c = h('input', { type: 'checkbox', id: 'fv' });
    c.checked = v === true;
    c.addEventListener('change', () => onChange(c.checked ? true : undefined));
    return h('label', { class: 'consent', for: 'fv' }, c, h('span', { text: 'Ticked' }));
  }
  if (f.type === 'address') {
    const a = v && typeof v === 'object' ? { ...v } : { street: '', city: '', state: '', zip: '' };
    const part = (key, label, attrs = {}) => {
      const i = h('input', { value: a[key] || '', ...attrs });
      i.addEventListener('input', () => {
        a[key] = i.value;
        onChange({ ...a });
      });
      return h('label', {}, label, i);
    };
    return h('div', {}, part('street', 'Street'), part('city', 'City'), part('state', 'State', { maxlength: '2' }), part('zip', 'ZIP', { inputmode: 'numeric' }));
  }
  const type = { date: 'date', email: 'email', phone: 'tel' }[f.type] || 'text';
  const i = h('input', { type, id: 'fv', value: typeof v === 'string' ? v : '' });
  i.addEventListener('input', () => onChange(i.value === '' ? undefined : i.value));
  return h('div', {}, h('label', { for: 'fv' }, 'Value that prints on the document'), i);
}

function openFieldPanel(f) {
  const rs = roles();
  const anchored = Boolean(A.layout.fieldRects[f.n]);
  const changed = async () => {
    await relayout();
    scheduleSave();
    paintBuilder();
  };
  const body = h('div');
  const paint = () => {
    const typeSel = h('select', { id: 'f-type' }, ...TYPE_KEYS.map((t) => h('option', { value: t, selected: t === f.type }, FIELD_TYPES[t].label)));
    typeSel.addEventListener('change', () => {
      if (f.role === SENDER_ROLE && isImageType(typeSel.value)) {
        toast('Signatures belong to a signer. Change who fills it first.');
        typeSel.value = f.type;
        return;
      }
      f.type = typeSel.value;
      if (f.type === 'signature') f.required = true;
      delete f.value;
      delete f.prefill;
      changed();
      paint();
    });
    const label = h('input', { id: 'f-label', value: f.label || '', maxlength: '200' });
    label.addEventListener('input', () => {
      f.label = label.value;
      scheduleSave();
    });
    const roleSel = h('select', { id: 'f-role' }, ...[...rs, SENDER_ROLE].map((r) => h('option', { value: r, selected: r === f.role }, r === SENDER_ROLE ? 'Me, before sending' : r)));
    roleSel.addEventListener('change', () => {
      if (roleSel.value === SENDER_ROLE && isImageType(f.type)) {
        toast('Signatures belong to a signer.');
        roleSel.value = f.role;
        return;
      }
      f.role = roleSel.value;
      if (f.role !== SENDER_ROLE) delete f.value;
      changed();
      paint();
    });
    const req = h('input', { type: 'checkbox', id: 'f-req', disabled: f.type === 'signature' });
    req.checked = f.type === 'signature' || f.required;
    req.addEventListener('change', () => {
      f.required = req.checked;
      scheduleSave();
    });
    const parts = [
      h('label', { for: 'f-label' }, f.role === SENDER_ROLE ? 'Note to yourself' : 'What the signer is asked'),
      label,
      h('label', { for: 'f-role' }, 'Who fills it'),
      roleSel,
      h('label', { for: 'f-type' }, 'Type'),
      typeSel,
    ];
    if (f.role !== SENDER_ROLE) parts.push(h('label', { class: 'consent', for: 'f-req', style: { borderColor: 'var(--line)', background: '#fff' } }, req, h('span', { text: f.type === 'signature' ? 'Required (always, for signatures)' : 'Required' })));
    if (f.role === SENDER_ROLE) {
      parts.push(
        h('p', { class: 'hint', text: 'You fill this in now. It prints on the document and the signer cannot change it.' }),
        senderValueEditor(f, (v) => {
          if (v === undefined) delete f.value;
          else f.value = v;
          scheduleSave();
          paintBuilder();
        }),
      );
    } else if (['full_name', 'company', 'email', 'phone', 'free_text'].includes(f.type)) {
      const pre = h('input', { id: 'f-pre', value: typeof f.prefill === 'string' ? f.prefill : '' });
      pre.addEventListener('input', () => {
        if (pre.value) f.prefill = pre.value;
        else delete f.prefill;
        scheduleSave();
      });
      parts.push(h('label', { for: 'f-pre' }, 'Pre-fill (optional, the signer can change it)'), pre);
    }
    if (f.type === 'date' && f.role !== SENDER_ROLE) {
      const allow = h('input', { type: 'checkbox', id: 'f-allow' });
      allow.checked = Boolean(f.allowChange);
      allow.addEventListener('change', () => {
        f.allowChange = allow.checked || undefined;
        scheduleSave();
      });
      parts.push(h('label', { class: 'consent', for: 'f-allow', style: { borderColor: 'var(--line)', background: '#fff' } }, allow, h('span', { text: "Let the signer pick a different date (otherwise it is the day they sign)" })));
    }
    if (f.type === 'free_text') {
      const multi = h('input', { type: 'checkbox', id: 'f-multi' });
      multi.checked = Boolean(f.multiline);
      multi.addEventListener('change', () => {
        f.multiline = multi.checked || undefined;
        scheduleSave();
      });
      const max = h('input', { id: 'f-max', type: 'number', min: '1', max: '5000', value: f.maxLength || '' });
      max.addEventListener('input', () => {
        f.maxLength = Number(max.value) || undefined;
        scheduleSave();
      });
      parts.push(h('label', { class: 'consent', for: 'f-multi', style: { borderColor: 'var(--line)', background: '#fff' } }, multi, h('span', { text: 'Several lines allowed' })), h('label', { for: 'f-max' }, 'Character limit (optional)'), max);
    }
    if (anchored && f.type !== 'checkbox') {
      const width = h('input', { id: 'f-width', type: 'range', min: '30', max: '480', step: '5', value: f.inlineWidth || FIELD_TYPES[f.type].w });
      width.addEventListener('change', () => {
        f.inlineWidth = Number(width.value);
        changed();
      });
      parts.push(h('label', { for: 'f-width' }, 'Box width on the page'), width);
    }
    body.replaceChildren(...parts);
  };
  paint();
  const remove = async () => {
    A.draft.fields = A.draft.fields.filter((x) => x.n !== f.n);
    A.draft.body = replaceFieldToken(A.draft.body, f.n, '[____]');
    A.selected = null;
    closeSheet();
    await changed();
  };
  const unpin = async () => {
    const r = fieldRect(f, A.layout);
    A.draft.body = replaceFieldToken(A.draft.body, f.n, '[____]');
    Object.assign(f, { page: r.page, x: pct(r.x, PAGE.w), y: pct(r.y - 2, PAGE.h), w: pct(r.w, PAGE.w), h: pct(r.h + 4, PAGE.h) });
    closeSheet();
    await changed();
  };
  openSheet(
    `Field ${f.n}: ${FIELD_TYPES[f.type].label}`,
    body,
    [
      h('button', { class: 'btn danger small', type: 'button', onclick: remove }, 'Delete'),
      anchored ? h('button', { class: 'btn small', type: 'button', onclick: unpin }, 'Unpin from text') : null,
      h('button', { class: 'btn primary', type: 'button', onclick: () => (closeSheet(), (A.selected = null), changed()) }, 'Done'),
    ].filter(Boolean),
    { onClose: () => ((A.selected = null), changed()) },
  );
}

// ---------- Signers tab ----------

function renderSigners(body) {
  const list = h('div');
  const paint = () => {
    list.replaceChildren(
      ...A.draft.signers.map((s, i) => {
        const role = h('input', { value: s.role, maxlength: '40', id: `r${i}` });
        role.addEventListener('change', () => {
          const old = s.role;
          const next = role.value.trim() || old;
          if (next === SENDER_ROLE || A.draft.signers.some((x, j) => j !== i && x.role === next)) {
            toast('Each signer needs a different role name.');
            role.value = old;
            return;
          }
          s.role = next;
          for (const f of A.draft.fields) if (f.role === old) f.role = next;
          if (A.activeRole === old) A.activeRole = next;
          scheduleSave();
        });
        const field = (key, label, attrs = {}) => {
          const inp = h('input', { value: s[key] || '', id: `${key}${i}`, ...attrs });
          inp.addEventListener('input', () => {
            s[key] = inp.value;
            scheduleSave();
          });
          return [h('label', { for: `${key}${i}` }, label), inp];
        };
        const count = A.draft.fields.filter((f) => f.role === s.role).length;
        const card = h(
          'div',
          { class: 'card' },
          h('label', { for: `r${i}` }, 'Role (for example Client)'),
          role,
          ...field('name', 'Full name', { autocomplete: 'off' }),
          ...field('email', 'Email', { type: 'email', inputmode: 'email', autocapitalize: 'off' }),
          ...field('phone', 'Mobile phone (optional, for texting the link)', { type: 'tel' }),
          h('p', { class: 'hint', text: `${count} field${count === 1 ? '' : 's'} assigned.` }),
          A.draft.signers.length > 1
            ? h('button', { class: 'btn small danger', type: 'button', onclick: () => {
                if (count) {
                  toast('Move or delete this signer\'s fields first.');
                  return;
                }
                A.draft.signers.splice(i, 1);
                scheduleSave();
                paint();
              } }, 'Remove signer')
            : null,
        );
        card.style.borderLeft = `6px solid ${roleColor(s.role, roles())}`;
        return card;
      }),
    );
  };
  paint();
  body.append(
    h('p', { class: 'hint', text: 'Each signer gets a private link. You sign through your own link too.' }),
    list,
    A.draft.signers.length < 10
      ? h('button', { class: 'btn', type: 'button', onclick: () => {
          let k = A.draft.signers.length + 1;
          while (A.draft.signers.some((s) => s.role === `Signer ${k}`)) k += 1;
          A.draft.signers.push({ role: `Signer ${k}`, name: '', email: '', phone: '' });
          scheduleSave();
          paint();
        } }, 'Add signer')
      : null,
  );
}

// ---------- Send tab ----------

function previewRecord() {
  return {
    app: CONFIG.APP_NAME,
    id: A.doc.id,
    title: A.draft.title,
    body: A.draft.body,
    fields: A.draft.fields,
    values: { ...senderValueMap(), ...Object.fromEntries(A.values.map((v) => [v.n, v.value])) },
    created_at: A.doc.created_at,
    sent_at: A.doc.sent_at,
  };
}

function shareRow(link, title) {
  const msg = `Here is the ${title} to review and sign: ${link.url}`;
  const digits = String(link.phone || '').replace(/[^\d+]/g, '');
  return h(
    'div',
    { class: 'card' },
    h('strong', { text: `${link.name || link.role} (${link.role})` }),
    h('div', { class: 'linkbox', text: link.url }),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: async () => {
        try {
          await navigator.clipboard.writeText(link.url);
          toast('Link copied.');
        } catch {
          toast('Copy failed. Press and hold the link to copy it.');
        }
      } }, 'Copy'),
      navigator.share ? h('button', { class: 'btn small', type: 'button', onclick: () => navigator.share({ title, text: msg }).catch(() => {}) }, 'Share') : null,
      h('a', { class: 'btn small', href: `sms:${digits}?&body=${encodeURIComponent(msg)}` }, 'Text'),
      h('a', { class: 'btn small', href: `mailto:${encodeURIComponent(link.email || '')}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(msg)}` }, 'Email'),
      h('a', { class: 'btn small', href: link.url, target: '_blank', rel: 'noopener' }, 'Open'),
    ),
    h('p', { class: 'hint', text: `Works until ${when(link.expires_at)}. Text and Email open your own apps with the message ready; you press send.` }),
  );
}

function renderSend(body) {
  const problems = sendProblems({ ...A.draft }, A.layout.pages.length);
  const days = h('select', { id: 'days' }, ...[7, 14, 30].map((d) => h('option', { value: d, selected: d === 14 }, `${d} days`)));
  const btn = h('button', { class: 'btn primary', type: 'button', disabled: problems.length > 0 }, 'Lock it and make signing links');
  const err = h('p', { class: 'error', role: 'alert' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    err.textContent = '';
    await saveNow();
    try {
      const r = await api('POST', `/api/documents/${A.doc.id}/send`, { body: { expires_days: Number(days.value) } });
      A.links = r.links;
      go(`#/doc/${A.doc.id}/status`);
    } catch (e) {
      if (!fail(e)) err.textContent = e.body?.problems?.join(' ') || e.message;
      btn.disabled = false;
    }
  });
  body.append(
    problems.length
      ? h('div', { class: 'card' }, h('h2', { text: 'Before you can send' }), h('ul', { class: 'problems' }, ...problems.map((p) => h('li', { text: p }))))
      : h('div', { class: 'card' }, h('h2', { text: 'Ready to send' }), h('p', { text: 'Every term is filled in and every signer has a signature field.' })),
    h('div', { class: 'card' }, h('h2', { text: 'Check how it prints' }), h('button', { class: 'btn', type: 'button', onclick: () => savePdf(previewRecord(), 'preview', { audit: false }).catch((e) => toast(e.message)) }, 'Download a preview PDF')),
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Send' }),
      h('p', { text: 'Sending locks the wording, the fields and the signers. Each signer gets a private link. You share the links yourself by text, email or copy.' }),
      h('label', { for: 'days' }, 'Links stop working after'),
      days,
      h('div', { style: { marginTop: '14px' } }, btn),
      err,
    ),
  );
}

// ---------- Status view (after sending) ----------

function renderStatus(body) {
  const d = A.doc;
  const out = h('div');
  const open = ['sent', 'viewed'].includes(d.status);
  const signerCards = d.signers.map((s) =>
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('strong', { text: `${s.name} (${s.role})` }), statusChip(s.status)),
      h('p', { class: 'hint', text: s.email }),
      s.viewed_at ? h('p', { class: 'hint', text: `Opened ${when(s.viewed_at)}` }) : null,
      s.signed_at ? h('p', { class: 'hint', text: `Signed ${when(s.signed_at)}` }) : null,
      s.status === 'declined' ? h('p', { class: 'error', text: `Declined: ${s.decline_reason}` }) : null,
      open && !['signed', 'declined'].includes(s.status)
        ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
            try {
              const r = await api('POST', `/api/documents/${d.id}/signers/${s.id}/link`, { body: { expires_days: 14 } });
              A.links = [r.link];
              renderDoc();
            } catch (e) {
              fail(e);
            }
          } }, 'Make a new link')
        : null,
    ),
  );
  const actions = h('div', { class: 'row' });
  if (d.status === 'signed') {
    actions.append(
      h('button', { class: 'btn gold', type: 'button', onclick: async () => {
        out.replaceChildren(h('p', { class: 'hint', text: 'Building the PDF...' }));
        try {
          const { record } = await api('GET', `/api/documents/${d.id}/record`);
          const { hash, url } = await savePdf(record);
          out.replaceChildren(h('p', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open the PDF'), ' if the download did not start.'), h('p', { class: 'hint', text: 'File fingerprint (SHA-256). The signer\'s copy shows the same one:' }), h('p', { class: 'mono', text: hash }));
        } catch (e) {
          fail(e);
        }
      } }, 'Download signed PDF'),
    );
  } else {
    actions.append(h('button', { class: 'btn', type: 'button', onclick: () => savePdf(previewRecord(), 'preview', { audit: false }).catch((e) => toast(e.message)) }, 'Preview PDF'));
  }
  if (!['signed', 'void'].includes(d.status)) {
    const voidBtn = h('button', { class: 'btn danger', type: 'button' }, 'Void');
    let armed = false;
    voidBtn.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        voidBtn.textContent = 'Tap again to void';
        setTimeout(() => {
          armed = false;
          voidBtn.textContent = 'Void';
        }, 4000);
        return;
      }
      try {
        loadDocResponse(await api('POST', `/api/documents/${d.id}/void`, { body: {} }));
        renderDoc();
      } catch (e) {
        fail(e);
      }
    });
    actions.append(voidBtn);
  }
  actions.append(
    h('button', { class: 'btn', type: 'button', onclick: () => {
      const name = h('input', { id: 'tpl-name', value: d.title.slice(0, 120) });
      const { close } = openSheet('Save as template', h('div', {}, h('label', { for: 'tpl-name' }, 'Template name'), name), [
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try {
            await api('POST', '/api/templates', { body: { name: name.value, document_id: d.id } });
            close();
            toast('Template saved.');
          } catch (e) {
            fail(e);
          }
        } }, 'Save'),
      ]);
    } }, 'Save as template'),
  );
  const timeline = h(
    'ul',
    { class: 'timeline' },
    ...[...A.events].reverse().map((e) => h('li', {}, h('span', { class: 'when', text: `${when(e.at)}${e.ip ? `  |  IP ${e.ip}` : ''}${e.device ? `  |  ${e.device}` : ''}` }), describeEvent(e, { signers: d.signers }))),
  );
  body.append(
    A.links.length ? h('div', {}, h('h2', { text: 'Signing links' }), h('p', { class: 'hint', text: 'These show once. If one gets lost, make a new link below; the old one stops working.' }), ...A.links.map((l) => shareRow(l, d.title))) : null,
    d.sent_at ? h('p', { class: 'hint', text: `Sent ${when(d.sent_at)}. Document fingerprint ${String(d.doc_sha256 || '').slice(0, 16)}...` }) : null,
    h('h2', { text: 'Signers' }),
    ...signerCards,
    actions,
    out,
    h('h2', { text: 'Audit trail' }),
    timeline,
  );
}

// ---------- router ----------

async function route() {
  if (!ownerToken()) {
    showLogin();
    return;
  }
  const m = /^#\/doc\/([a-f0-9]+)(?:\/(\w+))?/.exec(location.hash);
  if (m) {
    const sameDoc = A.doc && A.doc.id === m[1];
    if (sameDoc && m[2] && A.doc.status === 'draft') {
      A.tab = m[2];
      A.selected = null;
      A.armed = null;
      if (m[2] !== 'status') {
        await relayout();
        renderDoc();
        return;
      }
    }
    if (!sameDoc || m[2] !== 'status') A.links = sameDoc ? A.links : [];
    await openDoc(m[1], m[2]);
    return;
  }
  A.doc = null;
  A.links = [];
  showList();
}

window.addEventListener('popstate', route);
document.title = CONFIG.APP_NAME;
route();
