import { CONFIG } from './config.js';

const OWNER_KEY = 'sign-owner-session';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status}).`);
    this.status = status;
    this.body = body || {};
  }
}

export function ownerToken() {
  try {
    return localStorage.getItem(OWNER_KEY) || '';
  } catch {
    return '';
  }
}

export function setOwnerToken(token) {
  try {
    if (token) localStorage.setItem(OWNER_KEY, token);
    else localStorage.removeItem(OWNER_KEY);
  } catch {
    /* private mode: stays signed in for this tab only */
  }
}

export async function api(method, path, { body, signToken, owner = !signToken } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (owner && ownerToken()) headers.Authorization = `Bearer ${ownerToken()}`;
  if (signToken) headers['X-Sign-Token'] = signToken;
  let res;
  try {
    res = await fetch(`${CONFIG.API_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), referrerPolicy: 'no-referrer' });
  } catch {
    throw new ApiError(0, { error: 'No connection. Check your signal and try again.' });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
