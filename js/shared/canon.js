// Fingerprints. Same function in the browser, the Worker and the tests, so anyone can recompute a seal.

// JSON with object keys sorted at every level, so equal data always gives equal text.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// What a signer agreed to: wording, field definitions, the sender's filled-in values and who signs.
export function documentForFingerprint(doc) {
  return {
    id: doc.id,
    title: doc.title,
    body: doc.body,
    fields: [...(doc.fields || [])].sort((a, b) => a.n - b.n),
    signers: [...(doc.signers || [])].map((s) => ({ id: s.id, role: s.role, name: s.name, email: s.email })),
  };
}

// The record the seal covers. The final PDF is drawn from exactly this object.
export function recordForSeal(record) {
  const { seal_sha256, downloads, ...rest } = record;
  return rest;
}
