import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signHS256, verifyHS256, JwtError } from '../src/auth/jwt.js';
import { verifyExtensionJwt, bearerFrom } from '../src/auth/twitchAuth.js';
import { EXT_SECRET, mintExtJwt } from './helpers.js';

test('valid viewer token verifies and exposes claims', () => {
  const c = verifyExtensionJwt(mintExtJwt({ role: 'viewer', channelId: '42' }), EXT_SECRET);
  assert.equal(c.channelId, '42');
  assert.equal(c.role, 'viewer');
  assert.equal(c.opaqueUserId, 'A987');
});

test('valid broadcaster token verifies', () => {
  const c = verifyExtensionJwt(mintExtJwt({ role: 'broadcaster', channelId: '42' }), EXT_SECRET);
  assert.equal(c.role, 'broadcaster');
  assert.equal(c.opaqueUserId, 'U42');
});

test('expired token -> token_expired', () => {
  assert.throws(() => verifyExtensionJwt(mintExtJwt({ expOffsetSec: -60 }), EXT_SECRET), (e) => e instanceof JwtError && e.code === 'token_expired');
});

test('clock tolerance accepts a just-expired token', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const t = mintExtJwt({ expOffsetSec: -3, nowSec });
  assert.doesNotThrow(() => verifyExtensionJwt(t, EXT_SECRET, { nowSec, clockToleranceSec: 5 }));
});

test('wrong secret -> invalid_token', () => {
  const t = mintExtJwt({ secret: crypto.randomBytes(32) });
  assert.throws(() => verifyExtensionJwt(t, EXT_SECRET), (e) => e.code === 'invalid_token' && /signature/.test(e.message));
});

test('base64 string (not decoded) used as key does not verify a properly signed token', () => {
  const t = mintExtJwt();
  assert.throws(() => verifyExtensionJwt(t, Buffer.from(EXT_SECRET.toString('base64'))), (e) => e.code === 'invalid_token');
});

test('alg none / tampered payload rejected', () => {
  const [, p] = mintExtJwt().split('.');
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
  assert.throws(() => verifyHS256(none, EXT_SECRET), (e) => e.code === 'invalid_token');
  const [h, , s] = mintExtJwt().split('.');
  const forged = Buffer.from(JSON.stringify({ exp: 9999999999, channel_id: '1', role: 'broadcaster' })).toString('base64url');
  assert.throws(() => verifyHS256(`${h}.${forged}.${s}`, EXT_SECRET), (e) => e.code === 'invalid_token');
});

test('missing exp, missing channel_id, bad role rejected', () => {
  assert.throws(() => verifyExtensionJwt(signHS256({ channel_id: '1', role: 'viewer' }, EXT_SECRET), EXT_SECRET), /missing exp/);
  assert.throws(() => verifyExtensionJwt(signHS256({ exp: 9999999999, role: 'viewer' }, EXT_SECRET), EXT_SECRET), /channel_id/);
  assert.throws(() => verifyExtensionJwt(signHS256({ exp: 9999999999, channel_id: '1', role: 'admin' }, EXT_SECRET), EXT_SECRET), /role/);
});

test('malformed tokens rejected', () => {
  for (const t of ['', 'abc', 'a.b', 'a.b.c', '...']) assert.throws(() => verifyHS256(t, EXT_SECRET), JwtError);
});

test('bearerFrom parses Authorization header', () => {
  assert.equal(bearerFrom('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerFrom('bearer x'), 'x');
  assert.equal(bearerFrom('Basic x'), null);
  assert.equal(bearerFrom(undefined), null);
});
