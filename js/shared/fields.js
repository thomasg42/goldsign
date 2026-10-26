// Field types, signer input rules and how each value prints.
// Shared by the browser and the Worker, so a value the page accepts is a value the server accepts.

export const SENDER_ROLE = 'Sender';

// Consent wording. Bump CONSENT_VERSION whenever the text changes.
export const CONSENT_VERSION = 1;
export const CONSENT_TEXT = 'I agree to sign this electronically. My typed or drawn mark is my signature.';

// w and h are the default inline size in PDF points (72 per inch).
export const FIELD_TYPES = {
  signature: { label: 'Signature', w: 180, h: 34, prompt: 'Sign here' },
  initials: { label: 'Initials', w: 56, h: 26, prompt: 'Your initials' },
  date: { label: 'Date', w: 118, h: 15, prompt: "Today's date" },
  full_name: { label: 'Full name', w: 170, h: 15, prompt: 'Type your full legal name' },
  address: { label: 'Address', w: 300, h: 15, prompt: 'Your mailing address' },
  phone: { label: 'Phone', w: 112, h: 15, prompt: 'Your phone number' },
  email: { label: 'Email', w: 190, h: 15, prompt: 'Your email address' },
  company: { label: 'Company', w: 170, h: 15, prompt: 'Your company name' },
  checkbox: { label: 'Checkbox', w: 12, h: 12, prompt: 'Tick to agree' },
  free_text: { label: 'Free text', w: 150, h: 15, prompt: 'Type your answer' },
};

export const TYPE_KEYS = Object.keys(FIELD_TYPES);
const MAX_PNG_CHARS = 400000;

export function isImageType(type) {
  return type === 'signature' || type === 'initials';
}

export function isEmpty(type, raw) {
  if (raw === null || raw === undefined) return true;
  if (type === 'checkbox') return raw !== true;
  if (isImageType(type)) return !raw || typeof raw !== 'object' || !raw.png;
  if (type === 'address') {
    if (typeof raw !== 'object') return true;
    return ['street', 'city', 'state', 'zip'].every((k) => !String(raw[k] ?? '').trim());
  }
  return String(raw).trim() === '';
}

function bad(error) {
  return { ok: false, error };
}

function good(value) {
  return { ok: true, value };
}

function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2200;
}

function checkPng(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return false;
  if (dataUrl.length > MAX_PNG_CHARS) return false;
  try {
    const head = atob(dataUrl.slice(22, 34));
    return head.charCodeAt(0) === 0x89 && head.slice(1, 4) === 'PNG';
  } catch {
    return false;
  }
}

// Returns { ok: true, value } with the cleaned value (null when an optional field is left empty),
// or { ok: false, error } with a short message the signer can act on.
export function validateValue(field, raw) {
  const type = field.type;
  if (!FIELD_TYPES[type]) return bad('Unknown field type.');
  if (isEmpty(type, raw)) {
    if (type === 'signature') return bad('Please sign here.');
    if (field.required) {
      return bad(type === 'checkbox' ? 'Tick this box to continue.' : 'This one is required.');
    }
    return good(type === 'checkbox' ? false : null);
  }
  switch (type) {
    case 'signature':
    case 'initials': {
      const kind = raw.kind === 'typed' ? 'typed' : raw.kind === 'drawn' ? 'drawn' : null;
      if (!kind) return bad('Draw or type your mark.');
      if (!checkPng(raw.png)) return bad('That mark did not save. Please try again.');
      const out = { kind, png: raw.png };
      if (kind === 'typed') {
        const text = String(raw.text ?? '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 80) return bad('Type your name to make your mark.');
        out.text = text;
        out.font = String(raw.font ?? '').slice(0, 40);
      }
      return good(out);
    }
    case 'date': {
      const s = String(raw).trim();
      return isRealDate(s) ? good(s) : bad('Pick a real date.');
    }
    case 'full_name':
    case 'company': {
      const s = String(raw).trim().replace(/\s+/g, ' ');
      if (s.length > 120) return bad('Keep it under 120 characters.');
      return good(s);
    }
    case 'address': {
      const a = {
        street: String(raw.street ?? '').trim().replace(/\s+/g, ' '),
        city: String(raw.city ?? '').trim().replace(/\s+/g, ' '),
        state: String(raw.state ?? '').trim().toUpperCase(),
        zip: String(raw.zip ?? '').trim(),
      };
      if (!a.street || !a.city || !a.state || !a.zip) return bad('Fill in street, city, state and ZIP.');
      if (!/^[A-Z]{2}$/.test(a.state)) return bad('Use the 2 letter state code, like MT.');
      if (!/^\d{5}(-\d{4})?$/.test(a.zip)) return bad('Use a 5 digit ZIP code.');
      if (a.street.length > 120 || a.city.length > 60) return bad('That address is too long.');
      return good(a);
    }
    case 'phone': {
      let d = String(raw).replace(/\D/g, '');
      if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
      if (d.length !== 10) return bad('Use a 10 digit phone number.');
      return good(`(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);
    }
    case 'email': {
      const s = String(raw).trim().toLowerCase();
      if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return bad('Check the email address.');
      return good(s);
    }
    case 'checkbox':
      return good(true);
    case 'free_text': {
      let s = String(raw);
      s = field.multiline ? s.replace(/\r\n?/g, '\n').trim() : s.replace(/\s+/g, ' ').trim();
      const max = Number(field.maxLength) > 0 ? Number(field.maxLength) : 500;
      if (s.length > max) return bad(`Keep it under ${max} characters.`);
      return good(s);
    }
    default:
      return bad('Unknown field type.');
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// Text that prints in the field's box. Signatures and initials print as images, so they return ''.
export function displayValue(field, value) {
  if (value === null || value === undefined) return '';
  switch (field.type) {
    case 'signature':
    case 'initials':
      return '';
    case 'date':
      return formatDate(value);
    case 'address':
      return `${value.street}, ${value.city}, ${value.state} ${value.zip}`;
    case 'checkbox':
      return value === true ? 'Yes' : '';
    default:
      return String(value);
  }
}

// Calendar date (YYYY-MM-DD) in a time zone, built from numeric parts so every engine agrees.
export function localDate(iso, timeZone) {
  const p = zonedParts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function safeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return 'UTC';
  }
}

export function zonedParts(iso, timeZone) {
  const zone = safeZone(timeZone || 'UTC');
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out = {};
  for (const part of fmt.formatToParts(new Date(iso))) out[part.type] = part.value;
  if (out.hour === '24') out.hour = '00';
  return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second, zone };
}

// "2026-10-26 11:45:12 (UTC-06:00, America/Denver)". Plain ASCII so it prints the same in every PDF.
export function formatLocal(iso, timeZone) {
  const p = zonedParts(iso, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMin = Math.round((asUtc - Math.floor(new Date(iso).getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} (UTC${off}, ${p.zone})`;
}

export function formatUtc(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
