// Draft cleaning and the "ready to send?" check. Shared by the builder and the Worker.

import { FIELD_TYPES, SENDER_ROLE, validateValue } from './fields.js';
import { fieldTokens } from './layout.js';

const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};

const text = (v, max) => String(v ?? '').slice(0, max);

export function cleanField(raw) {
  const type = FIELD_TYPES[raw?.type] ? raw.type : 'free_text';
  const f = {
    n: Math.trunc(Number(raw?.n)) || 0,
    type,
    role: text(raw?.role, 40).trim() || SENDER_ROLE,
    label: text(raw?.label, 200).trim(),
    required: type === 'signature' ? true : Boolean(raw?.required),
  };
  if (raw?.prefill !== undefined && raw.prefill !== null && raw.prefill !== '') f.prefill = raw.prefill;
  if (raw?.value !== undefined && raw.value !== null && raw.value !== '') f.value = raw.value;
  if (type === 'free_text') {
    if (raw?.multiline) f.multiline = true;
    const max = num(raw?.maxLength, 0, 5000);
    if (max) f.maxLength = Math.trunc(max);
  }
  if (type === 'date' && raw?.allowChange) f.allowChange = true;
  const iw = num(raw?.inlineWidth, 0, 484);
  if (iw) f.inlineWidth = Math.round(iw);
  if (raw?.page !== undefined && raw.page !== null && raw.page !== '') {
    f.page = Math.trunc(num(raw.page, 0, 500) ?? 0);
    f.x = num(raw.x, 0, 100) ?? 0;
    f.y = num(raw.y, 0, 100) ?? 0;
    f.w = num(raw.w, 1, 100) ?? 20;
    f.h = num(raw.h, 1, 100) ?? 3;
  }
  return f;
}

export function cleanSigner(raw, i) {
  return {
    id: /^sg_[a-f0-9]{8,32}$/.test(raw?.id ?? '') ? raw.id : undefined,
    role: text(raw?.role, 40).trim() || `Signer ${i + 1}`,
    name: text(raw?.name, 120).trim(),
    email: text(raw?.email, 254).trim().toLowerCase(),
    phone: text(raw?.phone, 40).trim() || null,
  };
}

// Everything that stops a draft from being sent, in plain words. Empty list = ready.
// pageCount is optional (the browser knows it; the Worker does not lay out pages).
export function sendProblems(doc, pageCount) {
  const out = [];
  const fields = doc.fields || [];
  const signers = doc.signers || [];
  if (!String(doc.title ?? '').trim()) out.push('Give the document a title.');
  if (!String(doc.body ?? '').trim()) out.push('The document has no wording yet.');
  if (!signers.length) out.push('Add at least one signer.');
  const roles = new Set();
  for (const s of signers) {
    if (s.role === SENDER_ROLE) out.push(`"${SENDER_ROLE}" is reserved for terms you fill in before sending. Rename that signer.`);
    if (roles.has(s.role)) out.push(`Two signers share the role "${s.role}".`);
    roles.add(s.role);
    if (!s.name) out.push(`Add a name for the ${s.role}.`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.email || '')) out.push(`Add a valid email for the ${s.role}.`);
  }
  for (const s of signers) {
    if (!fields.some((f) => f.role === s.role && f.type === 'signature')) out.push(`Place a signature field for the ${s.role}.`);
  }
  const seen = new Set();
  for (const f of fields) {
    if (seen.has(f.n)) out.push(`Two fields share number ${f.n}.`);
    seen.add(f.n);
    if (f.role !== SENDER_ROLE && !roles.has(f.role)) out.push(`Field ${f.n} belongs to "${f.role}", who is not a signer.`);
    if (f.role === SENDER_ROLE) {
      const check = validateValue({ ...f, required: f.required || f.type !== 'checkbox' }, f.value);
      if (!check.ok) out.push(`Fill in field ${f.n} (${f.label || FIELD_TYPES[f.type].label}): ${check.error}`);
    }
  }
  const tokens = fieldTokens(doc.body);
  const tokenSet = new Set();
  for (const n of tokens) {
    if (tokenSet.has(n)) out.push(`Field ${n} appears twice in the wording.`);
    tokenSet.add(n);
    if (!seen.has(n)) out.push(`The wording has [[${n}]] but there is no field ${n}. Remove it or add the field.`);
  }
  for (const f of fields) {
    if (tokenSet.has(f.n)) continue;
    if (f.page === undefined) out.push(`Field ${f.n} is not placed on a page yet.`);
    else if (pageCount !== undefined && f.page >= pageCount) out.push(`Field ${f.n} sits on page ${f.page + 1}, which no longer exists.`);
  }
  return out;
}
