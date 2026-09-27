// Minimal HS256 JWT implementation (no dependencies).
import crypto from 'node:crypto';

export class JwtError extends Error {
  /** @param {string} code  invalid_token | token_expired  @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

/**
 * Sign a payload with HS256.
 * @param {object} payload
 * @param {Buffer} key raw key bytes (for Twitch: base64-DECODED extension secret)
 */
export function signHS256(payload, key) {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson(payload);
  const sig = crypto.createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/**
 * Verify an HS256 JWT. Rejects alg != HS256 (incl. "none"), bad signature, missing/expired exp.
 * @param {string} token
 * @param {Buffer} key
 * @param {{ nowSec?: number, clockToleranceSec?: number, requireExp?: boolean }} [opts]
 * @returns {object} payload
 */
export function verifyHS256(token, key, opts = {}) {
  const { nowSec = Math.floor(Date.now() / 1000), clockToleranceSec = 0, requireExp = true } = opts;
  if (typeof token !== 'string') throw new JwtError('invalid_token', 'Token must be a string');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('invalid_token', 'Malformed JWT');
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('invalid_token', 'Malformed JWT encoding');
  }
  if (!header || header.alg !== 'HS256') throw new JwtError('invalid_token', 'Unsupported JWT alg');
  const expected = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new JwtError('invalid_token', 'Invalid JWT signature');
  }
  if (!payload || typeof payload !== 'object') throw new JwtError('invalid_token', 'Invalid JWT payload');
  if (payload.exp === undefined) {
    if (requireExp) throw new JwtError('invalid_token', 'JWT missing exp');
  } else {
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp)) throw new JwtError('invalid_token', 'JWT exp not numeric');
    if (nowSec > exp + clockToleranceSec) throw new JwtError('token_expired', 'JWT expired');
  }
  if (payload.nbf !== undefined && nowSec + clockToleranceSec < Number(payload.nbf)) {
    throw new JwtError('invalid_token', 'JWT not yet valid');
  }
  return payload;
}
