// Channel allowlist (ALLOWED_CHANNEL_IDS): config parsing, every HTTP endpoint, OAuth callback, poller.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startHarness, settle } from './harness.js';
import { mintExtJwt, testEnv, testConfig } from './helpers.js';
import { loadConfig, channelAllowlist } from '../src/config.js';
import { createState } from '../src/auth/oauthState.js';

const ALLOWED = '12345';
const BLOCKED = '123456789';

let h;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});

const linkRecord = (channelId) => ({
  channelId, status: 'linked', spotifyUserId: 'u', displayName: 'U', accessToken: 'AT-0', refreshToken: 'RT-0',
  expiresAt: Date.now() + 3600_000, scopes: [], linkedAt: new Date().toISOString(), lastError: null,
});

async function linkVia(channelId) {
  const b = mintExtJwt({ role: 'broadcaster', channelId });
  const r = await h.req('/api/config/link/start', { method: 'POST', token: b });
  assert.equal(r.status, 200);
  const state = new URL((await r.json()).authorizeUrl).searchParams.get('state');
  h.upstream.tokenResponses.push({ status: 200, json: { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, token_type: 'Bearer', scope: 'user-read-currently-playing' } });
  return h.req(`/auth/spotify/callback?code=AUTHCODE&state=${encodeURIComponent(state)}`);
}

async function expectNotAllowed(r, label) {
  assert.equal(r.status, 403, label);
  const j = await r.json();
  assert.equal(j.version, 1, label);
  assert.equal(j.error.code, 'channel_not_allowed', label);
  assert.equal(j.error.message, 'This extension is private.', label);
}

describe('config: ALLOWED_CHANNEL_IDS', () => {
  test('unset or empty -> empty list, every channel allowed', () => {
    for (const v of [undefined, '', ' ', ' , ,, ']) {
      const cfg = loadConfig(testEnv({ ALLOWED_CHANNEL_IDS: v }));
      assert.deepEqual(cfg.allowedChannelIds, [], JSON.stringify(v));
      assert.equal(channelAllowlist(cfg.allowedChannelIds)('987654'), true);
    }
    assert.equal(channelAllowlist(undefined)('1'), true);
  });

  test('trims whitespace, ignores empty entries, dedupes', () => {
    const cfg = testConfig({ ALLOWED_CHANNEL_IDS: ' 111 , 222,,333 ,111, ' });
    assert.deepEqual(cfg.allowedChannelIds, ['111', '222', '333']);
    const allow = channelAllowlist(cfg.allowedChannelIds);
    assert.equal(allow('222'), true);
    assert.equal(allow(333), true);
    assert.equal(allow('444'), false);
  });

  test('non-numeric entry fails startup with a clear error', () => {
    for (const v of ['abc', '123,abc', '12a', '-5', '1.5', '123 456']) {
      assert.throws(() => loadConfig(testEnv({ ALLOWED_CHANNEL_IDS: v })), /ALLOWED_CHANNEL_IDS must be comma-separated numeric Twitch channel IDs/, v);
    }
  });
});

describe('HTTP with ALLOWED_CHANNEL_IDS set', () => {
  const start = async () => { h = await startHarness({ env: { ALLOWED_CHANNEL_IDS: `${ALLOWED}, 55555` } }); };

  test('allowed channel: link start, callback, status, now-playing, unlink all work', async () => {
    await start();
    const cb = await linkVia(ALLOWED);
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /Spotify linked/);
    const b = mintExtJwt({ role: 'broadcaster', channelId: ALLOWED });
    const st = await h.req('/api/config/status', { token: b });
    assert.equal(st.status, 200);
    assert.equal((await st.json()).linked, true);
    const np = await h.req('/api/now-playing', { token: mintExtJwt({ role: 'viewer', channelId: ALLOWED }) });
    assert.equal(np.status, 200);
    assert.equal((await np.json()).state, 'playing');
    const un = await h.req('/api/config/unlink', { method: 'POST', token: b });
    assert.equal(un.status, 200);
    assert.equal((await un.json()).linked, false);
    const del = await h.req('/api/config/link', { method: 'DELETE', token: b });
    assert.equal(del.status, 200);
  });

  test('blocked channel: every endpoint -> 403 channel_not_allowed (same envelope)', async () => {
    await start();
    const v = mintExtJwt({ role: 'viewer', channelId: BLOCKED });
    const b = mintExtJwt({ role: 'broadcaster', channelId: BLOCKED });
    await expectNotAllowed(await h.req('/api/now-playing', { token: v }), 'now-playing viewer');
    await expectNotAllowed(await h.req('/api/now-playing', { token: b }), 'now-playing broadcaster');
    await expectNotAllowed(await h.req('/api/config/status', { token: b }), 'status');
    await expectNotAllowed(await h.req('/api/config/link/start', { method: 'POST', token: b }), 'link/start');
    await expectNotAllowed(await h.req('/api/config/unlink', { method: 'POST', token: b }), 'unlink POST');
    await expectNotAllowed(await h.req('/api/config/link', { method: 'DELETE', token: b }), 'unlink DELETE');
    // Checked before the role check: a viewer of a blocked channel also sees channel_not_allowed on config endpoints.
    await expectNotAllowed(await h.req('/api/config/status', { token: v }), 'status as viewer');
    assert.equal(await h.store.getLink(BLOCKED), null);
  });

  test('blocked channel with a stored link: no data leaks, link untouched by unlink attempt', async () => {
    await start();
    await h.store.saveLink(linkRecord(BLOCKED));
    await expectNotAllowed(await h.req('/api/now-playing', { token: mintExtJwt({ channelId: BLOCKED }) }), 'now-playing');
    await expectNotAllowed(await h.req('/api/config/unlink', { method: 'POST', token: mintExtJwt({ role: 'broadcaster', channelId: BLOCKED }) }), 'unlink');
    assert.equal((await h.store.getLink(BLOCKED)).status, 'linked');
  });

  test('JWT is verified first: missing/invalid/expired tokens still get 401', async () => {
    await start();
    let r = await h.req('/api/now-playing');
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'missing_token');
    r = await h.req('/api/now-playing', { token: mintExtJwt({ channelId: BLOCKED, secret: crypto.randomBytes(32) }) });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'invalid_token');
    r = await h.req('/api/config/status', { token: mintExtJwt({ role: 'broadcaster', channelId: BLOCKED, expOffsetSec: -100 }) });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'token_expired');
  });

  test('callback with a signed state for a blocked channel -> 403 self-closing page, nothing linked, state consumed', async () => {
    await start();
    const nonce = crypto.randomBytes(16).toString('base64url');
    await h.store.putPendingAuth(nonce, { channelId: BLOCKED, codeVerifier: null }, 600_000);
    const state = createState({ channelId: BLOCKED, nonce, ttlSec: 600, key: h.svc.stateKey, nowSec: Math.floor(Date.now() / 1000) });
    const r = await h.req(`/auth/spotify/callback?code=AUTHCODE&state=${encodeURIComponent(state)}`);
    assert.equal(r.status, 403);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();
    assert.match(html, /This extension is private\./);
    assert.match(html, /"reason":"channel_not_allowed"/);
    assert.match(html, /"ok":false/);
    assert.equal(h.upstream.tokenCalls.length, 0, 'no code exchange');
    assert.equal(await h.store.getLink(BLOCKED), null);
    assert.equal(await h.store.takePendingAuth(nonce), null, 'pending auth consumed');
  });

  test('poller skips linked channels that are not allowed (start, ensure, publish)', async () => {
    await start();
    await h.store.saveLink(linkRecord(ALLOWED));
    await h.store.saveLink(linkRecord(BLOCKED));
    await h.svc.poller.start();
    await settle(80);
    assert.equal(h.svc.poller.meta.has(BLOCKED), false, 'blocked channel never scheduled');
    assert.ok(h.svc.poller.getState(ALLOWED), 'allowed channel polled');
    h.svc.poller.ensure(BLOCKED);
    assert.equal(h.svc.poller.meta.has(BLOCKED), false, 'ensure() is a no-op');
    const r = await h.svc.poller.pollNow(BLOCKED);
    assert.equal(r.skipped, 'channel_not_allowed');
    assert.equal(h.svc.poller.getState(BLOCKED), null);
    h.svc.poller.remove(BLOCKED);
    await settle(30);
    const targets = h.upstream.pubsub.map((p) => p.body.broadcaster_id);
    assert.ok(targets.includes(ALLOWED), 'allowed channel published');
    assert.ok(!targets.includes(BLOCKED), 'blocked channel never published');
    const polled = h.fetch.calls.filter((c) => c.url.pathname === '/v1/me/player/currently-playing').length;
    assert.ok(polled >= 1);
  });
});

describe('HTTP with ALLOWED_CHANNEL_IDS unset (default)', () => {
  test('any channel may use every endpoint', async () => {
    h = await startHarness();
    const cb = await linkVia('777777');
    assert.equal(cb.status, 200);
    const b = mintExtJwt({ role: 'broadcaster', channelId: '777777' });
    assert.equal((await h.req('/api/config/status', { token: b })).status, 200);
    assert.equal((await h.req('/api/now-playing', { token: mintExtJwt({ channelId: '777777' }) })).status, 200);
    assert.equal((await h.req('/api/now-playing', { token: mintExtJwt({ channelId: BLOCKED }) })).status, 200);
    assert.equal((await h.req('/api/config/unlink', { method: 'POST', token: b })).status, 200);
  });

  test('empty string behaves like unset', async () => {
    h = await startHarness({ env: { ALLOWED_CHANNEL_IDS: '' } });
    const r = await h.req('/api/now-playing', { token: mintExtJwt({ channelId: BLOCKED }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).state, 'not_linked');
  });
});
