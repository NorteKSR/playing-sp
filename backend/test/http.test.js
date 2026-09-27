import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startHarness, settle } from './harness.js';
import { mintExtJwt, EXT_SECRET } from './helpers.js';
import { verifyHS256 } from '../src/auth/jwt.js';

let h;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

async function linkChannel(channelId = '12345') {
  const b = mintExtJwt({ role: 'broadcaster', channelId });
  const r = await h.req('/api/config/link/start', { method: 'POST', token: b });
  assert.equal(r.status, 200);
  const { authorizeUrl } = await r.json();
  const state = new URL(authorizeUrl).searchParams.get('state');
  h.upstream.tokenResponses.push({ status: 200, json: { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, token_type: 'Bearer', scope: 'user-read-currently-playing user-read-playback-state' } });
  const cb = await h.req(`/auth/spotify/callback?code=AUTHCODE&state=${encodeURIComponent(state)}`);
  return { cb, authorizeUrl, state, b };
}

describe('auth & roles', () => {
  test('healthz needs no auth', async () => {
    const r = await h.req('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });

  test('missing token -> 401 missing_token with error envelope', async () => {
    const r = await h.req('/api/now-playing');
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.version, 1);
    assert.equal(j.error.code, 'missing_token');
  });

  test('expired token -> 401 token_expired', async () => {
    const r = await h.req('/api/now-playing', { token: mintExtJwt({ expOffsetSec: -100 }) });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'token_expired');
  });

  test('wrong secret -> 401 invalid_token', async () => {
    const r = await h.req('/api/now-playing', { token: mintExtJwt({ secret: crypto.randomBytes(32) }) });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'invalid_token');
  });

  test('viewer cannot use config endpoints (403), broadcaster can', async () => {
    for (const [method, path] of [['GET', '/api/config/status'], ['POST', '/api/config/link/start'], ['POST', '/api/config/unlink'], ['DELETE', '/api/config/link']]) {
      const r = await h.req(path, { method, token: mintExtJwt({ role: 'viewer' }) });
      assert.equal(r.status, 403, path);
      assert.equal((await r.json()).error.code, 'forbidden_role');
      const m = await h.req(path, { method, token: mintExtJwt({ role: 'moderator' }) });
      assert.equal(m.status, 403, `moderator ${path}`);
    }
    const ok = await h.req('/api/config/status', { token: mintExtJwt({ role: 'broadcaster' }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { version: 1, linked: false, spotify: null, linkedAt: null, scopes: [], lastError: null, requiredConfigSet: null });
  });

  test('unknown route 404, wrong method 405', async () => {
    assert.equal((await h.req('/nope')).status, 404);
    assert.equal((await h.req('/api/now-playing', { method: 'POST', token: mintExtJwt() })).status, 405);
  });
});

describe('CORS', () => {
  test('preflight from allowed origin', async () => {
    const r = await h.req('/api/now-playing', { method: 'OPTIONS', headers: { Origin: 'https://extclientid123.ext-twitch.tv', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://extclientid123.ext-twitch.tv');
    assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
  });
  test('disallowed origin gets no CORS headers', async () => {
    const r = await h.req('/healthz', { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });
});

describe('Spotify OAuth linking', () => {
  test('link/start returns authorize URL with scopes, redirect, signed state and PKCE', async () => {
    const r = await h.req('/api/config/link/start', { method: 'POST', token: mintExtJwt({ role: 'broadcaster', channelId: '777' }) });
    const j = await r.json();
    assert.equal(j.expiresIn, 600);
    const u = new URL(j.authorizeUrl);
    assert.equal(u.origin + u.pathname, 'https://accounts.mock/authorize');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('client_id'), 'spotify-client-id');
    assert.equal(u.searchParams.get('scope'), 'user-read-currently-playing user-read-playback-state');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:8080/auth/spotify/callback');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    const stateBody = JSON.parse(Buffer.from(u.searchParams.get('state').split('.')[0], 'base64url'));
    assert.equal(stateBody.c, '777');
  });

  test('callback exchanges code (Basic auth + code_verifier), stores tokens, reports linked', async () => {
    const { cb, authorizeUrl } = await linkChannel('12345');
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /Spotify linked/);
    const call = h.upstream.tokenCalls[0];
    assert.equal(call.params.grant_type, 'authorization_code');
    assert.equal(call.params.code, 'AUTHCODE');
    assert.equal(call.params.redirect_uri, 'http://127.0.0.1:8080/auth/spotify/callback');
    assert.equal(call.headers.Authorization, `Basic ${Buffer.from('spotify-client-id:spotify-client-secret').toString('base64')}`);
    // PKCE: verifier must hash to the challenge sent in the authorize URL
    const challenge = new URL(authorizeUrl).searchParams.get('code_challenge');
    assert.equal(crypto.createHash('sha256').update(call.params.code_verifier).digest('base64url'), challenge);

    const link = await h.store.getLink('12345');
    assert.equal(link.accessToken, 'AT-1');
    assert.equal(link.refreshToken, 'RT-1');
    assert.equal(link.spotifyUserId, 'spotuser');

    const s = await h.req('/api/config/status', { token: mintExtJwt({ role: 'broadcaster', channelId: '12345' }) });
    const sj = await s.json();
    assert.equal(sj.linked, true);
    assert.deepEqual(sj.spotify, { userId: 'spotuser', displayName: 'Streamer Name' });
    assert.deepEqual(sj.scopes, ['user-read-currently-playing', 'user-read-playback-state']);
  });

  test('state is single-use (replay rejected)', async () => {
    const { state } = await linkChannel();
    const again = await h.req(`/auth/spotify/callback?code=X&state=${encodeURIComponent(state)}`);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /expired or was already used/);
  });

  test('tampered / missing state rejected; access_denied handled', async () => {
    assert.equal((await h.req('/auth/spotify/callback?code=X&state=abc.def')).status, 400);
    assert.equal((await h.req('/auth/spotify/callback?code=X')).status, 400);
    const r = await h.req('/api/config/link/start', { method: 'POST', token: mintExtJwt({ role: 'broadcaster' }) });
    const state = new URL((await r.json()).authorizeUrl).searchParams.get('state');
    const denied = await h.req(`/auth/spotify/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /cancelled/);
    assert.equal(h.upstream.tokenCalls.length, 0);
  });

  test('token exchange failure -> 400 page, nothing stored', async () => {
    const r = await h.req('/api/config/link/start', { method: 'POST', token: mintExtJwt({ role: 'broadcaster' }) });
    const state = new URL((await r.json()).authorizeUrl).searchParams.get('state');
    h.upstream.tokenResponses.push({ status: 400, json: { error: 'invalid_grant', error_description: 'Invalid authorization code' } });
    const cb = await h.req(`/auth/spotify/callback?code=BAD&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 400);
    assert.equal(await h.store.getLink('12345'), null);
  });
});

describe('now-playing + pubsub + unlink', () => {
  test('not linked -> state not_linked', async () => {
    const r = await h.req('/api/now-playing', { token: mintExtJwt({ channelId: '555' }) });
    const j = await r.json();
    assert.equal(j.state, 'not_linked');
    assert.equal(j.type, 'now_playing');
    assert.equal(j.version, 1);
    assert.equal(j.channelId, '555');
  });

  test('linked -> viewer gets current track; pubsub broadcast sent with valid EBS JWT', async () => {
    await linkChannel('12345');
    await settle(50);
    const r = await h.req('/api/now-playing', { token: mintExtJwt({ role: 'viewer', channelId: '12345' }) });
    const j = await r.json();
    assert.equal(j.state, 'playing');
    assert.equal(j.item.kind, 'track');
    assert.equal(j.item.name, 'Song One');
    assert.deepEqual(j.item.artists, ['Artist A', 'Artist B']);
    assert.equal(j.item.imageUrl, 'https://i.scdn.co/300');
    await settle(50);
    assert.ok(h.upstream.pubsub.length >= 1);
    const p = h.upstream.pubsub[0];
    assert.equal(p.headers['Client-Id'], 'extclientid123');
    const claims = verifyHS256(p.headers.Authorization.replace('Bearer ', ''), EXT_SECRET);
    assert.equal(claims.role, 'external');
    assert.equal(claims.channel_id, '12345');
    assert.deepEqual(p.body.target, ['broadcast']);
    assert.equal(JSON.parse(p.body.message).type, 'now_playing');
  });

  test('unlink deletes link and broadcasts not_linked', async () => {
    const { b } = await linkChannel('12345');
    await settle(50);
    const r = await h.req('/api/config/unlink', { method: 'POST', token: b });
    assert.deepEqual(await r.json(), { version: 1, linked: false });
    assert.equal(await h.store.getLink('12345'), null);
    await settle(30);
    const last = JSON.parse(h.upstream.pubsub.at(-1).body.message);
    assert.equal(last.state, 'not_linked');
    const np = await (await h.req('/api/now-playing', { token: mintExtJwt({ channelId: '12345' }) })).json();
    assert.equal(np.state, 'not_linked');
  });
});
