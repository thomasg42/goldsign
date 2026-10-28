// Turns what a signer said out loud into the value for their box, and a value back into words to say.
// Pure functions with no browser APIs, so tests run them directly. Used by read-aloud.js.

import { formatDate } from './shared/fields.js';

const WORD_DIGITS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const trimEnd = (text) => clean(text).replace(/[\s.,!?;:]+$/, '');
const plain = (text) => clean(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Whole-answer commands only, so "skip the second page" in a real answer is never a command.
const COMMANDS = {
  skip: ['skip', 'skip it', 'skip this', 'skip this one', 'next', 'pass', 'leave it blank', 'leave it empty', 'skip that'],
  stop: ['stop', 'stop reading', 'pause', 'stop it', 'quit'],
  repeat: ['repeat', 'repeat that', 'say that again', 'say it again', 'again', 'what', 'come again', 'what was that', 'sorry'],
};

export function command(text) {
  const p = plain(text);
  for (const [name, list] of Object.entries(COMMANDS)) if (list.includes(p)) return name;
  return null;
}

// What speech-to-text tends to invent out of a cough or room noise.
const NOISE = new Set(['', 'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'bye', 'uh', 'um', 'hmm', 'mm']);
export const isNoise = (text) => NOISE.has(plain(text));

// "four oh six, five five five" and "double five" become digits; digits already written stay.
export function digitsFrom(text) {
  const words = plain(text).replace(/(\d)/g, ' $1 ').split(' ').filter(Boolean);
  let out = '';
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    const times = w === 'double' ? 2 : w === 'triple' ? 3 : 0;
    if (times && i + 1 < words.length) {
      const next = /^\d$/.test(words[i + 1]) ? words[i + 1] : WORD_DIGITS[words[i + 1]];
      if (next) {
        out += next.repeat(times);
        i += 1;
        continue;
      }
    }
    if (/^\d+$/.test(w)) out += w;
    else if (WORD_DIGITS[w]) out += WORD_DIGITS[w];
  }
  return out;
}

// "Jay dot Smith at gmail dot com" -> jay.smith@gmail.com
export function spokenEmail(text) {
  let s = ` ${clean(text).toLowerCase()} `;
  s = s.replace(/[,;!?]/g, ' ');
  s = s.replace(/\b([a-z0-9])(?:-([a-z0-9]))+\b/g, (m) => m.replace(/-/g, '')); // J-A-Y spelled out
  s = s.replace(/\s(at sign|at symbol|at)\s/g, ' @ ');
  s = s.replace(/\s(dot|period|point)\s/g, ' . ');
  s = s.replace(/\s(underscore|under score)\s/g, ' _ ');
  s = s.replace(/\s(dash|hyphen|minus)\s/g, ' - ');
  s = s.replace(/\s+/g, '').replace(/\.+$/, '');
  if (!s.includes('@') && /(gmail|yahoo|outlook|hotmail|icloud|aol)\.com$/.test(s)) s = s.replace(/(gmail|yahoo|outlook|hotmail|icloud|aol)\.com$/, '@$1.com');
  return s.replace(/@+/g, '@').replace(/\.{2,}/g, '.');
}

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC', 'washington dc': 'DC', 'washington d c': 'DC',
};
const STATE_CODES = new Set(Object.values(STATES));
const STREET_END = /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd|place|pl|circle|cir|trail|trl|highway|hwy|parkway|pkwy|terrace|ter|loop|square|sq|alley|run|path|pike)\b\.?((?:\s+(?:apartment|apt|unit|suite|ste|number|no|#)\.?\s*[a-z0-9-]+))?/gi;

// "123 Main Street, Bozeman, Montana 59715" -> { street, city, state, zip }. Parts it cannot find come back empty.
export function spokenAddress(text) {
  let s = clean(text).replace(/[.!?]+$/, '');
  const out = { street: '', city: '', state: '', zip: '' };
  const zipMatch = /(\d{5})(?:[-\s]?(\d{4}))?\s*$/.exec(s) || /(\d{5})(?:[-\s]?(\d{4}))?(?!.*\d{5})/.exec(s);
  if (zipMatch) {
    out.zip = zipMatch[2] ? `${zipMatch[1]}-${zipMatch[2]}` : zipMatch[1];
    s = (s.slice(0, zipMatch.index) + s.slice(zipMatch.index + zipMatch[0].length)).trim();
  }
  s = s.replace(/[,\s]+$/, '');
  const lower = s.toLowerCase();
  let stateAt = -1;
  for (const name of Object.keys(STATES).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?:^|[\\s,])${name.replace(/ /g, '\\s+')}$`);
    const m = re.exec(lower);
    if (m) {
      out.state = STATES[name];
      stateAt = m.index;
      break;
    }
  }
  if (stateAt < 0) {
    const m = /(?:^|[\s,])([A-Za-z]{2})$/.exec(s);
    if (m && STATE_CODES.has(m[1].toUpperCase())) {
      out.state = m[1].toUpperCase();
      stateAt = m.index;
    }
  }
  if (stateAt >= 0) s = s.slice(0, stateAt).replace(/[,\s]+$/, '');
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    out.city = parts.pop();
    out.street = parts.join(', ');
  } else if (parts.length === 1) {
    let end = -1;
    for (const m of parts[0].matchAll(STREET_END)) end = m.index + m[0].length;
    if (end > 0 && end < parts[0].length) {
      out.street = parts[0].slice(0, end).trim();
      out.city = parts[0].slice(end).trim();
    } else out.street = parts[0];
  }
  out.street = out.street.replace(/\s+/g, ' ');
  out.city = out.city.replace(/\s+/g, ' ');
  return out;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};

const SHORT_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthOf = (w) => MONTHS.indexOf(w) + 1 || SHORT_MONTHS[w] || 0;

const ymd = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function shift(today, days) {
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// "October 27th, 2026", "10/27/2026", "the 3rd of May", "today" -> YYYY-MM-DD (null when it is not a date).
export function spokenDate(text, today) {
  const p = plain(text).replace(/'/g, '');
  if (/^(today|todays date|today's date)$/.test(p)) return today;
  if (p === 'tomorrow') return shift(today, 1);
  if (p === 'yesterday') return shift(today, -1);
  const year0 = Number(today.slice(0, 4));
  const slash = /(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(clean(text));
  if (slash) {
    let y = Number(slash[3]);
    if (y < 100) y += 2000;
    return ymd(y, Number(slash[1]), Number(slash[2]));
  }
  const words = p
    .replace(/twenty (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)/g, (m, o) => String(20 + ORDINALS[o]))
    .replace(/thirty first/g, '31')
    .split(' ');
  const mo = words.map(monthOf).find(Boolean);
  if (!mo) return null;
  const nums = words.map((w) => (ORDINALS[w] ? ORDINALS[w] : /^\d+(st|nd|rd|th)?$/.test(w) ? parseInt(w, 10) : null));
  let day = null;
  let year = null;
  for (const n of nums) {
    if (n === null) continue;
    if (n >= 1000) year = n;
    else if (day === null && n >= 1 && n <= 31) day = n;
  }
  if (!day) return null;
  return ymd(year || year0, mo, day);
}

// yes / no for a tick box. Negatives first, so "not correct" is a no.
export function spokenYesNo(text) {
  const p = plain(text);
  if (!p) return null;
  if (/\b(no|nope|nah|not|don't|dont|do not|never|negative|leave it|untick|uncheck|unchecked)\b/.test(p)) return false;
  if (/\b(yes|yeah|yep|yup|sure|ok|okay|agree|agreed|i agree|tick|check|checked|correct|right|affirmative|absolutely|of course|please do|do it)\b/.test(p)) return true;
  return null;
}

function titleCase(s) {
  return s.replace(/\b([a-z])([a-z']*)/g, (m, a, b) => a.toUpperCase() + b);
}

// The raw value for a box from what was said. read-aloud.js runs it through validateValue afterwards.
export function fromSpeech(field, text, { today } = {}) {
  switch (field.type) {
    case 'email':
      return spokenEmail(text);
    case 'phone': {
      const d = digitsFrom(text);
      return d || trimEnd(text);
    }
    case 'date':
      return spokenDate(text, today) || '';
    case 'checkbox':
      return spokenYesNo(text);
    case 'address':
      return spokenAddress(text);
    case 'full_name': {
      const s = trimEnd(text).replace(/^(my name is|my name's|it's|it is|this is|i'm|i am)\s+/i, '');
      return s === s.toLowerCase() || s === s.toUpperCase() ? titleCase(s.toLowerCase()) : s;
    }
    case 'company':
      return trimEnd(text).replace(/^(my company is|the company is|it's|it is)\s+/i, '');
    case 'free_text': {
      if (field.multiline) return clean(text);
      // A short answer loses the full stop speech-to-text adds; a real sentence keeps its punctuation.
      return clean(text).split(' ').length <= 6 && !/[.!?]\s/.test(clean(text)) ? trimEnd(text) : clean(text);
    }
    default:
      return clean(text);
  }
}

// A value said back out loud, so a signer who cannot read the box still hears what went in it.
export function sayBack(field, value) {
  if (value === null || value === undefined || value === '') return 'nothing';
  switch (field.type) {
    case 'email':
      return String(value)
        .replace(/@/g, ' at ')
        .replace(/\./g, ' dot ')
        .replace(/_/g, ' underscore ')
        .replace(/-/g, ' dash ')
        .replace(/\s+/g, ' ')
        .trim();
    case 'phone': {
      const d = String(value).replace(/\D/g, '');
      const groups = d.length === 10 ? [d.slice(0, 3), d.slice(3, 6), d.slice(6)] : [d];
      return groups.map((g) => g.split('').join(' ')).join(', ');
    }
    case 'date':
      return formatDate(value) || String(value);
    case 'checkbox':
      return value === true ? 'ticked' : 'not ticked';
    case 'address':
      return `${value.street}, ${value.city}, ${STATE_NAMES[value.state] || value.state}, ${String(value.zip).split('').join(' ')}`;
    default:
      return String(value);
  }
}

const STATE_NAMES = Object.fromEntries(Object.entries(STATES).filter(([name]) => !name.startsWith('washington d')).map(([name, code]) => [code, titleCase(name)]));

// Short pieces for the speech engine: some phones stop talking partway through a long one.
// Splits only where a full stop, question mark, colon or semicolon is followed by a space, so
// "birdiesfleet.com" and "$1,500.00" stay whole. Every word of the input comes out, in order.
export function sentences(text, max = 220) {
  const t = clean(text).replace(/\s+([.,;:!?)])/g, '$1');
  if (!t) return [];
  const pieces = [];
  const re = /[.!?;:]+(?=\s|$)/g;
  let start = 0;
  let m;
  while ((m = re.exec(t))) {
    pieces.push(t.slice(start, m.index + m[0].length).trim());
    start = m.index + m[0].length;
  }
  if (start < t.length) pieces.push(t.slice(start).trim());
  const out = [];
  for (const piece of pieces) {
    let s = piece;
    while (s.length > max) {
      let cut = s.lastIndexOf(', ', max);
      if (cut < max / 3) cut = s.lastIndexOf(' ', max);
      if (cut < 1) cut = max;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
  }
  // Merge a bare marker like "1." or "(a)" into what follows so the voice does not stutter.
  const merged = [];
  for (const s of out) {
    if (merged.length && merged[merged.length - 1].length < 5) merged[merged.length - 1] += ` ${s}`;
    else merged.push(s);
  }
  return merged;
}

// Words in capitals ("AGREEMENT") read as words, not letter by letter. Short ones (LLC, USA) stay as they are.
export function speakable(text) {
  return String(text).replace(/\b[A-Z][A-Z']{3,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());
}
