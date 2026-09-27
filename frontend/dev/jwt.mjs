// Minimal HS256 JWT sign/verify for the dev harness (NOT shipped). Twitch extension secrets are base64.
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function signJwt(payload, secretB64) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', Buffer.from(secretB64, 'base64')).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(token, secretB64) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, code: 'invalid_token' };
  const expect = b64url(crypto.createHmac('sha256', Buffer.from(secretB64, 'base64')).update(`${parts[0]}.${parts[1]}`).digest());
  if (expect !== parts[2]) return { ok: false, code: 'invalid_token' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch {
    return { ok: false, code: 'invalid_token' };
  }
  if (!payload.channel_id) return { ok: false, code: 'invalid_token' };
  if (payload.exp && payload.exp * 1000 < Date.now()) return { ok: false, code: 'token_expired' };
  return { ok: true, payload };
}
