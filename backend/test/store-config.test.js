import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileTokenStore } from '../src/store/tokenStore.js';
import { SecretBox, parseKey } from '../src/crypto/secretBox.js';
import { loadConfig } from '../src/config.js';
import { createState, verifyState } from '../src/auth/oauthState.js';
import { testEnv } from './helpers.js';

test('FileTokenStore encrypts tokens at rest and reloads them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-'));
  const file = path.join(dir, 'tokens.json');
  const box = new SecretBox(crypto.randomBytes(32));
  const s = new FileTokenStore({ file, secretBox: box });
  await s.saveLink({ channelId: '1', status: 'linked', accessToken: 'SECRET-AT', refreshToken: 'SECRET-RT', expiresAt: 1, scopes: [], linkedAt: 'x', lastError: null });
  await s.putPendingAuth('nonce1', { channelId: '1', codeVerifier: 'VERIFIER' }, 60_000);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('SECRET-AT') && !raw.includes('SECRET-RT') && !raw.includes('VERIFIER'));
  assert.match(raw, /enc:v1:/);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const s2 = new FileTokenStore({ file, secretBox: box });
  assert.equal((await s2.getLink('1')).refreshToken, 'SECRET-RT');
  assert.deepEqual(await s2.takePendingAuth('nonce1'), { channelId: '1', codeVerifier: 'VERIFIER' });
  assert.equal(await s2.takePendingAuth('nonce1'), null);
  // wrong key cannot decrypt
  assert.throws(() => new FileTokenStore({ file, secretBox: new SecretBox(crypto.randomBytes(32)) }));
});

test('pending auth expires', async () => {
  let t = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebs-'));
  const s = new FileTokenStore({ file: path.join(dir, 't.json'), secretBox: new SecretBox(crypto.randomBytes(32)), now: () => t });
  await s.putPendingAuth('n', { a: 1 }, 1000);
  t = 2000;
  assert.equal(await s.takePendingAuth('n'), null);
});

test('config validation: required vars, redirect URI rules, key length', () => {
  assert.throws(() => loadConfig({}), /SPOTIFY_CLIENT_ID is required/);
  assert.throws(() => loadConfig(testEnv({ SPOTIFY_REDIRECT_URI: 'http://localhost:8080/cb' })), /localhost/);
  assert.throws(() => loadConfig(testEnv({ SPOTIFY_REDIRECT_URI: 'http://example.com/cb' })), /HTTPS/);
  assert.doesNotThrow(() => loadConfig(testEnv({ SPOTIFY_REDIRECT_URI: 'https://ebs.example.com/auth/spotify/callback' })));
  assert.throws(() => loadConfig(testEnv({ TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=' })), /32 bytes/);
  const c = loadConfig(testEnv({ CORS_ALLOWED_ORIGINS: '' }));
  assert.deepEqual(c.corsAllowedOrigins, ['https://extclientid123.ext-twitch.tv', 'https://localhost:8080'], 'Local Test origin included by default');
  const off = loadConfig(testEnv({ CORS_ALLOWED_ORIGINS: '', TWITCH_LOCAL_TEST_ORIGINS: '' }));
  assert.deepEqual(off.corsAllowedOrigins, ['https://extclientid123.ext-twitch.tv'], 'Local Test origin can be disabled');
  const custom = loadConfig(testEnv({ CORS_ALLOWED_ORIGINS: 'https://a.example', TWITCH_LOCAL_TEST_ORIGINS: 'https://localhost:9443/, https://127.0.0.1:8080' }));
  assert.deepEqual(custom.corsAllowedOrigins, ['https://a.example', 'https://localhost:9443', 'https://127.0.0.1:8080'], 'trailing slash normalised');
  assert.throws(() => loadConfig(testEnv({ TWITCH_LOCAL_TEST_ORIGINS: 'https://localhost:8080/panel.html' })), /bare origin/);
  assert.throws(() => loadConfig(testEnv({ TWITCH_REQUIRED_CONFIGURATION: 'spotify-v1' })), /requires TWITCH_EXTENSION_VERSION/);
  assert.doesNotThrow(() => loadConfig(testEnv({ TWITCH_EXTENSION_VERSION: '0.0.1' })), 'version alone is fine (feature stays off)');
  assert.doesNotThrow(() => loadConfig(testEnv({ TWITCH_REQUIRED_CONFIGURATION: 'spotify-v1', TWITCH_EXTENSION_VERSION: '0.0.1' })));
  assert.equal(parseKey('00'.repeat(32)).length, 32);
});

test('oauth state: signed, expiring, tamper-evident', () => {
  const key = crypto.randomBytes(32);
  const s = createState({ channelId: '9', nonce: 'n', ttlSec: 10, key, nowSec: 100 });
  assert.deepEqual(verifyState(s, key, 105), { channelId: '9', nonce: 'n', exp: 110 });
  assert.throws(() => verifyState(s, key, 111), /expired/);
  assert.throws(() => verifyState(s, crypto.randomBytes(32), 105), /signature/);
  const [, sig] = s.split('.');
  const forged = Buffer.from(JSON.stringify({ c: 'attacker', n: 'n', exp: 999 })).toString('base64url');
  assert.throws(() => verifyState(`${forged}.${sig}`, key, 105), /signature/);
});
