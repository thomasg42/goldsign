// Builds the signed PDF: the document pages with every value stamped in place, then the audit pages.
// Deterministic: the same record always gives the same bytes, so both sides hold identical copies.

import { PAGE, layoutDocument, fieldRect, pdfSafe } from './layout.js';
import { displayValue, formatUtc, isImageType, CONSENT_TEXT, CONSENT_VERSION } from './fields.js';

const GRAY = [0.45, 0.45, 0.45];
const LINE = [0.55, 0.55, 0.55];

// The same file name for a download and an emailed copy.
export function fileName(title, suffix) {
  const base = String(title || 'document').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'document';
  return `${base}-${suffix}.pdf`;
}

const EMAIL_KINDS = { invite: 'Signing link', copy: 'Signed copy' };

export function describeEvent(e, record) {
  const s = (record.signers || []).find((x) => x.id === e.signer_id);
  const who = s ? `${s.name} (${s.role})` : 'Sender';
  const d = e.details || {};
  switch (e.type) {
    case 'created':
      return 'Sender created the document';
    case 'sent':
      return 'Sender locked the wording and sent it for signing';
    case 'link_created':
      return `Signing link made for ${who}, valid until ${formatUtc(d.expires_at || e.at)}`;
    case 'link_reissued':
      return `New signing link made for ${who}; the old link stopped working`;
    case 'viewed':
      return `${who} opened the document`;
    case 'consent':
      return `${who} agreed to sign electronically (consent version ${d.version ?? CONSENT_VERSION})`;
    case 'field_completed':
      return `${who} completed field ${d.n}: ${d.label || d.type}`;
    case 'signed':
      return `${who} signed`;
    case 'declined':
      return `${who} declined. Reason: ${d.reason || 'none given'}`;
    case 'completed':
      return 'Every signer finished. The record was sealed';
    case 'voided':
      return `Sender voided the document${d.reason ? `. Reason: ${d.reason}` : ''}`;
    case 'email_sent':
      return `${EMAIL_KINDS[d.kind] || 'Email'} emailed to ${d.to}${d.attached ? ' with the signed PDF attached' : ''}`;
    case 'email_failed':
      return `${EMAIL_KINDS[d.kind] || 'Email'} to ${d.to} did not go out (${d.error || 'no reason given'})`;
    case 'copy_built':
      return `Signed PDF made for emailing, file fingerprint ${String(d.file_sha256 || '').slice(0, 16)}...`;
    default:
      return `${e.type}${s ? ` by ${who}` : ''}`;
  }
}

function wrap(text, font, size, width) {
  const words = pdfSafe(text).split(/\s+/).filter(Boolean);
  const fits = (s) => font.widthOfTextAtSize(s, size) <= width;
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next)) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    let rest = w;
    // A token wider than the line (a hash or a URL) breaks by characters.
    while (rest && !fits(rest)) {
      let take = rest.length;
      while (take > 1 && !fits(rest.slice(0, take))) take -= 1;
      lines.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
    cur = rest;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function fitText(text, font, maxSize, minSize, width) {
  let size = maxSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > width) size -= 0.5;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = `${t.slice(0, -4)}...`;
  return { text: t, size };
}

// record: see worker buildRecord(). options.audit = false draws a preview without the audit pages.
export async function buildPdf(PDFLib, record, options = {}) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const audit = options.audit !== false;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fixed = new Date(record.completed_at || record.sent_at || record.created_at || '2026-01-01T00:00:00Z');
  doc.setTitle(pdfSafe(record.title || 'Document'));
  doc.setAuthor(pdfSafe(record.sender_name || ''));
  doc.setSubject(audit ? 'Signed document with audit trail' : 'Document preview');
  doc.setProducer(pdfSafe(record.app || 'Signing app'));
  doc.setCreator(pdfSafe(record.app || 'Signing app'));
  doc.setCreationDate(fixed);
  doc.setModificationDate(fixed);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const measure = (t, size, isBold) => (isBold ? bold : font).widthOfTextAtSize(t, size);
  const color = (c) => rgb(c[0], c[1], c[2]);

  const fields = record.fields || [];
  const byN = new Map(fields.map((f) => [Number(f.n), f]));
  const values = record.values || {};
  const layout = layoutDocument(record.body, fields, measure);

  const pages = layout.pages.map((lp) => {
    const page = doc.addPage([PAGE.w, PAGE.h]);
    for (const line of lp.lines) {
      for (const it of line.items) {
        if (it.kind === 'text') {
          page.drawText(it.text, { x: it.x, y: PAGE.h - line.baseline, size: it.size, font: it.bold ? bold : font, color: rgb(0, 0, 0) });
        } else if (it.kind === 'box') {
          const f = it.ref.field !== undefined ? byN.get(it.ref.field) : null;
          if (f && f.type === 'checkbox') continue; // drawn with its value below
          page.drawLine({
            start: { x: it.x, y: PAGE.h - (it.y + it.h) },
            end: { x: it.x + it.w, y: PAGE.h - (it.y + it.h) },
            thickness: 0.6,
            color: color(LINE),
          });
        }
      }
    }
    return page;
  });

  // Stamp the values.
  for (const f of fields) {
    const r = fieldRect(f, layout);
    if (!r || !pages[r.page]) continue;
    const page = pages[r.page];
    const v = values[f.n];
    const bottomY = PAGE.h - (r.y + r.h);
    if (f.type === 'checkbox') {
      const s = Math.min(r.w, r.h, 12);
      const bx = r.x;
      const by = bottomY + (r.h - s) / 2;
      page.drawRectangle({ x: bx, y: by, width: s, height: s, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
      if (v === true) {
        page.drawLine({ start: { x: bx + s * 0.2, y: by + s * 0.5 }, end: { x: bx + s * 0.42, y: by + s * 0.22 }, thickness: 1.4, color: rgb(0, 0, 0) });
        page.drawLine({ start: { x: bx + s * 0.42, y: by + s * 0.22 }, end: { x: bx + s * 0.85, y: by + s * 0.82 }, thickness: 1.4, color: rgb(0, 0, 0) });
      }
      continue;
    }
    if (v === null || v === undefined || v === '') continue;
    if (isImageType(f.type)) {
      if (!v.png) continue;
      const img = await doc.embedPng(v.png);
      const scale = Math.min(r.w / img.width, (r.h + 6) / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: r.x, y: bottomY + 1, width: w, height: h });
      continue;
    }
    const text = pdfSafe(displayValue(f, v));
    if (!text) continue;
    if (f.multiline && !r.anchored && r.h > 24) {
      const lines = String(v).split('\n').flatMap((para) => wrap(para, font, 9, r.w - 2));
      let y = PAGE.h - r.y - 10;
      for (const ln of lines) {
        if (y < bottomY) break;
        page.drawText(ln, { x: r.x + 1, y, size: 9, font });
        y -= 11;
      }
      continue;
    }
    const fit = fitText(text.replace(/\n+/g, ' '), font, Math.min(10.5, r.h * 0.8), 6, r.w - 2);
    page.drawText(fit.text, { x: r.x + 1, y: bottomY + 2.5, size: fit.size, font, color: rgb(0.05, 0.1, 0.35) });
  }

  if (audit) drawAudit(doc, record, { font, bold, mono, rgb });

  // Footers last, once the page count is known.
  const all = doc.getPages();
  all.forEach((page, i) => {
    const left = fitText(pdfSafe(record.title || ''), font, 8, 6, 300).text;
    page.drawText(left, { x: PAGE.margin, y: 30, size: 8, font, color: color(GRAY) });
    const right = `Page ${i + 1} of ${all.length}`;
    page.drawText(right, { x: PAGE.w - PAGE.margin - font.widthOfTextAtSize(right, 8), y: 30, size: 8, font, color: color(GRAY) });
    if (record.id) page.drawText(`Document ID ${record.id}`, { x: PAGE.margin, y: 20, size: 7, font, color: color(GRAY) });
  });

  return doc.save({ useObjectStreams: false });
}

function drawAudit(doc, record, { font, bold, mono, rgb }) {
  const width = PAGE.w - PAGE.margin * 2;
  let page = doc.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - PAGE.margin;
  const ensure = (h) => {
    if (y - h < PAGE.margin + 20) {
      page = doc.addPage([PAGE.w, PAGE.h]);
      y = PAGE.h - PAGE.margin;
    }
  };
  const text = (t, { size = 9.5, f = font, gap = 3, indent = 0, gray = false } = {}) => {
    const lines = wrap(t, f, size, width - indent);
    for (const ln of lines) {
      ensure(size + gap);
      y -= size + gap;
      page.drawText(ln, { x: PAGE.margin + indent, y, size, font: f, color: gray ? rgb(0.35, 0.35, 0.35) : rgb(0, 0, 0) });
    }
  };
  const space = (h) => {
    y -= h;
  };
  const rule = () => {
    ensure(10);
    y -= 6;
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.w - PAGE.margin, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    y -= 4;
  };

  text('Audit trail', { size: 16, f: bold, gap: 4 });
  text(`${record.title}`, { size: 11, f: bold, gap: 6 });
  text(`Document ID: ${record.id}`);
  text(`Status: ${record.status === 'signed' ? 'Signed by every party' : record.status}`);
  if (record.sent_at) text(`Sent: ${formatUtc(record.sent_at)}`);
  if (record.completed_at) text(`Completed: ${formatUtc(record.completed_at)}`);
  text(`Sender: ${record.sender_name || 'Sender'}`);
  rule();
  text('Fingerprints (SHA-256)', { size: 11, f: bold, gap: 5 });
  text('Document as sent (wording, fields, filled-in terms and signers):', { gray: true });
  text(record.doc_sha256 || 'not recorded', { f: mono, size: 8.5, indent: 8 });
  text('Sealed record (everything above plus every signed value and every event below):', { gray: true });
  text(record.seal_sha256 || 'not sealed', { f: mono, size: 8.5, indent: 8 });
  text('Anyone can recompute both fingerprints from the stored record. A different result means something changed.', { size: 8.5, gray: true });
  rule();
  text('Signers', { size: 11, f: bold, gap: 5 });
  for (const s of record.signers || []) {
    space(2);
    text(`${s.name} (${s.role})`, { f: bold });
    text(`Email: ${s.email}`, { indent: 8 });
    if (s.viewed_at) text(`First opened: ${formatUtc(s.viewed_at)}`, { indent: 8 });
    if (s.signed_at) text(`Signed: ${formatUtc(s.signed_at)}${s.signed_local ? `  |  Local: ${s.signed_local}` : ''}`, { indent: 8 });
    if (s.signed_ip) text(`IP address when signing: ${s.signed_ip}  |  Device: ${s.signed_device || 'unknown'}`, { indent: 8 });
    if (s.status === 'declined') text(`Declined: ${s.decline_reason || ''}`, { indent: 8 });
  }
  space(4);
  text(`Consent each signer ticked before signing (version ${record.consent_version ?? CONSENT_VERSION}):`, { gray: true });
  text(`"${record.consent_text || CONSENT_TEXT}"`, { indent: 8 });
  rule();
  text('Events', { size: 11, f: bold, gap: 5 });
  text('Times and IP addresses were recorded by the server. Local times use the time zone the signer\'s device reported.', { size: 8.5, gray: true });
  for (const e of record.events || []) {
    space(3);
    text(`${formatUtc(e.at)}  ${describeEvent(e, record)}`, { size: 9 });
    const meta = [e.local ? `Local: ${e.local}` : null, e.ip ? `IP: ${e.ip}` : null, e.device ? `Device: ${e.device}` : null].filter(Boolean).join('  |  ');
    if (meta) text(meta, { size: 8, indent: 10, gray: true, gap: 2 });
  }
}
