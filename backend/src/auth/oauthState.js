// Signed, short-lived OAuth `state` parameter binding a Spotify authorization to a Twitch channel.
// Format: base64url(JSON{c: channelId, n: nonce, exp}) + "." + base64url(HMAC-SHA256)
// The nonce is additionally stored server-side (with the PKCE code_verifier) and consumed once.
import crypto from 'node:crypto';

export class StateError extends Error {}

export function createState({ channelId, nonce, ttlSec = 600, key, nowSec = Math.floor(Date.now() / 1000) }) {
  const body = Buffer.from(JSON.stringify({ c: channelId, n: nonce, exp: nowSec + ttlSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(state, key, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof state !== 'string' || state.length > 2048) throw new StateError('missing or invalid state');
  const [body, sig] = state.split('.');
  if (!body || !sig) throw new StateError('malformed state');
  const expected = crypto.createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new StateError('state signature mismatch');
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new StateError('malformed state');
  }
  if (!data.c || !data.n || !Number.isFinite(data.exp)) throw new StateError('malformed state');
  if (nowSec > data.exp) throw new StateError('state expired');
  return { channelId: String(data.c), nonce: String(data.n), exp: data.exp };
}

/** PKCE helpers (RFC 7636, S256). */
export function createPkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url'); // 64 chars
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
