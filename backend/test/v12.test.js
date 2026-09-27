// Contract v1.2: serverTime, Local Test CORS, callback popup page, Twitch required configuration.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, settle } from './harness.js';
import { mintExtJwt, EXT_SECRET, FakeClock, silentLog } from './helpers.js';
import { verifyHS256 } from '../src/auth/jwt.js';
import { RateLimitedPublisher } from '../src/twitch/pubsub.js';
import { TwitchExtensionConfigClient, buildRequiredConfigJwtPayload } from '../src/twitch/extensionConfig.js';

let h;
afterEach(async () => h && (await h.close()));

async function link(channelId = '12345') {
  const b = mintExtJwt({ role: 'broadcaster', channelId });
  const r = await h.req('/api/config/link/start', { method: 'POST', token: b });
  const state = new URL((await r.json()).authorizeUrl).searchParams.get('state');
  h.upstream.tokenResponses.push({ status: 200, json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'user-read-currently-playing user-read-playback-state' } });
  const cb = await h.req(`/auth/spotify/callback?code=C&state=${encodeURIComponent(state)}`);
  return { cb, b };
}

describe('serverTime', () => {
  test('GET /api/now-playing includes serverTime (not_linked and playing)', async () => {
    h = await startHarness();
    const t0 = Date.now();
    const nl = await (await h.req('/api/now-playing', { token: mintExtJwt() })).json();
    assert.equal(typeof nl.serverTime, 'number');
    assert.ok(nl.serverTime >= t0 && nl.serverTime <= Date.now());
    await link();
    await settle(50);
    const p = await (await h.req('/api/now-playing', { token: mintExtJwt() })).json();
    assert.equal(p.state, 'playing');
    assert.ok(p.serverTime >= p.sampledAt);
  });

  test('PubSub messages carry serverTime stamped at send time (after rate-limit delay)', async () => {
    const clock = new FakeClock();
    const sent = [];
    const pub = new RateLimitedPublisher({ client: { send: async (ch, m) => sent.push(m) }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: silentLog });
    pub.publish('A', { version: 1, type: 'now_playing', sampledAt: clock.now() });
    await clock.advance(0);
    pub.publish('A', { version: 1, type: 'now_playing', sampledAt: clock.now() });
    await clock.advance(1000);
    assert.equal(sent[0].serverTime, sent[0].sampledAt);
    assert.equal(sent[1].serverTime, sent[1].sampledAt + 1000);
  });

  test('real PubSub request body message includes serverTime', async () => {
    h = await startHarness();
    await link();
    await settle(80);
    const m = JSON.parse(h.upstream.pubsub[0].body.message);
    assert.equal(typeof m.serverTime, 'number');
  });
});

describe('CORS for Twitch Local Test', () => {
  test('https://localhost:8080 allowed by default', async () => {
    h = await startHarness();
    const r = await h.req('/api/now-playing', { method: 'OPTIONS', headers: { Origin: 'https://localhost:8080', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://localhost:8080');
    const g = await h.req('/api/now-playing', { token: mintExtJwt(), headers: { Origin: 'https://localhost:8080' } });
    assert.equal(g.headers.get('access-control-allow-origin'), 'https://localhost:8080');
  });
  test('custom TWITCH_LOCAL_TEST_ORIGINS replaces the default', async () => {
    h = await startHarness({ env: { TWITCH_LOCAL_TEST_ORIGINS: 'https://localhost:9443' } });
    const ok = await h.req('/healthz', { headers: { Origin: 'https://localhost:9443' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://localhost:9443');
    const no = await h.req('/healthz', { headers: { Origin: 'https://localhost:8080' } });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
  });
});

describe('OAuth callback popup page', () => {
  test('success page: nonce CSP, auto-close script, postMessage to allowed origins, no inline handlers', async () => {
    h = await startHarness();
    const { cb } = await link();
    assert.equal(cb.status, 200);
    const csp = cb.headers.get('content-security-policy');
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.doesNotMatch(csp, /unsafe-inline/);
    const html = await cb.text();
    assert.match(html, /Spotify linked/);
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.match(html, /window\.close\(\)/);
    assert.match(html, /window\.opener\.postMessage/);
    assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
    assert.match(html, /id="fallback"[^>]*hidden/);
    const data = JSON.parse(/<script id="result" type="application\/json">(.*?)<\/script>/s.exec(html)[1]);
    assert.deepEqual(data.msg, { type: 'spotify_link_result', version: 1, ok: true, reason: null });
    assert.deepEqual(data.origins, ['https://extclientid123.ext-twitch.tv', 'http://localhost:8081', 'https://localhost:8080']);
    assert.equal(data.delay, 1500);
  });

  test('failure pages also close themselves (longer delay) and report a reason', async () => {
    h = await startHarness();
    const r = await h.req('/auth/spotify/callback?code=X&state=bad.state');
    assert.equal(r.status, 400);
    const html = await r.text();
    const data = JSON.parse(/<script id="result" type="application\/json">(.*?)<\/script>/s.exec(html)[1]);
    assert.equal(data.msg.ok, false);
    assert.equal(data.msg.reason, 'invalid_state');
    assert.equal(data.delay, 10000);
    assert.match(html, /window\.close\(\)/);

    const s = await h.req('/api/config/link/start', { method: 'POST', token: mintExtJwt({ role: 'broadcaster' }) });
    const state = new URL((await s.json()).authorizeUrl).searchParams.get('state');
    const denied = await (await h.req(`/auth/spotify/callback?error=access_denied&state=${encodeURIComponent(state)}`)).text();
    assert.match(denied, /"reason":"access_denied"/);
  });

  test('user-controlled text is escaped', async () => {
    h = await startHarness();
    const s = await h.req('/api/config/link/start', { method: 'POST', token: mintExtJwt({ role: 'broadcaster' }) });
    const state = new URL((await s.json()).authorizeUrl).searchParams.get('state');
    const html = await (await h.req(`/auth/spotify/callback?error=${encodeURIComponent('<script>alert(1)</script>')}&state=${encodeURIComponent(state)}`)).text();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

describe('Twitch required configuration', () => {
  const env = { TWITCH_REQUIRED_CONFIGURATION: 'spotify-linked-v1', TWITCH_EXTENSION_VERSION: '0.0.1' };

  test('JWT payload and request format match the Helix docs', async () => {
    assert.deepEqual(buildRequiredConfigJwtPayload({ ownerId: 999, nowSec: 100 }), { exp: 160, user_id: '999', role: 'external' });
    const c = new TwitchExtensionConfigClient({ clientId: 'extid', secret: EXT_SECRET, ownerId: '999', extensionVersion: '1.2.3', apiBase: 'https://twitch.mock/helix' });
    const { url, init } = c.buildRequest('555', 'cfg');
    assert.equal(url, 'https://twitch.mock/helix/extensions/required_configuration?broadcaster_id=555');
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers['Client-Id'], 'extid');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { extension_id: 'extid', extension_version: '1.2.3', required_configuration: 'cfg' });
    const claims = verifyHS256(init.headers.Authorization.replace('Bearer ', ''), EXT_SECRET);
    assert.equal(claims.role, 'external');
    assert.equal(claims.user_id, '999');
  });

  test('set after successful linking; status reports requiredConfigSet', async () => {
    h = await startHarness({ env });
    const { cb, b } = await link('12345');
    assert.equal(cb.status, 200);
    assert.equal(h.upstream.requiredConfig.length, 1);
    const call = h.upstream.requiredConfig[0];
    assert.equal(call.method, 'PUT');
    assert.equal(call.url.searchParams.get('broadcaster_id'), '12345');
    assert.deepEqual(call.body, { extension_id: 'extclientid123', extension_version: '0.0.1', required_configuration: 'spotify-linked-v1' });
    assert.equal(call.headers['Client-Id'], 'extclientid123');
    assert.equal(verifyHS256(call.headers.Authorization.replace('Bearer ', ''), EXT_SECRET).role, 'external');
    const st = await (await h.req('/api/config/status', { token: b })).json();
    assert.equal(st.requiredConfigSet, true);
    assert.equal(h.upstream.requiredConfig.length, 1, 'idempotent: not re-sent when already set for this version');
    assert.equal((await h.store.getLink('12345')).requiredConfig.value, 'spotify-linked-v1');
  });

  test('Twitch failure does not break linking; status retries later', async () => {
    h = await startHarness({ env });
    h.upstream.requiredConfigStatus = 500;
    const { cb, b } = await link('12345');
    assert.equal(cb.status, 200);
    assert.equal((await h.store.getLink('12345')).status, 'linked');
    let st = await (await h.req('/api/config/status', { token: b })).json();
    assert.equal(st.linked, true);
    assert.equal(st.requiredConfigSet, false);
    h.upstream.requiredConfigStatus = 204;
    st = await (await h.req('/api/config/status', { token: b })).json();
    assert.equal(st.requiredConfigSet, true);
    assert.equal(h.upstream.requiredConfig.length, 3);
  });

  test('extension version bump re-syncs on next status call', async () => {
    h = await startHarness({ env });
    const { b } = await link('12345');
    await h.store.updateLink('12345', { requiredConfig: { value: 'spotify-linked-v1', version: '0.0.0', setAt: 'x' } });
    await h.req('/api/config/status', { token: b });
    assert.equal(h.upstream.requiredConfig.length, 2);
  });

  test('unlink leaves Twitch value alone by default', async () => {
    h = await startHarness({ env });
    const { b } = await link('12345');
    await h.req('/api/config/unlink', { method: 'POST', token: b });
    assert.equal(h.upstream.requiredConfig.length, 1);
    const st = await (await h.req('/api/config/status', { token: b })).json();
    assert.equal(st.requiredConfigSet, false);
  });

  test('unlink writes TWITCH_REQUIRED_CONFIGURATION_ON_UNLINK when set', async () => {
    h = await startHarness({ env: { ...env, TWITCH_REQUIRED_CONFIGURATION_ON_UNLINK: 'unlinked' } });
    const { b } = await link('12345');
    await h.req('/api/config/unlink', { method: 'POST', token: b });
    assert.equal(h.upstream.requiredConfig.length, 2);
    assert.equal(h.upstream.requiredConfig[1].body.required_configuration, 'unlinked');
  });

  test('disabled when not configured: no Twitch calls', async () => {
    h = await startHarness();
    const { b } = await link('12345');
    assert.equal(h.upstream.requiredConfig.length, 0);
    assert.equal((await (await h.req('/api/config/status', { token: b })).json()).requiredConfigSet, null);
  });
});
