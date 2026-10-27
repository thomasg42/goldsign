// Who signs when. Shared by the browser and the Worker.
// A document sent "in order" goes to the other signers first, one at a time in the order listed,
// and to the owner (the signer whose email is OWNER_EMAIL) last, so the owner countersigns.

const norm = (email) => String(email ?? '').trim().toLowerCase();

export function isOwnerSigner(signer, ownerEmail) {
  return Boolean(norm(ownerEmail)) && norm(signer?.email) === norm(ownerEmail);
}

export function signingOrder(signers, ownerEmail) {
  const list = [...(signers || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return [...list.filter((s) => !isOwnerSigner(s, ownerEmail)), ...list.filter((s) => isOwnerSigner(s, ownerEmail))];
}

// The signer whose turn it is. null once everyone has signed, or when someone declined.
export function nextSigner(signers, ownerEmail) {
  const order = signingOrder(signers, ownerEmail);
  if (order.some((s) => s.status === 'declined')) return null;
  return order.find((s) => s.status !== 'signed') || null;
}

// The first signer after this one who still has to sign. null when this signer is the last one.
export function signerAfter(signers, signerId, ownerEmail) {
  const order = signingOrder(signers, ownerEmail);
  const i = order.findIndex((s) => s.id === signerId);
  return order.slice(i + 1).find((s) => s.status !== 'signed') || null;
}

export function firstName(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || '';
}

// "Jay", "Jay and Thomas", "Ann, Bo and Cy"
export function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
