// Turns the document text into fixed Letter-size pages. The page preview, the phone reader and the
// final PDF all read this one layout, so a field sits in the same spot on every screen and in the PDF.
//
// Text format, one paragraph per line:
//   # Heading            ## Smaller heading
//   1. Numbered clause   - Bullet        "  - " indented bullet
//   **bold**             [____] blank    [[7]] field number 7 sits here
//   A blank line adds space.

import { FIELD_TYPES } from './fields.js';

export const PAGE = { w: 612, h: 792, margin: 64, footer: 36 };
export const CONTENT_W = PAGE.w - PAGE.margin * 2;
const SIZE = { h1: 16, h2: 12.5, p: 10.5 };
const LEADING = 1.45;
const BULLET_INDENT = 16;

// Matches a field token or a blank, in that order.
const TOKEN_RE = /\[\[(\d{1,4})\]\]|\[\s*_*\s*\]/g;

// Characters the built-in PDF fonts can print (WinAnsi). Anything else becomes "?".
const WIN_EXTRA = '\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178';
export function pdfSafe(text) {
  let out = '';
  for (const ch of String(text ?? '').replace(/[\t ]/g, ' ')) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xff) || WIN_EXTRA.includes(ch)) out += ch;
    else if (c === 0x2212) out += '-';
    else if (c >= 0x20) out += '?';
  }
  return out;
}

export function blankWidth(raw) {
  const underscores = (raw.match(/_/g) || []).length;
  return Math.max(40, Math.min(220, underscores * 9));
}

// Splits one line into runs: { kind: 'text', text, bold } | { kind: 'field', n } | { kind: 'blank', raw }.
export function parseInline(line) {
  const runs = [];
  let bold = false;
  const pushText = (s) => {
    const parts = s.split('**');
    parts.forEach((part, i) => {
      if (i > 0) bold = !bold;
      if (part) runs.push({ kind: 'text', text: part, bold });
    });
  };
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m; (m = TOKEN_RE.exec(line)); ) {
    pushText(line.slice(last, m.index));
    runs.push(m[1] ? { kind: 'field', n: Number(m[1]), bold } : { kind: 'blank', raw: m[0], bold });
    last = m.index + m[0].length;
  }
  pushText(line.slice(last));
  return runs;
}

// One block per source line.
export function parseBody(body) {
  const blocks = [];
  String(body ?? '').replace(/\r\n?/g, '\n').split('\n').forEach((rawLine, lineIndex) => {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) {
      blocks.push({ type: 'gap', lineIndex });
      return;
    }
    let m;
    if ((m = /^##\s+(.*)$/.exec(line))) blocks.push({ type: 'h2', runs: parseInline(m[1]), lineIndex });
    else if ((m = /^#\s+(.*)$/.exec(line))) blocks.push({ type: 'h1', runs: parseInline(m[1]), lineIndex });
    else if ((m = /^(\s{2,})[-*]\s+(.*)$/.exec(line))) blocks.push({ type: 'li', level: 2, runs: parseInline(m[2]), lineIndex });
    else if ((m = /^[-*]\s+(.*)$/.exec(line))) blocks.push({ type: 'li', level: 1, runs: parseInline(m[1]), lineIndex });
    else if ((m = /^(\d{1,3}\.|\([a-z]\))\s+(.*)$/.exec(line))) {
      blocks.push({ type: 'p', marker: m[1], runs: parseInline(m[2]), lineIndex });
    } else blocks.push({ type: 'p', runs: parseInline(line.trim()), lineIndex });
  });
  return blocks;
}

export function fieldTokens(body) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  for (let m; (m = TOKEN_RE.exec(String(body ?? ''))); ) if (m[1]) out.push(Number(m[1]));
  return out;
}

// Replace the i-th blank (0-based, counting blanks only) with text.
export function replaceNthBlank(body, index, replacement) {
  let seen = -1;
  TOKEN_RE.lastIndex = 0;
  return String(body).replace(TOKEN_RE, (match, n) => {
    if (n) return match;
    seen += 1;
    return seen === index ? replacement : match;
  });
}

export function replaceFieldToken(body, n, replacement) {
  return String(body).replace(new RegExp(`\\[\\[${n}\\]\\]`, 'g'), replacement);
}

function inlineSize(field) {
  const base = FIELD_TYPES[field?.type] || FIELD_TYPES.free_text;
  const w = Number(field?.inlineWidth) > 0 ? Number(field.inlineWidth) : base.w;
  return { w: Math.min(w, CONTENT_W), h: base.h };
}

// measure(text, size, bold) returns the width in points. Build it with createMeasurer().
export function layoutDocument(body, fields, measure) {
  const byN = new Map((fields || []).map((f) => [Number(f.n), f]));
  const pages = [];
  const fieldRects = {};
  const blanks = [];
  let page = null;
  let y = 0;
  const bottom = PAGE.h - 54; // keeps clear of the footer drawn at 20-38 pt from the bottom
  const newPage = () => {
    page = { index: pages.length, lines: [] };
    pages.push(page);
    y = PAGE.margin;
  };
  newPage();

  const blocks = parseBody(body);
  blocks.forEach((block, bi) => {
    if (block.type === 'gap') {
      if (page.lines.length) y += 7;
      return;
    }
    const size = block.type === 'h1' ? SIZE.h1 : block.type === 'h2' ? SIZE.h2 : SIZE.p;
    const headBold = block.type === 'h1' || block.type === 'h2';
    const before = block.type === 'h1' ? (page.lines.length ? 14 : 0) : block.type === 'h2' ? 10 : 0;
    const after = block.type === 'h1' ? 8 : block.type === 'h2' ? 4 : 5;
    let x0 = PAGE.margin;
    let marker = null;
    if (block.type === 'li') {
      x0 = PAGE.margin + BULLET_INDENT * block.level;
      marker = { text: '•', x: x0 - 10 };
    } else if (block.marker) {
      x0 = PAGE.margin + Math.max(measure(`${block.marker} `, size, headBold), 16);
      marker = { text: block.marker, x: PAGE.margin };
    }
    const right = PAGE.w - PAGE.margin;
    const space = measure(' ', size, false);

    // Break runs into placeable pieces: words and boxes.
    const pieces = [];
    for (const run of block.runs) {
      if (run.kind === 'text') {
        const bold = headBold || run.bold;
        const parts = pdfSafe(run.text).split(/( +)/);
        for (const part of parts) {
          if (!part) continue;
          if (/^ +$/.test(part)) pieces.push({ kind: 'space' });
          else pieces.push({ kind: 'word', text: part, bold, w: measure(part, size, bold) });
        }
      } else if (run.kind === 'field') {
        const f = byN.get(run.n);
        const s = f ? inlineSize(f) : { w: 60, h: 15 };
        pieces.push({ kind: 'box', ref: { field: run.n }, w: s.w, h: s.h });
      } else {
        pieces.push({ kind: 'box', ref: { blank: true, raw: run.raw }, w: blankWidth(run.raw), h: 15 });
      }
    }

    // Greedy line fill.
    const lines = [];
    let cur = { items: [], x: x0 };
    let start = x0;
    let pendingSpace = false;
    const flush = () => {
      lines.push(cur);
      cur = { items: [], x: x0 };
      start = x0;
      pendingSpace = false;
    };
    for (const piece of pieces) {
      if (piece.kind === 'space') {
        if (cur.items.length) pendingSpace = true;
        continue;
      }
      let w = piece.w;
      const gap = pendingSpace ? space : 0;
      if (cur.items.length && cur.x + gap + w > right) flush();
      else if (gap) cur.x += gap;
      if (piece.kind === 'word' && w > right - start) {
        // A single word wider than the line: split it by characters.
        let rest = piece.text;
        while (rest) {
          let take = rest.length;
          while (take > 1 && measure(rest.slice(0, take), size, piece.bold) > right - cur.x) take -= 1;
          const chunk = rest.slice(0, take);
          const cw = measure(chunk, size, piece.bold);
          cur.items.push({ kind: 'word', text: chunk, bold: piece.bold, x: cur.x, w: cw });
          cur.x += cw;
          rest = rest.slice(take);
          if (rest) flush();
        }
        pendingSpace = false;
        continue;
      }
      cur.items.push({ ...piece, x: cur.x });
      cur.x += w;
      pendingSpace = false;
    }
    if (cur.items.length || !lines.length) lines.push(cur);

    // Place lines on pages.
    y += before;
    const textH = size * LEADING;
    if (headBold && y + textH * 3 > bottom && page.lines.length) {
      newPage();
    }
    lines.forEach((line, li) => {
      const boxH = Math.max(0, ...line.items.filter((it) => it.kind === 'box').map((it) => it.h + 6));
      const h = Math.max(textH, boxH);
      if (y + h > bottom && page.lines.length) newPage();
      const baseline = y + h - size * 0.32;
      const outLine = { y, h, baseline, size, blockIndex: bi, sourceLine: block.lineIndex, items: [] };
      if (li === 0 && marker) outLine.items.push({ kind: 'text', text: marker.text, bold: headBold, x: marker.x, w: measure(marker.text, size, headBold), size });
      // Merge neighbouring words with the same weight into one text run.
      let run = null;
      for (const it of line.items) {
        if (it.kind === 'word') {
          if (run && run.bold === it.bold) {
            run.text = `${run.text}${it.x - (run.x + run.w) > 0.5 ? ' ' : ''}${it.text}`;
            run.w = it.x + it.w - run.x;
          } else {
            run = { kind: 'text', text: it.text, bold: it.bold, x: it.x, w: it.w, size };
            outLine.items.push(run);
          }
        } else {
          run = null;
          const rect = { page: page.index, x: it.x, y: baseline + 3 - it.h, w: it.w, h: it.h };
          const box = { kind: 'box', ref: it.ref, ...rect };
          outLine.items.push(box);
          if (it.ref.field !== undefined) fieldRects[it.ref.field] = rect;
          else {
            box.blankIndex = blanks.length;
            blanks.push({ index: blanks.length, ...rect, raw: it.ref.raw });
          }
        }
      }
      // Recompute merged run widths precisely, so the preview stretches text to the PDF width.
      for (const it of outLine.items) if (it.kind === 'text') it.w = measure(it.text, size, it.bold);
      page.lines.push(outLine);
      y += h;
    });
    y += after;
  });
  return { pages, fieldRects, blanks };
}

// Where a field sits on the page, in points from the top-left corner.
export function fieldRect(field, layout) {
  const anchored = layout.fieldRects[field.n];
  if (anchored) return { ...anchored, anchored: true };
  if (field.page === undefined || field.page === null) return null;
  return {
    page: Number(field.page),
    x: (Number(field.x) / 100) * PAGE.w,
    y: (Number(field.y) / 100) * PAGE.h,
    w: (Number(field.w) / 100) * PAGE.w,
    h: (Number(field.h) / 100) * PAGE.h,
    anchored: false,
  };
}

export async function createMeasurer(PDFLib) {
  const doc = await PDFLib.PDFDocument.create();
  const regular = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  return (text, size, isBold) => (isBold ? bold : regular).widthOfTextAtSize(text, size);
}

// Order fields the way a reader meets them: page, then top to bottom, then left to right.
export function readingOrder(fields, layout) {
  return [...fields]
    .map((f) => ({ f, r: fieldRect(f, layout) }))
    .sort((a, b) => {
      const ra = a.r || { page: 999, y: 0, x: 0 };
      const rb = b.r || { page: 999, y: 0, x: 0 };
      return ra.page - rb.page || Math.round(ra.y - rb.y) || ra.x - rb.x;
    })
    .map((x) => x.f);
}
