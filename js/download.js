// Builds the signed PDF in the browser from the sealed record and saves it.
import { buildPdf } from './shared/pdf.js';
import { sha256Hex } from './shared/canon.js';

export function fileName(title, suffix) {
  const base = String(title || 'document').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'document';
  return `${base}-${suffix}.pdf`;
}

export async function pdfBytes(record, options) {
  const PDFLib = await import('../vendor/pdf-lib-1.17.1.esm.min.js');
  return buildPdf(PDFLib, record, options);
}

// Returns { hash, url } so the page can show the file fingerprint and an "open" fallback link.
export async function savePdf(record, suffix = 'signed', options) {
  const bytes = await pdfBytes(record, options);
  const hash = await sha256Hex(bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(record.title, suffix);
  document.body.append(a);
  a.click();
  a.remove();
  return { hash, url };
}
