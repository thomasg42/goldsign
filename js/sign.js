// Signer page. No account: the link's code (after #t=) is the key. Built for a phone first.

import { ApiError, api, timezone } from './api.js';
import { CONFIG } from './config.js';
import { h, layoutFor, renderPages, renderReader } from './render.js';
import { FIELD_TYPES, displayValue, formatDate, isImageType, validateValue } from './shared/fields.js';
import { readingOrder } from './shared/layout.js';
import { sha256Hex } from './shared/canon.js';
import { SCRIPT_FONTS, drawPad, typedPng } from './sigpad.js';
import { savePdf } from './download.js';

const root = document.getElementById('app');
const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';

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

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status', text });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
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
const done = (f) => {
  if (f.type === 'date' && !f.allowChange) return true;
  if (!f.required && f.type !== 'signature') return S.answers[f.n] !== undefined;
  return has(f, S.answers[f.n]) && validateValue(f, S.answers[f.n]).ok;
};
const doneCount = () => S.mine.filter(done).length;
const allRequiredDone = () => S.mine.every((f) => (f.required || f.type === 'signature' ? done(f) : true));
const mergedValues = () => {
  const v = { ...S.session.values };
  for (const f of S.mine) {
    if (f.type === 'date' && !f.allowChange) v[f.n] = S.session.today;
    else if (S.answers[f.n] !== undefined) v[f.n] = S.answers[f.n];
  }
  return v;
};

// ---------- start ----------

async function start() {
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
    else if (f.prefill !== undefined) S.answers[f.n] = f.prefill;
    else if (f.type === 'date') S.answers[f.n] = S.session.today;
  }
  showMain();
}

// ---------- main document screen ----------

function showMain() {
  const doc = S.session.document;
  const count = S.mine.length;
  const intro = !S.started
    ? h(
        'div',
        { class: 'card' },
        h('p', { class: 'big-note' }, `${S.session.sender_name || 'The sender'} sent you this document to sign.`),
        h('p', {}, `You have ${count} ${count === 1 ? 'item' : 'items'} to fill in. Then you review everything and sign. It takes about two minutes.`),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => ((S.started = true), nextField()) }, 'Start'),
          h('button', { class: 'btn', type: 'button', onclick: () => ((S.started = true), showMain()) }, 'Read it first'),
        ),
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
    renderReader(docEl, doc.body, doc.fields, S.layout, { roles: S.session.roles.map((r) => r.role), values: mergedValues(), isMine, onTap: openField });
  } else {
    renderPages(docEl, S.layout, doc.fields, { roles: S.session.roles.map((r) => r.role), values: mergedValues(), isMine, showEmpty: true, title: doc.title });
    docEl.addEventListener('click', (e) => {
      const box = e.target.closest('.fbox[data-n]');
      const f = box && S.mine.find((x) => x.n === Number(box.dataset.n));
      if (f) openField(f);
    });
  }
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
      ? h('button', { class: 'btn primary', type: 'button', onclick: showReview }, 'Review and sign')
      : h('button', { class: 'btn primary', type: 'button', onclick: () => ((S.started = true), nextField()) }, n ? 'Next' : 'Start'),
  );
  document.body.append(bar);
}

function nextField(after) {
  const order = S.mine;
  const startAt = after ? order.findIndex((f) => f.n === after.n) + 1 : 0;
  const pick = [...order.slice(startAt), ...order.slice(0, startAt)].find((f) => !done(f));
  if (pick) openField(pick, { chain: true });
  else showReview();
}

// ---------- the field sheet ----------

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
    saveDraft();
    input.cleanup?.();
    closeSheet();
    showMain();
    if (chain) nextField(f);
  };
  const sheet = openSheet(
    prompt,
    h('div', {}, h('p', { class: 'hint' }, `Item ${index} of ${S.mine.length}  |  ${f.required || f.type === 'signature' ? 'Required' : 'Optional'}`), input.el, err),
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

// ---------- review, consent, sign ----------

function answerView(f) {
  const v = f.type === 'date' && !f.allowChange ? S.session.today : S.answers[f.n];
  if (!has(f, v)) return h('span', { class: f.required || f.type === 'signature' ? 'error' : 'hint', text: f.required || f.type === 'signature' ? 'Not filled in yet' : 'Left blank' });
  if (isImageType(f.type)) return h('img', { src: v.png, alt: 'Your mark' });
  return h('span', { text: f.type === 'checkbox' ? 'Yes' : displayValue(f, v) });
}

function showReview() {
  document.querySelector('.sticky-bar')?.remove();
  const consentBox = h('input', { type: 'checkbox', id: 'consent' });
  const signBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Sign');
  const err = h('p', { class: 'error', role: 'alert' });
  const ready = allRequiredDone();
  consentBox.addEventListener('change', () => {
    signBtn.disabled = !(consentBox.checked && allRequiredDone());
  });
  signBtn.addEventListener('click', () => submit(signBtn, err));
  screen(
    h('h1', { text: 'Review and sign' }),
    h('p', { class: 'hint', text: S.session.document.title }),
    h(
      'div',
      { class: 'card' },
      h(
        'ul',
        { class: 'review-list' },
        ...S.mine.map((f) =>
          h(
            'li',
            {},
            h('div', {}, h('span', { class: 'q', text: f.label || FIELD_TYPES[f.type].label }), answerView(f), S.errors[f.n] ? h('span', { class: 'error', text: ` ${S.errors[f.n]}` }) : null),
            f.type === 'date' && !f.allowChange ? null : h('button', { class: 'btn small', type: 'button', onclick: () => openField(f) }, 'Change'),
          ),
        ),
      ),
    ),
    ready ? null : h('p', { class: 'error', text: 'Some required items are still empty. Tap Change next to each one.' }),
    h('label', { class: 'consent', for: 'consent' }, consentBox, h('span', { text: S.session.consent.text })),
    err,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: showMain }, 'Back to the document'), signBtn),
  );
}

async function submit(btn, err) {
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
      showReview();
      return;
    }
    err.textContent = e.message || 'Signing failed. Try again.';
    btn.disabled = false;
    btn.textContent = 'Sign';
  }
}

// ---------- after signing ----------

function showSigned(justNow = false) {
  document.querySelector('.sticky-bar')?.remove();
  const complete = S.session.document.status === 'signed';
  const out = h('div');
  const waiting = S.session.roles.filter((r) => r.status !== 'signed');
  screen(
    h(
      'div',
      { class: 'card center' },
      h('h1', { text: justNow ? 'Signed. Thank you.' : 'You already signed this' }),
      complete
        ? h('p', { class: 'big-note', text: 'Everyone has signed. Download your copy below and keep it.' })
        : h('p', { class: 'big-note', text: `Waiting on ${waiting.map((r) => `${r.name} (${r.role})`).join(' and ')}. Open this same link later to download the signed copy.` }),
      complete
        ? h('button', { class: 'btn gold', type: 'button', onclick: () => download(out) }, 'Download signed PDF')
        : h('button', { class: 'btn', type: 'button', onclick: start }, 'Check again'),
      out,
    ),
  );
}

async function download(out) {
  out.replaceChildren(h('p', { class: 'hint', text: 'Building your PDF...' }));
  try {
    const { record } = await api('GET', '/api/sign/record', { signToken: token });
    const { hash, url } = await savePdf(record);
    out.replaceChildren(
      h('p', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open the PDF'), ' if the download did not start.'),
      h('p', { class: 'hint', text: 'File fingerprint (SHA-256). Both copies show the same one:' }),
      h('p', { class: 'mono', text: hash }),
    );
  } catch (e) {
    out.replaceChildren(h('p', { class: 'error', text: e.message || 'Could not build the PDF.' }));
  }
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
