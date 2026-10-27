// Builds the signed PDF in the browser from the sealed record and saves it.
import { buildPdf, fileName } from './shared/pdf.js';
import { sha256Hex } from './shared/canon.js';

export { fileName };

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

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// The finished PDF, ready to send to the Worker for the "signed copy" emails.
export async function pdfForEmail(record) {
  const bytes = await pdfBytes(record);
  return { pdf_b64: toBase64(bytes), hash: await sha256Hex(bytes) };
}
