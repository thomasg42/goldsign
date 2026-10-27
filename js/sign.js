// Signer page. No account: the link's code (after #t=) is the key. Built for a phone first.
// The signer taps straight into their boxes on the document and types, then taps Finish at the bottom.
// #c=<code> opens the download page for a finished document instead (the link in the signed-copy email).

import { ApiError, api, timezone } from './api.js';
import { CONFIG } from './config.js';
import { h, layoutFor, renderPages, renderReader } from './render.js';
import { FIELD_TYPES, displayValue, formatDate, isImageType, validateValue } from './shared/fields.js';
import { readingOrder } from './shared/layout.js';
import { sha256Hex } from './shared/canon.js';
import { firstName, joinNames } from './shared/order.js';
import { SCRIPT_FONTS, drawPad, typedPng } from './sigpad.js';
import { pdfForEmail, savePdf } from './download.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('t') || '';
const copyToken = params.get('c') || '';

const S = {
  session: null,
  layout: null,
  mine: [],
  answers: {},
  errors: {},
  view: 'text',
  started: false,
  draftKey: null,
};

function topbar() {
  return h('header', { class: 'topbar' }, h('div', { class: 'brand' }, CONFIG.APP_NAME.replace(/Sign$/, ''), h('span', { text: /Sign$/.test(CONFIG.APP_NAME) ? 'Sign' : '' })), h('div', { class: 'spacer' }));
}

function screen(...children) {
  closeSheet();
  root.replaceChildren(topbar(), h('main', { class: 'wrap' }, ...children));
  window.scrollTo(0, 0);
}

function message(title, text, ...extra) {
  screen(h('div', { class: 'card center' }, h('h1', { text: title }), h('p', { class: 'big-note', text }), ...extra));
}

// ---------- draft answers kept on this phone until signing ----------

function saveDraft() {
  try {
    if (S.draftKey) localStorage.setItem(S.draftKey, JSON.stringify(S.answers));
  } catch {
    /* storage full or blocked: answers stay in memory */
  }
}

function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(S.draftKey) || '{}') || {};
  } catch {
    return {};
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(S.draftKey);
  } catch {
    /* nothing to clear */
  }
}

// ---------- helpers ----------

const has = (f, v) => !(v === undefined || v === null || v === '' || (f.type === 'checkbox' && v !== true) || (isImageType(f.type) && !v?.png));
const needed = (f) => f.required || f.type === 'signature';
const done = (f) => {
  if (f.type === 'date' && !f.allowChange) return true;
  if (!needed(f)) return S.answers[f.n] !== undefined && (!has(f, S.answers[f.n]) || validateValue(f, S.answers[f.n]).ok);
  return has(f, S.answers[f.n]) && validateValue(f, S.answers[f.n]).ok;
};
const doneCount = () => S.mine.filter(done).length;
const allRequiredDone = () => S.mine.every((f) => (needed(f) ? done(f) : !has(f, S.answers[f.n]) || validateValue(f, S.answers[f.n]).ok));
const mergedValues = () => {
  const v = { ...S.session.values };
  for (const f of S.mine) {
    if (f.type === 'date' && !f.allowChange) v[f.n] = S.session.today;
    else if (S.answers[f.n] !== undefined) v[f.n] = S.answers[f.n];
  }
  return v;
};

// Who the finished document goes to next, in the button's own words.
function finishLabel() {
  const after = S.session.after_me;
  if (after) return after.is_owner ? `Finish and send back to ${firstName(after.name)}` : `Finish and send to ${firstName(after.name)}`;
  const others = S.session.roles.filter((r) => r.role !== S.session.signer.role).map((r) => firstName(r.name));
  return others.length ? `Finish and send to ${joinNames(others)}` : 'Finish';
}

function whatHappensNext() {
  const s = S.session;
  const by = s.mail ? ' by email' : '';
  const after = s.after_me;
  if (after?.is_owner) return `This signs the document with the mark you made and sends it back to ${firstName(after.name)}. When ${firstName(after.name)} signs, you both get the signed copy${by}.`;
  if (after) return `This signs the document with the mark you made and sends it to ${after.name} to sign. Everyone gets the signed copy${by} at the end.`;
  const others = s.roles.filter((r) => r.role !== s.signer.role).map((r) => firstName(r.name));
  return `This finishes the document. ${others.length ? `${joinNames(others)} and you get` : 'You get'} the signed PDF${by}.`;
}

// ---------- start ----------

async function start() {
  if (copyToken) return startCopy();
  if (!token) {
    message('This link is incomplete', 'The signing code is missing from the link. Open the link exactly as it was sent to you, or ask the sender for a new one.');
    return;
  }
  screen(h('p', { class: 'center big-note', text: 'Opening your document...' }));
  try {
    S.session = await api('POST', '/api/sign/open', { signToken: token, body: { timezone: timezone() } });
  } catch (err) {
    message('This link cannot be used', err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    return;
  }
  S.draftKey = `sign-draft-${(await sha256Hex(token)).slice(0, 20)}`;
  const doc = S.session.document;
  document.title = `${doc.title} | ${CONFIG.APP_NAME}`;
  S.layout = await layoutFor(doc.body, doc.fields);
  if (S.session.state === 'signed') return showSigned();
  if (S.session.state === 'declined') return message('You declined this document', 'The sender can see your reason. If that was a mistake, ask them to send a new one.');
  S.mine = readingOrder(
    doc.fields.filter((f) => f.role === S.session.signer.role),
    S.layout,
  );
  const draft = loadDraft();
  for (const f of S.mine) {
    if (draft[f.n] !== undefined) S.answers[f.n] = draft[f.n];
    else if (f.prefill !== undefined) S.answers[f.n] = f.prefill; // what the sender pre-filled is already in the box
    else if (f.type === 'date') S.answers[f.n] = S.session.today;
  }
  showMain();
}

// ---------- main document screen ----------

function showMain({ keepScroll = false } = {}) {
  const y = window.scrollY || 0;
  const doc = S.session.document;
  const count = S.mine.filter((f) => !(f.type === 'date' && !f.allowChange)).length;
  const from = S.session.is_owner ? '' : `${S.session.owner_name || S.session.sender_name || 'The sender'} sent you this document to sign. `;
  const intro = !S.started
    ? h(
        'div',
        { class: 'card' },
        h('p', { class: 'big-note' }, S.session.is_owner ? 'Your turn to sign.' : `${from.trim()}`),
        h('p', {}, `Your boxes are outlined in color. Tap a box and type, tick or sign. ${count} ${count === 1 ? 'box needs' : 'boxes need'} you. Then tap "${finishLabel()}" at the bottom.`),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => focusNext() }, 'Start')),
      )
    : null;
  const viewSwitch = h(
    'div',
    { class: 'row' },
    h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'How to show the document' },
      h('button', { type: 'button', 'aria-pressed': String(S.view === 'text'), onclick: () => ((S.view = 'text'), showMain()) }, 'Easy reading'),
      h('button', { type: 'button', 'aria-pressed': String(S.view === 'pages'), onclick: () => ((S.view = 'pages'), showMain()) }, 'Page view'),
    ),
  );
  const docEl = h('div', { class: S.view === 'text' ? 'reader' : 'pages', id: 'doc' });
  screen(
    h('h1', { text: doc.title }),
    h('p', { class: 'hint' }, `For ${S.session.signer.name} (${S.session.signer.role})`),
    intro,
    viewSwitch,
    docEl,
    h('p', { class: 'center' }, h('button', { class: 'btn link', type: 'button', onclick: openDecline }, 'I do not want to sign this')),
  );
  const isMine = (f) => f.role === S.session.signer.role;
  if (S.view === 'text') {
    renderReader(docEl, doc.body, doc.fields, S.layout, { roles: S.session.roles.map((r) => r.role), values: mergedValues(), isMine, mineEl: inlineField });
  } else {
    renderPages(docEl, S.layout, doc.fields, { roles: S.session.roles.map((r) => r.role), values: mergedValues(), isMine, showEmpty: true, title: doc.title });
    docEl.addEventListener('click', (e) => {
      const box = e.target.closest('.fbox[data-n]');
      const f = box && S.mine.find((x) => x.n === Number(box.dataset.n));
      if (f) openField(f);
    });
  }
  stickyBar();
  if (keepScroll) window.scrollTo(0, y);
}

// ---------- the signer's own boxes, typed into in place ----------

const INLINE_WIDTH = { email: '16em', phone: '9.5em', full_name: '12em', company: '12em', free_text: '12em', date: '10.5em' };

function inlineField(f) {
  const v = S.answers[f.n];
  const label = f.label || FIELD_TYPES[f.type].prompt;
  if (f.type === 'date' && !f.allowChange) {
    return h('span', { class: 'fchip done', 'data-n': f.n, title: label }, `${formatDate(S.session.today)} (today)`);
  }
  if (f.type === 'checkbox') {
    const c = h('input', { type: 'checkbox', 'aria-label': label });
    c.checked = v === true;
    const text = h('span', { text: c.checked ? 'Ticked' : 'Tap to tick' });
    const el = h('label', { class: `fchip tick${c.checked ? ' done' : ''}`, 'data-n': f.n }, c, text);
    c.addEventListener('change', () => {
      S.answers[f.n] = c.checked;
      text.textContent = c.checked ? 'Ticked' : 'Tap to tick';
      el.classList.toggle('done', c.checked);
      changed(f);
    });
    return el;
  }
  if (isImageType(f.type) || f.type === 'address') {
    // A mark or a whole address needs more room than a line of text: these open a panel.
    const filled = has(f, v);
    const inner = filled && isImageType(f.type) ? h('img', { src: v.png, alt: label }) : h('span', { text: filled ? displayValue(f, validateValue(f, v).value ?? v) : label });
    const el = h('button', { class: `fchip ${filled ? 'done' : 'todo'}`, type: 'button', 'data-n': f.n }, inner);
    el.addEventListener('click', () => openField(f));
    return el;
  }
  const type = { email: 'email', phone: 'tel', date: 'date' }[f.type] || 'text';
  const attrs = {
    full_name: { autocomplete: 'name', autocapitalize: 'words' },
    company: { autocomplete: 'organization' },
    email: { autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false' },
    phone: { autocomplete: 'tel', inputmode: 'tel' },
  }[f.type] || {};
  const multi = f.type === 'free_text' && f.multiline;
  const input = multi ? h('textarea', { rows: '3', maxlength: f.maxLength || null }) : h('input', { type, ...attrs, maxlength: f.maxLength || null });
  input.value = typeof v === 'string' ? v : '';
  input.setAttribute('aria-label', label);
  if (type !== 'date') input.setAttribute('placeholder', label);
  if (!multi) input.style.width = INLINE_WIDTH[f.type] || '12em';
  const err = h('span', { class: 'ferr', role: 'alert', text: S.errors[f.n] || '' });
  const el = h('span', { class: `fchip fin${multi ? ' multi' : ''}${S.errors[f.n] ? ' bad' : ''}${done(f) && has(f, v) ? ' done' : ''}`, 'data-n': f.n }, input, err);
  const check = () => {
    const value = S.answers[f.n];
    const result = has(f, value) ? validateValue(f, value) : { ok: true };
    if (result.ok) delete S.errors[f.n];
    else S.errors[f.n] = result.error;
    err.textContent = S.errors[f.n] || '';
    el.classList.toggle('bad', Boolean(S.errors[f.n]));
    el.classList.toggle('done', done(f) && has(f, value));
  };
  input.addEventListener('input', () => {
    S.answers[f.n] = input.value;
    if (S.errors[f.n]) check();
    else el.classList.toggle('done', done(f) && has(f, input.value));
    changed(f);
  });
  input.addEventListener('blur', check);
  input.addEventListener('change', check);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !multi) {
      e.preventDefault();
      check();
      focusNext(f);
    }
  });
  return el;
}

function changed() {
  S.started = true;
  saveDraft();
  stickyBar();
}

function stickyBar() {
  document.querySelector('.sticky-bar')?.remove();
  const n = doneCount();
  const total = S.mine.length;
  const ready = allRequiredDone();
  const bar = h(
    'div',
    { class: 'sticky-bar' },
    h('div', { class: 'progress' }, `${n} of ${total} done`, h('div', { class: 'bar' }, h('span', { style: { width: `${total ? (n / total) * 100 : 100}%` } }))),
    ready
      ? h('button', { class: 'btn primary finish', type: 'button', onclick: openFinish }, finishLabel())
      : h('button', { class: 'btn primary', type: 'button', onclick: () => focusNext() }, n ? 'Next' : 'Start'),
  );
  document.body.append(bar);
}

// Takes the signer to the next box that still needs them: the cursor goes in, or the panel opens.
function focusNext(after) {
  S.started = true;
  const order = S.mine;
  const startAt = after ? order.findIndex((f) => f.n === after.n) + 1 : 0;
  const pick = [...order.slice(startAt), ...order.slice(0, startAt)].find((f) => !done(f) || S.errors[f.n]);
  if (!pick) {
    document.activeElement?.blur?.();
    stickyBar();
    return;
  }
  goTo(pick);
}

function goTo(f) {
  if (S.view !== 'text') {
    openField(f, { chain: true });
    return;
  }
  const el = document.querySelector(`#doc [data-n="${f.n}"]`);
  if (!el) {
    openField(f, { chain: true });
    return;
  }
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  const input = el.querySelector('input, textarea');
  if (input && input.type !== 'checkbox') input.focus?.({ preventScroll: true });
  else if (input) {
    el.classList.add('current');
    setTimeout(() => el.classList.remove('current'), 1600);
  } else openField(f, { chain: true });
}

// ---------- the panel for marks, addresses and the page view ----------

let sheetCleanup = null;
function closeSheet() {
  document.querySelector('.sheet')?.remove();
  document.querySelector('.sheet-backdrop')?.remove();
  sheetCleanup?.();
  sheetCleanup = null;
}

function openSheet(title, body, actions) {
  closeSheet();
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: closeSheet });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', { text: title }), body, h('div', { class: 'row end', style: { marginTop: '16px' } }, ...actions));
  const onKey = (e) => {
    if (e.key === 'Escape') closeSheet();
  };
  document.addEventListener('keydown', onKey);
  sheetCleanup = () => document.removeEventListener('keydown', onKey);
  document.body.append(backdrop, sheet);
  setTimeout(() => sheet.querySelector('input:not([type=checkbox]), textarea, button.primary')?.focus(), 30);
  return sheet;
}

function inputFor(f, current) {
  const t = f.type;
  if (t === 'date' && !f.allowChange) {
    return { el: h('p', { class: 'big-note' }, `Filled in for you with today's date: ${formatDate(S.session.today)}.`), read: () => S.session.today };
  }
  if (t === 'date') {
    const i = h('input', { type: 'date', value: current || S.session.today, 'aria-label': f.label || 'Date' });
    return { el: i, read: () => i.value };
  }
  if (t === 'checkbox') {
    const c = h('input', { type: 'checkbox', id: `cb${f.n}` });
    c.checked = current === true;
    return { el: h('label', { class: 'consent', for: `cb${f.n}` }, c, h('span', { text: f.label || 'Tick to agree' })), read: () => c.checked };
  }
  if (t === 'address') {
    const a = current && typeof current === 'object' ? current : {};
    const street = h('input', { autocomplete: 'address-line1', value: a.street || '' });
    const city = h('input', { autocomplete: 'address-level2', value: a.city || '' });
    const state = h('input', { autocomplete: 'address-level1', maxlength: '2', value: a.state || '', style: { textTransform: 'uppercase' } });
    const zip = h('input', { autocomplete: 'postal-code', inputmode: 'numeric', maxlength: '10', value: a.zip || '' });
    const el = h(
      'div',
      {},
      h('label', {}, 'Street', street),
      h('label', {}, 'City', city),
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('label', { style: { flex: '1' } }, 'State', state), h('label', { style: { flex: '1.4' } }, 'ZIP', zip)),
    );
    return { el, read: () => ({ street: street.value, city: city.value, state: state.value, zip: zip.value }) };
  }
  if (isImageType(t)) return signatureInput(f, current);
  const attrs = {
    full_name: { autocomplete: 'name', autocapitalize: 'words' },
    company: { autocomplete: 'organization' },
    email: { type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off' },
    phone: { type: 'tel', autocomplete: 'tel', inputmode: 'tel' },
    free_text: {},
  }[t] || {};
  const i = f.type === 'free_text' && f.multiline ? h('textarea', { style: { minHeight: '140px' }, maxlength: f.maxLength || null }) : h('input', { type: 'text', ...attrs, maxlength: f.maxLength || null });
  i.value = current ?? '';
  i.setAttribute('aria-label', f.label || FIELD_TYPES[t].prompt);
  return { el: i, read: () => i.value };
}

function signatureInput(f, current) {
  let mode = current?.kind === 'typed' ? 'type' : 'draw';
  const initials = f.type === 'initials';
  const defaultText = initials
    ? S.session.signer.name
        .split(/\s+/)
        .map((w) => w[0] || '')
        .join('')
        .toUpperCase()
    : S.session.signer.name;
  let font = current?.font && SCRIPT_FONTS.includes(current.font) ? current.font : SCRIPT_FONTS[0];
  const pad = drawPad();
  const text = h('input', { type: 'text', value: current?.text || defaultText, autocomplete: initials ? 'off' : 'name', 'aria-label': initials ? 'Type your initials' : 'Type your name' });
  const choices = h('div', { class: 'font-choices' });
  const paintChoices = () => {
    choices.replaceChildren(
      ...SCRIPT_FONTS.map((name) =>
        h('button', { type: 'button', 'aria-pressed': String(name === font), style: { fontFamily: `"${name}", cursive` }, onclick: () => ((font = name), paintChoices()) }, text.value || defaultText),
      ),
    );
  };
  text.addEventListener('input', paintChoices);
  paintChoices();
  const drawBox = h('div', {}, pad.el, h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn small', type: 'button', onclick: pad.clear }, 'Clear'), h('span', { class: 'hint', text: 'Use your finger. Sign above the line.' })));
  const typeBox = h('div', {}, text, h('p', { class: 'hint', text: 'Pick a style:' }), choices);
  const body = h('div');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'How to make your mark' });
  const paint = () => {
    seg.replaceChildren(
      h('button', { type: 'button', 'aria-pressed': String(mode === 'draw'), onclick: () => ((mode = 'draw'), paint()) }, 'Draw'),
      h('button', { type: 'button', 'aria-pressed': String(mode === 'type'), onclick: () => ((mode = 'type'), paint()) }, 'Type'),
    );
    body.replaceChildren(mode === 'draw' ? drawBox : typeBox);
    if (mode === 'draw') pad.mount();
  };
  paint();
  const resize = () => mode === 'draw' && pad.resize();
  window.addEventListener('resize', resize);
  return {
    el: h('div', {}, seg, h('div', { style: { marginTop: '12px' } }, body), current?.png ? h('p', { class: 'hint', text: 'Saved mark shown on the document. Draw or type again to replace it.' }) : null),
    read: async () => {
      if (mode === 'draw') {
        const png = pad.toPng();
        if (!png) return current?.kind === 'drawn' ? current : null;
        return { kind: 'drawn', png };
      }
      const value = text.value.trim();
      if (!value) return null;
      return { kind: 'typed', text: value, font, png: await typedPng(value, font) };
    },
    cleanup: () => window.removeEventListener('resize', resize),
  };
}

function openField(f, { chain = false } = {}) {
  const index = S.mine.findIndex((x) => x.n === f.n) + 1;
  const input = inputFor(f, S.answers[f.n]);
  const err = h('p', { class: 'error', role: 'alert', text: S.errors[f.n] || '' });
  const prompt = f.label || FIELD_TYPES[f.type].prompt;
  const save = async () => {
    const raw = await input.read();
    const check = validateValue(f, raw);
    if (!check.ok) {
      err.textContent = check.error;
      return;
    }
    S.answers[f.n] = check.value;
    delete S.errors[f.n];
    S.started = true;
    saveDraft();
    input.cleanup?.();
    closeSheet();
    showMain({ keepScroll: true });
    if (chain) focusNext(f);
  };
  const sheet = openSheet(
    prompt,
    h('div', {}, h('p', { class: 'hint' }, `Item ${index} of ${S.mine.length}  |  ${needed(f) ? 'Required' : 'Optional'}`), input.el, err),
    [
      h('button', { class: 'btn', type: 'button', onclick: () => (input.cleanup?.(), closeSheet()) }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: save }, chain ? 'Save and next' : 'Save'),
    ],
  );
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      e.preventDefault();
      save();
    }
  });
}

// ---------- finish: consent, sign, send on ----------

function openFinish() {
  const missing = S.mine.find((f) => (needed(f) && !done(f)) || S.errors[f.n]);
  if (missing) {
    goTo(missing);
    return;
  }
  const label = finishLabel();
  const consentBox = h('input', { type: 'checkbox', id: 'consent' });
  const btn = h('button', { class: 'btn primary', type: 'button', disabled: true }, label);
  const err = h('p', { class: 'error', role: 'alert' });
  consentBox.addEventListener('change', () => {
    btn.disabled = !consentBox.checked;
  });
  btn.addEventListener('click', () => submit(btn, err, label));
  openSheet(label, h('div', {}, h('p', { text: whatHappensNext() }), h('label', { class: 'consent', for: 'consent' }, consentBox, h('span', { text: S.session.consent.text })), err), [
    h('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Back'),
    btn,
  ]);
}

async function submit(btn, err, label) {
  btn.disabled = true;
  btn.textContent = 'Signing...';
  err.textContent = '';
  try {
    await api('POST', '/api/sign/submit', {
      signToken: token,
      body: { values: S.answers, consent: true, consent_version: S.session.consent.version, timezone: timezone() },
    });
    clearDraft();
    S.session = await api('POST', '/api/sign/open', { signToken: token, body: { timezone: timezone() } });
    showSigned(true);
  } catch (e) {
    if (e instanceof ApiError && e.body.fieldErrors) {
      S.errors = e.body.fieldErrors;
      closeSheet();
      showMain({ keepScroll: true });
      const first = S.mine.find((f) => S.errors[f.n]);
      if (first) goTo(first);
      return;
    }
    err.textContent = e.message || 'Signing failed. Try again.';
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- after signing ----------

function showSigned(justNow = false) {
  document.querySelector('.sticky-bar')?.remove();
  const s = S.session;
  const complete = s.document.status === 'signed';
  const out = h('div');
  const back = s.app_url ? h('p', { style: { marginTop: '14px' } }, h('a', { class: 'btn', href: s.app_url }, 'Back to your documents')) : null;
  if (!complete) {
    const who = s.waiting_on;
    const name = who ? (who.is_owner ? firstName(who.name) : who.name) : 'the others';
    screen(
      h(
        'div',
        { class: 'card center' },
        h('h1', { text: justNow ? `Done. Sent ${who?.is_owner ? 'back ' : ''}to ${name}.` : 'You already signed this' }),
        h('p', { class: 'big-note', text: s.mail ? `When ${name} signs, you get the signed copy by email. This same link also downloads it then.` : `Waiting on ${name}. Open this same link later to download the signed copy.` }),
        h('button', { class: 'btn', type: 'button', onclick: start }, 'Check again'),
        back,
      ),
    );
    return;
  }
  const both = s.roles.length === 2 ? 'both parties' : 'everyone';
  const note = h('p', { class: 'big-note', text: s.mail && justNow ? 'Emailing the signed PDF...' : 'Download your copy below and keep it.' });
  screen(
    h(
      'div',
      { class: 'card center' },
      h('h1', { text: justNow ? `Finished. Signed by ${both}.` : `Signed by ${both}` }),
      note,
      h('button', { class: 'btn gold', type: 'button', onclick: () => download(out, () => api('GET', '/api/sign/record', { signToken: token })) }, 'Download or print the PDF'),
      out,
      back,
    ),
  );
  if (justNow && s.mail) emailCopies(note);
}

// The last signer's phone builds the finished PDF and hands it over, so the copy emails carry it.
async function emailCopies(note) {
  try {
    const { record } = await api('GET', '/api/sign/record', { signToken: token });
    const { pdf_b64 } = await pdfForEmail(record);
    const r = await api('POST', '/api/sign/copy', { signToken: token, body: { pdf_b64 } });
    const to = r.emailed.filter((e) => e.ok).map((e) => e.to);
    note.textContent = to.length ? `Emailed the signed copy to ${joinNames(to)}.` : 'Everyone gets the signed copy by email.';
  } catch {
    note.textContent = 'The signed copies go out by email in a few minutes. You can download yours now.';
  }
}

async function download(out, getRecord) {
  out.replaceChildren(h('p', { class: 'hint', text: 'Building your PDF...' }));
  try {
    const { record } = await getRecord();
    const { hash, url } = await savePdf(record);
    out.replaceChildren(
      h('p', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open the PDF'), ' if the download did not start.'),
      h('p', { class: 'hint', text: 'File fingerprint (SHA-256). Every copy shows the same one:' }),
      h('p', { class: 'mono', text: hash }),
    );
  } catch (e) {
    out.replaceChildren(h('p', { class: 'error', text: e.message || 'Could not build the PDF.' }));
  }
}

// ---------- download page for a finished document (#c=) ----------

async function startCopy() {
  screen(h('p', { class: 'center big-note', text: 'Opening your signed copy...' }));
  let record;
  try {
    ({ record } = await api('GET', '/api/copy/record', { copyToken }));
  } catch (err) {
    message('This link cannot be used', err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    return;
  }
  document.title = `${record.title} | ${CONFIG.APP_NAME}`;
  const out = h('div');
  screen(
    h(
      'div',
      { class: 'card center' },
      h('h1', { text: record.title }),
      h('p', { class: 'big-note', text: `Signed by ${joinNames((record.signers || []).map((s) => s.name))}.` }),
      h('button', { class: 'btn gold', type: 'button', onclick: () => download(out, async () => ({ record })) }, 'Download the signed PDF'),
      out,
    ),
  );
}

// ---------- decline ----------

function openDecline() {
  const reason = h('textarea', { style: { minHeight: '120px' }, maxlength: '500', 'aria-label': 'Why are you declining?' });
  const err = h('p', { class: 'error', role: 'alert' });
  openSheet('Decline to sign', h('div', {}, h('p', { text: 'The sender will see your reason. You cannot undo this.' }), h('label', { for: 'why' }, 'Why are you declining?'), reason, err), [
    h('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Cancel'),
    h(
      'button',
      {
        class: 'btn danger',
        type: 'button',
        onclick: async () => {
          if (!reason.value.trim()) {
            err.textContent = 'Please say why.';
            return;
          }
          try {
            await api('POST', '/api/sign/decline', { signToken: token, body: { reason: reason.value.trim(), timezone: timezone() } });
            clearDraft();
            message('You declined this document', 'The sender can see your reason.');
          } catch (e) {
            err.textContent = e.message;
          }
        },
      },
      'Decline',
    ),
  ]);
  reason.id = 'why';
}

window.addEventListener('hashchange', () => location.reload());
start();
