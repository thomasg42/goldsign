// Sender app: sign in with the owner PIN, write or pick a document, drop fields on it, tap Finish document,
// send it to the client by email, sign last, and keep the finished copies.

import { ApiError, api, ownerToken, setOwnerToken } from './api.js';
import { CONFIG } from './config.js';
import { SENDER_COLOR, h, layoutFor, renderPages, roleColor } from './render.js';
import { FIELD_TYPES, SENDER_ROLE, TYPE_KEYS, formatUtc, isImageType } from './shared/fields.js';
import { PAGE, fieldRect, replaceFieldToken, replaceNthBlank } from './shared/layout.js';
import { sendProblems } from './shared/rules.js';
import { firstName, isOwnerSigner, joinNames, signingOrder } from './shared/order.js';
import { describeEvent } from './shared/pdf.js';
import { pdfForEmail, savePdf } from './download.js';

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
  owner: { email: '', name: '' },
  mailReady: false,
  outbox: [],
  copies: [],
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
  const piles = PILES.map(([stage, title]) => [title, A.docs.filter((d) => (d.stage || 'draft') === stage)]).filter(([, docs]) => docs.length);
  const list = A.docs.length
    ? piles.flatMap(([title, docs]) => [
        h('h2', { class: 'pile' }, title, h('span', { class: 'count', text: String(docs.length) })),
        h(
          'ul',
          { class: 'doc-list' },
          ...docs.map((d) =>
            h(
              'li',
              {},
              h(
                'button',
                { type: 'button', onclick: () => go(`#/doc/${d.id}`) },
                h('span', { class: 'title', text: d.title }),
                h('span', { class: 'meta' }, statusChip(d.display_status), '  ', nextStep(d)),
                h('span', { class: 'meta', style: { display: 'block' }, text: d.stage === 'finished' ? `Signed ${when(d.completed_at)}` : `Updated ${when(d.updated_at)}` }),
              ),
            ),
          ),
        ),
      ])
    : [h('p', { class: 'card', text: 'No documents yet. Start one from a template or a blank page.' })];
  screen(
    [h('button', { class: 'btn small', type: 'button', onclick: logout }, 'Sign out')],
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '12px' } }, h('h1', { text: 'All documents' }), h('button', { class: 'btn primary', type: 'button', onclick: newDocument }, 'New document')),
    ...list,
  );
}

// The piles on the document list, in this order. Empty piles are hidden.
const PILES = [
  ['your_turn', 'Your turn to sign'],
  ['draft', 'New documents'],
  ['waiting', 'Out for signing'],
  ['finished', 'Finished: signed by both parties'],
  ['stopped', 'Declined, voided or expired'],
];

function nextStep(d) {
  const signedOthers = d.signers.filter((s) => s.status === 'signed' && !s.is_owner).map((s) => s.name);
  if (d.stage === 'your_turn') return signedOthers.length ? `${joinNames(signedOthers)} signed. Your turn.` : 'Your turn.';
  if (d.stage === 'waiting') return d.next ? `Waiting on ${d.next.name}` : 'Out for signing';
  if (d.stage === 'finished') return `Signed by ${joinNames(d.signers.map((s) => s.name))}`;
  if (d.stage === 'draft') return 'Not sent yet';
  return '';
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
  A.owner = r.owner || A.owner;
  A.mailReady = Boolean(r.mail_ready);
  A.outbox = r.outbox || [];
  A.copies = r.copies || [];
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
// What the builder shows in each box: your filled-in terms, plus what a signer's box starts with.
const boxValueMap = () => ({ ...Object.fromEntries(A.draft.fields.filter((f) => f.role !== SENDER_ROLE && f.prefill !== undefined).map((f) => [f.n, f.prefill])), ...senderValueMap() });
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

// The bottom of every draft tab: one button that checks every box and moves on to sending.
async function finishDocument() {
  await saveNow();
  go(`#/doc/${A.doc.id}/send`);
}

function finishBar() {
  return h('div', { class: 'finish-bar' }, h('button', { class: 'btn primary wide', type: 'button', onclick: finishDocument }, 'Finish document'));
}

function renderDoc() {
  const d = A.doc;
  const tabs = d.status === 'draft' ? [['text', 'Text'], ['fields', 'Fields'], ['signers', 'Signers'], ['send', 'Finish']] : [];
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
  if (d.status === 'draft' && A.tab !== 'send') body.append(finishBar());
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
    h('p', { class: 'hint', text: 'Pick who fills it, then tap a field type and tap the page or a blank line where it goes. You can also drag a type onto the page. Tap a box to edit it. Drag a box to move it. Gold boxes are yours to fill in now: what a box shows is what prints. When every box is right, tap Finish document at the bottom.' }),
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
  // (append and replaceChildren print a null as the word "null", so nulls are filtered out first)
  controls.replaceChildren(
    ...[
      h('div', { class: 'card stack' }, h('strong', { text: 'Who fills the next field' }), rolePick, h('strong', { text: 'Field types' }), palette, h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: fillEveryBlank }, 'Put a field on every blank'), zoom)),
      A.armed ? h('p', { class: 'big-note', role: 'status' }, `Now tap the page where the ${FIELD_TYPES[A.armed].label} field goes.`, ' ', h('button', { class: 'btn small', type: 'button', onclick: () => ((A.armed = null), paintBuilder()) }, 'Cancel')) : null,
    ].filter(Boolean),
  );
  renderPages(pagesEl, A.layout, A.draft.fields, {
    roles: rs,
    values: boxValueMap(),
    // An empty box says so. What a box shows is what prints.
    emptyText: (f) => (f.role === SENDER_ROLE ? `Fill in: ${f.label || FIELD_TYPES[f.type].label}` : f.label || FIELD_TYPES[f.type].label),
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

// The value editor for a box: what you fill in now (id "fv"), or what a signer's box starts with (id "f-pre").
function valueEditor(f, v, onChange, { id = 'fv', title = 'What prints on the document', tick = 'Ticked' } = {}) {
  if (f.type === 'checkbox') {
    const c = h('input', { type: 'checkbox', id });
    c.checked = v === true;
    c.addEventListener('change', () => onChange(c.checked ? true : undefined));
    return h('label', { class: 'consent', for: id }, c, h('span', { text: tick }));
  }
  if (f.type === 'address') {
    const a = v && typeof v === 'object' ? { ...v } : { street: '', city: '', state: '', zip: '' };
    const part = (key, label, attrs = {}) => {
      const i = h('input', { value: a[key] || '', ...attrs });
      i.addEventListener('input', () => {
        a[key] = i.value;
        onChange(Object.values(a).some((x) => String(x || '').trim()) ? { ...a } : undefined);
      });
      return h('label', {}, label, i);
    };
    return h('div', {}, h('strong', { text: title }), part('street', 'Street', { id }), part('city', 'City'), part('state', 'State', { maxlength: '2' }), part('zip', 'ZIP', { inputmode: 'numeric' }));
  }
  const type = { date: 'date', email: 'email', phone: 'tel' }[f.type] || 'text';
  const i = h('input', { type, id, value: typeof v === 'string' ? v : '' });
  i.addEventListener('input', () => onChange(i.value === '' ? undefined : i.value));
  return h('div', {}, h('label', { for: id }, title), i);
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
    const parts = [];
    if (f.role === SENDER_ROLE) {
      // Your term: the value comes first, because it is exactly what prints.
      parts.push(
        valueEditor(f, f.value, (v) => {
          if (v === undefined) delete f.value;
          else f.value = v;
          scheduleSave();
          paintBuilder();
        }),
        h('p', { class: 'hint', text: 'You fill this in now. It prints on the document exactly like this, and the signer cannot change it.' }),
      );
    }
    parts.push(
      h('label', { for: 'f-label' }, f.role === SENDER_ROLE ? 'Name of this box (only you see it)' : 'What the signer is asked'),
      label,
      h('label', { for: 'f-role' }, 'Who fills it'),
      roleSel,
      h('label', { for: 'f-type' }, 'Type'),
      typeSel,
    );
    if (f.role !== SENDER_ROLE) parts.push(h('label', { class: 'consent', for: 'f-req', style: { borderColor: 'var(--line)', background: '#fff' } }, req, h('span', { text: f.type === 'signature' ? 'Required (always, for signatures)' : 'Required' })));
    if (f.role !== SENDER_ROLE && ['full_name', 'company', 'email', 'phone', 'free_text', 'address', 'checkbox'].includes(f.type)) {
      parts.push(
        valueEditor(
          f,
          f.prefill,
          (v) => {
            if (v === undefined) delete f.prefill;
            else f.prefill = v;
            scheduleSave();
            paintBuilder();
          },
          { id: 'f-pre', title: 'Already in the box when they open it (optional, they can change it)', tick: 'Start ticked (they can untick it)' },
        ),
      );
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
  if (f.role === SENDER_ROLE) setTimeout(() => body.querySelector('#fv')?.focus?.(), 30);
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
          isOwnerSigner(s, A.owner.email) ? h('span', { class: 'chip-status signed', text: 'You. You sign last.' }) : null,
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
    ...[
      h('p', { class: 'hint', text: orderSentence(A.draft.signers) }),
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
    ].filter(Boolean),
  );
}

// "Jay Smith (Client) signs first, then you. Then you both get the signed PDF by email."
function orderSentence(signers) {
  const order = signingOrder(signers, A.owner.email);
  const names = order.map((s) => (isOwnerSigner(s, A.owner.email) ? 'you' : `${s.name || s.role} (${s.role})`));
  const youSign = order.some((s) => isOwnerSigner(s, A.owner.email));
  const lead = !order.length
    ? 'Add a signer.'
    : order.length === 1
      ? names[0] === 'you'
        ? 'You sign.'
        : `${names[0]} signs.`
      : `${names[0]} signs first, then ${joinNames(names.slice(1))}.`;
  return `${lead} Each one gets a private link when it is their turn. Then ${youSign && order.length === 2 ? 'you both get' : 'everyone gets'} the signed PDF${A.mailReady ? ' by email' : ''}.`;
}

// ---------- Finish tab ----------

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

// Opens a field's panel from a "Fill in field N" problem.
async function showField(n) {
  await saveNow();
  const hash = `#/doc/${A.doc.id}/fields`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  A.tab = 'fields';
  A.armed = null;
  A.selected = n;
  await relayout();
  renderDoc();
  const f = A.draft.fields.find((x) => x.n === n);
  if (!f) return;
  document.querySelector(`.fbox[data-n="${n}"]`)?.scrollIntoView?.({ block: 'center' });
  openFieldPanel(f);
}

function renderSend(body) {
  const problems = sendProblems({ ...A.draft }, A.layout.pages.length);
  const order = signingOrder(A.draft.signers, A.owner.email);
  const first = order[0];
  const firstLabel = first ? firstName(first.name) || first.role : 'the first signer';
  const days = h('select', { id: 'days' }, ...[7, 14, 30].map((d) => h('option', { value: d, selected: d === 14 }, `${d} days`)));
  const btn = h('button', { class: 'btn primary wide', type: 'button', disabled: problems.length > 0 }, A.mailReady ? `Send to ${firstLabel} by email` : `Lock it and make ${firstLabel}'s link`);
  const err = h('p', { class: 'error', role: 'alert' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Sending...';
    err.textContent = '';
    await saveNow();
    try {
      const r = await api('POST', `/api/documents/${A.doc.id}/send`, { body: { expires_days: Number(days.value) } });
      A.links = r.links;
      go(`#/doc/${A.doc.id}/status`);
    } catch (e) {
      if (!fail(e)) err.textContent = e.body?.problems?.join(' ') || e.message;
      btn.disabled = false;
      btn.textContent = A.mailReady ? `Send to ${firstLabel} by email` : `Lock it and make ${firstLabel}'s link`;
    }
  });
  const steps = order.map((s) =>
    h('li', { text: isOwnerSigner(s, A.owner.email) ? 'You sign last. Your link comes by email when it is your turn, or tap Sign now here.' : `${s.name || s.role} (${s.role}) fills in their boxes and signs${s.email ? `. Link goes to ${s.email}` : ''}.` }),
  );
  steps.push(h('li', { text: `${order.length === 2 && order.some((s) => isOwnerSigner(s, A.owner.email)) ? 'You both get' : 'Everyone gets'} the signed PDF${A.mailReady ? ' by email' : ''}. It lands in Finished.` }));
  body.append(
    problems.length
      ? h(
          'div',
          { class: 'card' },
          h('h2', { text: 'Almost done. Fix these first:' }),
          h(
            'ul',
            { class: 'problems' },
            ...problems.map((p) => {
              const n = /^(?:Fill in field|Field) (\d+)/.exec(p)?.[1];
              const aboutSigners = /signer|email for|name for|role/i.test(p);
              const jump = n
                ? h('button', { class: 'btn small', type: 'button', style: { marginLeft: '8px' }, onclick: () => showField(Number(n)) }, 'Show me')
                : aboutSigners
                  ? h('button', { class: 'btn small', type: 'button', style: { marginLeft: '8px' }, onclick: () => go(`#/doc/${A.doc.id}/signers`) }, 'Go to Signers')
                  : null;
              return h('li', {}, p, jump);
            }),
          ),
        )
      : h('div', { class: 'card' }, h('h2', { text: 'Every box is good to go' }), h('p', { text: 'Every term is filled in and every signer has a signature box.' })),
    h('div', { class: 'card' }, h('h2', { text: 'What happens next' }), h('ol', { class: 'steps' }, ...steps)),
    h('div', { class: 'card' }, h('h2', { text: 'Check how it prints' }), h('button', { class: 'btn', type: 'button', onclick: () => savePdf(previewRecord(), 'preview', { audit: false }).catch((e) => toast(e.message)) }, 'Download a preview PDF')),
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Send it' }),
      h(
        'p',
        { text: A.mailReady ? `Sending locks the wording, the boxes and the signers, then emails ${firstLabel} from your email (${A.owner.email}).` : 'Sending locks the wording, the boxes and the signers. Email is not set up yet, so you share the link yourself (copy, text or your own email app).' },
      ),
      h('label', { for: 'days' }, 'Links stop working after'),
      days,
      h('div', { style: { marginTop: '14px' } }, btn),
      err,
    ),
  );
}

// ---------- Status view (after sending) ----------

const newest = (rows) => rows.reduce((a, b) => (!a || String(b.created_at) >= String(a.created_at) ? b : a), null);

// append() prints a null child as the word "null"; this skips them.
const add = (el, ...kids) => el.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));

// What happened to the newest signing-link email to one signer, in plain words.
function inviteNote(signerId) {
  const row = newest(A.outbox.filter((o) => o.kind === 'invite' && o.signer_id === signerId && !o.cancelled_at));
  if (!row) return null;
  if (row.sent_at) return { ok: true, text: `Link emailed to ${row.to} ${when(row.sent_at)}.` };
  if (row.last_error) return { ok: false, text: `The email to ${row.to} has not gone out (${row.last_error}). It tries again every 10 minutes, or tap Email it again.` };
  return { ok: true, text: `Emailing ${row.to}...` };
}

async function reloadDoc() {
  loadDocResponse(await api('GET', `/api/documents/${A.doc.id}`));
  renderDoc();
}

// Your turn: a fresh link for you, opened right here.
async function signNow(s) {
  try {
    const r = await api('POST', `/api/documents/${A.doc.id}/signers/${s.id}/link`, { body: { expires_days: A.doc.link_days || 14 } });
    location.href = r.link.url;
  } catch (e) {
    fail(e);
  }
}

async function emailAgain(s) {
  try {
    const r = await api('POST', `/api/documents/${A.doc.id}/signers/${s.id}/email`, { body: {} });
    const res = r.emailed.find((e) => !e.skipped);
    toast(res?.ok ? `Emailed ${firstName(s.name) || s.role} a fresh link.` : `That did not go out: ${res?.error || res?.cancelled || 'try again'}.`);
    await reloadDoc();
  } catch (e) {
    fail(e);
  }
}

async function shareLink(s) {
  try {
    const r = await api('POST', `/api/documents/${A.doc.id}/signers/${s.id}/link`, { body: { expires_days: A.doc.link_days || 14 } });
    A.links = [r.link];
    await reloadDoc();
  } catch (e) {
    fail(e);
  }
}

// Builds the finished PDF on this device and emails it to everyone, attached.
async function emailCopies(out, again) {
  out.replaceChildren(h('p', { class: 'hint', text: 'Building the PDF and emailing it...' }));
  try {
    const { record } = await api('GET', `/api/documents/${A.doc.id}/record`);
    const { pdf_b64 } = await pdfForEmail(record);
    const r = await api('POST', `/api/documents/${A.doc.id}/copy`, { body: { pdf_b64, again } });
    const ok = r.emailed.filter((e) => e.ok).map((e) => e.to);
    toast(ok.length ? `Emailed the signed PDF to ${joinNames(ok)}.` : r.mail ? 'Nothing was waiting to go out.' : 'Email is not set up yet.');
    await reloadDoc();
  } catch (e) {
    if (!fail(e)) out.replaceChildren(h('p', { class: 'error', text: e.message }));
  }
}

async function downloadSigned(out) {
  out.replaceChildren(h('p', { class: 'hint', text: 'Building the PDF...' }));
  try {
    const { record } = await api('GET', `/api/documents/${A.doc.id}/record`);
    const { hash, url } = await savePdf(record);
    out.replaceChildren(
      h('p', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open the PDF to print it'), ' if the download did not start.'),
      h('p', { class: 'hint', text: "File fingerprint (SHA-256). The client's copy shows the same one:" }),
      h('p', { class: 'mono', text: hash }),
    );
  } catch (e) {
    fail(e);
  }
}

// Who got the signed copy, from the audit trail and the emails still waiting.
function copyLines() {
  const sent = A.events.filter((e) => e.type === 'email_sent' && e.details?.kind === 'copy');
  const waiting = A.outbox.filter((o) => o.kind === 'copy' && !o.sent_at && !o.cancelled_at);
  return [
    ...sent.map((e) => h('li', { text: `${e.details.to}: emailed ${when(e.at)}, ${e.details.attached ? 'PDF attached' : 'with a download link'}` })),
    ...waiting.map((o) => h('li', { class: o.last_error ? 'error' : null, text: `${o.to}: ${o.last_error ? `not sent yet (${o.last_error}), trying again` : 'waiting for the PDF, goes out within a few minutes'}` })),
  ];
}

function renderStatus(body) {
  const d = A.doc;
  const out = h('div');
  const own = (s) => isOwnerSigner(s, A.owner.email);
  const order = signingOrder(d.signers, A.owner.email);
  const you = order.find(own) || null;
  const waitingOn = d.signers.find((s) => s.turn) || order.find((s) => s.status !== 'signed') || null;
  const both = order.length === 2 && you ? 'you both get' : 'everyone gets';
  const banner = h('div', { class: `card banner ${d.stage || ''}` });
  if (d.stage === 'your_turn') {
    const before = order.filter((s) => s.status === 'signed' && !own(s)).map((s) => s.name);
    banner.append(
      h('h2', { text: before.length ? `${joinNames(before)} signed. Your turn.` : 'Your turn to sign.' }),
      h('p', { text: `Sign and date it to finish. Then ${both} the signed PDF${A.mailReady ? ' by email' : ''}, and it moves to Finished.` }),
      h('button', { class: 'btn gold wide', type: 'button', onclick: () => signNow(you || waitingOn) }, 'Sign now'),
    );
    const note = you ? inviteNote(you.id) : null;
    if (note) banner.append(h('p', { class: note.ok ? 'hint' : 'error', text: note.text }));
  } else if (d.stage === 'waiting' || d.display_status === 'expired') {
    const who = waitingOn;
    banner.append(h('h2', { text: d.display_status === 'expired' ? `${who ? `${who.name}'s` : 'The'} link ran out` : `Waiting on ${who ? who.name : 'the signers'}` }));
    const note = who ? inviteNote(who.id) : null;
    if (note) banner.append(h('p', { class: note.ok ? 'hint' : 'error', text: note.text }));
    else if (!A.mailReady) banner.append(h('p', { class: 'hint', text: 'Email is not set up yet, so share the link yourself.' }));
    if (you && who && !own(who)) banner.append(h('p', { class: 'hint', text: `When ${firstName(who.name) || who.role} finishes, it comes back to you${A.mailReady ? ' by email' : ''} to sign.` }));
    if (who) {
      banner.append(
        h(
          'div',
          { class: 'row' },
          A.mailReady ? h('button', { class: 'btn small', type: 'button', onclick: () => emailAgain(who) }, 'Email it again') : null,
          h('button', { class: 'btn small', type: 'button', onclick: () => shareLink(who) }, 'Share a link yourself'),
        ),
      );
    }
  } else if (d.stage === 'finished') {
    const lines = copyLines();
    add(
      banner,
      h('h2', { text: `Finished. Signed by ${order.length === 2 ? 'both parties' : 'everyone'}.` }),
      h('p', { text: `${joinNames(order.map((s) => s.name))} signed. Completed ${when(d.completed_at)}.` }),
      h('button', { class: 'btn gold wide', type: 'button', onclick: () => downloadSigned(out) }, 'Download or print the PDF'),
      h('h3', { text: 'Signed copies' }),
      lines.length ? h('ul', { class: 'copies' }, ...lines) : h('p', { class: 'hint', text: A.mailReady ? 'Not emailed yet.' : 'Email is not set up yet. Download the PDF and send it yourself.' }),
      A.mailReady ? h('button', { class: 'btn small', type: 'button', onclick: () => emailCopies(out, true) }, lines.length ? 'Email the signed PDF to everyone again' : 'Email the signed PDF to everyone') : null,
      out,
    );
  } else if (d.status === 'declined') {
    const s = d.signers.find((x) => x.status === 'declined');
    add(banner, h('h2', { text: `${s ? s.name : 'A signer'} declined` }), s?.decline_reason ? h('p', { text: `Reason: ${s.decline_reason}` }) : null);
  } else if (d.status === 'void') {
    banner.append(h('h2', { text: 'You voided this document' }));
  }
  const steps = h(
    'ol',
    { class: 'steps' },
    ...order.map((s) =>
      h(
        'li',
        {},
        h('strong', { text: own(s) ? `You (${s.role})` : `${s.name} (${s.role})` }),
        ' ',
        statusChip(s.status === 'pending' ? 'waiting' : s.status),
        h('span', {
          class: 'hint',
          style: { display: 'block' },
          text: [s.email, s.viewed_at ? `opened ${when(s.viewed_at)}` : '', s.signed_at ? `signed ${when(s.signed_at)}` : '', s.status === 'declined' ? `declined: ${s.decline_reason}` : ''].filter(Boolean).join('  |  '),
        }),
      ),
    ),
  );
  const actions = h('div', { class: 'row' });
  if (d.status !== 'signed') actions.append(h('button', { class: 'btn', type: 'button', onclick: () => savePdf(previewRecord(), 'preview', { audit: false }).catch((e) => toast(e.message)) }, 'Preview PDF'));
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
  add(
    body,
    banner,
    A.links.length ? h('div', {}, h('h2', { text: 'Link to share yourself' }), h('p', { class: 'hint', text: 'This shows once. If it gets lost, make a new one; the old one stops working.' }), ...A.links.map((l) => shareRow(l, d.title))) : null,
    d.sent_at ? h('p', { class: 'hint', text: `Sent ${when(d.sent_at)}. Document fingerprint ${String(d.doc_sha256 || '').slice(0, 16)}...` }) : null,
    h('h2', { text: 'Who signs, in order' }),
    steps,
    actions,
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
