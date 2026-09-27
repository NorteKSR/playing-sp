// Verification of the Twitch extension JWT (from Twitch.ext.onAuthorized) sent by the frontend.
import { verifyHS256, JwtError } from './jwt.js';

export const ROLES = Object.freeze(['broadcaster', 'moderator', 'viewer', 'external']);

/**
 * @typedef {object} ExtensionClaims
 * @property {string} channelId
 * @property {string} role
 * @property {string|undefined} opaqueUserId
 * @property {string|undefined} userId
 * @property {number} exp
 * @property {object} raw
 */

/**
 * @param {string} token
 * @param {Buffer} secretBytes base64-decoded extension secret
 * @param {{ nowSec?: number, clockToleranceSec?: number }} [opts]
 * @returns {ExtensionClaims}
 */
export function verifyExtensionJwt(token, secretBytes, opts = {}) {
  const payload = verifyHS256(token, secretBytes, { ...opts, requireExp: true });
  if (typeof payload.channel_id !== 'string' || !payload.channel_id) {
    throw new JwtError('invalid_token', 'JWT missing channel_id');
  }
  if (!ROLES.includes(payload.role)) throw new JwtError('invalid_token', 'JWT has invalid role');
  return {
    channelId: payload.channel_id,
    role: payload.role,
    opaqueUserId: payload.opaque_user_id,
    userId: payload.user_id,
    exp: Number(payload.exp),
    raw: payload,
  };
}

/** Extract bearer token from an Authorization header value. */
export function bearerFrom(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(headerValue);
  return m ? m[1] : null;
}
