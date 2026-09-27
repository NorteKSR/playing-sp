import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../src/poller/poller.js';
import { TokenManager } from '../src/spotify/tokenManager.js';
import { SpotifyClient } from '../src/spotify/client.js';
import { MemoryTokenStore } from '../src/store/tokenStore.js';
import { detectChange } from '../src/poller/changeDetect.js';
import { FakeClock, mockFetch, silentLog, trackBody, episodeBody, adBody } from './helpers.js';

const CH = '12345';
let clock, store, published, responses, fetch, poller, tokenCalls;

function setup({ poll = {}, expiresIn = 3600_000 } = {}) {
  clock = new FakeClock();
  store = new MemoryTokenStore({ now: clock.now });
  published = [];
  responses = [];
  tokenCalls = [];
  fetch = mockFetch(async (url, init) => {
    if (url.pathname === '/api/token') {
      tokenCalls.push(Object.fromEntries(new URLSearchParams(init.body)));
      return responses.tokenOverride || { status: 200, json: { access_token: `AT-refreshed-${tokenCalls.length}`, expires_in: 3600 } };
    }
    return responses.shift() || { status: 204 };
  });
  const spotify = new SpotifyClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', scopes: [], accountsBase: 'https://accounts.mock', apiBase: 'https://api.mock/v1', fetch });
  const tokens = new TokenManager({ store, spotify, now: clock.now, log: silentLog });
  poller = new Poller({ store, tokens, spotify, publisher: { publish: (ch, m) => published.push(m) }, poll: { onlyWhenViewed: false, ...poll }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: silentLog });
  return store.saveLink({ channelId: CH, status: 'linked', accessToken: 'AT-0', refreshToken: 'RT-0', expiresAt: clock.now() + expiresIn, scopes: [], linkedAt: new Date().toISOString(), spotifyUserId: 'u', displayName: 'U', lastError: null });
}

describe('change detection across Spotify responses', () => {
  beforeEach(() => setup());

  test('200 track -> publish playing; identical sample -> no publish', async () => {
    responses.push({ status: 200, json: trackBody({ progress: 10_000 }) });
    let r = await poller.pollOnce(CH);
    assert.equal(r.change, 'initial');
    assert.equal(published.length, 1);
    assert.equal(published[0].state, 'playing');
    assert.equal(published[0].type, 'now_playing');
    assert.equal(r.delayMs, 5000);
    // requested with additional_types=episode
    assert.match(fetch.calls[0].url.search, /additional_types=track%2Cepisode|additional_types=track,episode/);
    assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer AT-0');

    clock.t += 5000;
    responses.push({ status: 200, json: trackBody({ progress: 15_000 }) });
    r = await poller.pollOnce(CH);
    assert.equal(r.change, null);
    assert.equal(published.length, 1);
    assert.equal(poller.getState(CH).progressMs, 15_000, 'cache keeps fresh progress');
    assert.equal(poller.getState(CH).updatedAt, published[0].updatedAt, 'updatedAt only moves on change');
  });

  test('track change and pause are published', async () => {
    responses.push({ status: 200, json: trackBody({ id: 'a' }) }, { status: 200, json: trackBody({ id: 'b', progress: 0 }) }, { status: 200, json: trackBody({ id: 'b', progress: 500, isPlaying: false }) });
    await poller.pollOnce(CH);
    clock.t += 5000;
    assert.equal((await poller.pollOnce(CH)).change, 'item');
    clock.t += 5000;
    const r = await poller.pollOnce(CH);
    assert.equal(r.change, 'state');
    assert.equal(published.at(-1).state, 'paused');
    assert.equal(r.delayMs, 15000, 'paused backs off');
  });

  test('seek (big progress jump) detected, small drift ignored', async () => {
    responses.push({ status: 200, json: trackBody({ progress: 10_000 }) }, { status: 200, json: trackBody({ progress: 17_000 }) }, { status: 200, json: trackBody({ progress: 90_000 }) });
    await poller.pollOnce(CH);
    clock.t += 5000;
    assert.equal((await poller.pollOnce(CH)).change, null, '2s drift ignored');
    clock.t += 5000;
    assert.equal((await poller.pollOnce(CH)).change, 'seek');
  });

  test('204 -> nothing_playing and idle interval', async () => {
    responses.push({ status: 200, json: trackBody() }, { status: 204 });
    await poller.pollOnce(CH);
    const r = await poller.pollOnce(CH);
    assert.equal(r.change, 'state');
    assert.equal(published.at(-1).state, 'nothing_playing');
    assert.equal(published.at(-1).item, null);
    assert.equal(r.delayMs, 30000);
  });

  test('429 with Retry-After: honored, state untouched, nothing published', async () => {
    responses.push({ status: 200, json: trackBody() }, { status: 429, headers: { 'Retry-After': '7' }, json: { error: { status: 429, message: 'API rate limit exceeded' } } });
    await poller.pollOnce(CH);
    const r = await poller.pollOnce(CH);
    assert.equal(r.status, 429);
    assert.ok(r.delayMs >= 7000 && r.delayMs < 7500, `delay ${r.delayMs}`);
    assert.equal(published.length, 1);
    assert.equal(poller.getState(CH).state, 'playing');
    assert.equal(poller.getLastError(CH), 'rate_limited');
  });

  test('429 QUOTA_EXCEEDED without Retry-After -> long quota backoff', async () => {
    responses.push({ status: 429, json: { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } } });
    const r = await poller.pollOnce(CH);
    assert.equal(r.delayMs, 600000);
    assert.equal(poller.getLastError(CH), 'quota_exceeded');
  });

  test('ad -> state ad, no item', async () => {
    responses.push({ status: 200, json: trackBody() }, { status: 200, json: adBody() });
    await poller.pollOnce(CH);
    const r = await poller.pollOnce(CH);
    assert.equal(r.change, 'state');
    assert.equal(published.at(-1).state, 'ad');
    assert.equal(published.at(-1).item, null);
    assert.equal(r.delayMs, 10000);
  });

  test('episode -> playing with item.kind episode and show name', async () => {
    responses.push({ status: 200, json: episodeBody() });
    await poller.pollOnce(CH);
    const m = published[0];
    assert.equal(m.state, 'playing');
    assert.equal(m.item.kind, 'episode');
    assert.equal(m.item.show, 'My Podcast');
    assert.deepEqual(m.item.artists, []);
    assert.equal(m.item.imageUrl, 'https://i.scdn.co/ep300');
  });

  test('unknown currently_playing_type -> unknown', async () => {
    responses.push({ status: 200, json: { is_playing: true, currently_playing_type: 'unknown', item: null } });
    await poller.pollOnce(CH);
    assert.equal(published[0].state, 'unknown');
  });

  test('5xx -> exponential backoff, recovers', async () => {
    responses.push({ status: 502, text: 'bad gateway' }, { status: 503, text: '' }, { status: 200, json: trackBody() });
    assert.equal((await poller.pollOnce(CH)).delayMs, 30000);
    assert.equal((await poller.pollOnce(CH)).delayMs, 60000);
    assert.equal((await poller.pollOnce(CH)).delayMs, 5000);
  });

  test('403 (dev-mode allowlist / owner not Premium) -> long backoff + lastError', async () => {
    responses.push({ status: 403, json: { error: { status: 403, message: 'Check settings on developer.spotify.com/dashboard, the user may not be registered.' } } });
    const r = await poller.pollOnce(CH);
    assert.equal(r.delayMs, 300000);
    assert.equal(poller.getLastError(CH), 'spotify_forbidden');
  });

  test('near end of track -> poll right after it should end', async () => {
    responses.push({ status: 200, json: trackBody({ progress: 198_000, duration: 200_000 }) });
    const r = await poller.pollOnce(CH);
    assert.equal(r.delayMs, 2750);
  });

  test('heartbeat every 60s while playing without changes', async () => {
    for (let i = 0; i < 14; i++) responses.push({ status: 200, json: trackBody({ progress: 10_000 + i * 5000 }) });
    for (let i = 0; i < 14; i++) {
      await poller.pollOnce(CH);
      clock.t += 5000;
    }
    const hb = published.filter((m) => m.type === 'heartbeat');
    assert.equal(published[0].type, 'now_playing');
    assert.equal(hb.length, 1);
    assert.equal(hb[0].state, 'playing');
  });

  test('scheduled loop runs via timers', async () => {
    for (let i = 0; i < 3; i++) responses.push({ status: 200, json: trackBody({ progress: 10_000 + i * 5000 }) });
    await poller.start();
    await clock.advance(10_001);
    assert.equal(fetch.calls.length, 3);
    poller.stop();
  });
});

describe('token refresh via poller', () => {
  test('refreshes before expiry, keeps old refresh token if none returned', async () => {
    await setup({ expiresIn: 30_000 }); // < 60s skew
    responses.push({ status: 200, json: trackBody() });
    await poller.pollOnce(CH);
    assert.equal(tokenCalls.length, 1);
    assert.deepEqual(tokenCalls[0], { grant_type: 'refresh_token', refresh_token: 'RT-0' });
    const link = await store.getLink(CH);
    assert.equal(link.accessToken, 'AT-refreshed-1');
    assert.equal(link.refreshToken, 'RT-0');
    assert.equal(link.expiresAt, clock.now() + 3600_000);
    assert.equal(fetch.calls.at(-1).init.headers.Authorization, 'Bearer AT-refreshed-1');
  });

  test('rotated refresh token is stored', async () => {
    await setup({ expiresIn: 0 });
    responses.tokenOverride = { status: 200, json: { access_token: 'AT-x', refresh_token: 'RT-rotated', expires_in: 3600 } };
    responses.push({ status: 204 });
    await poller.pollOnce(CH);
    assert.equal((await store.getLink(CH)).refreshToken, 'RT-rotated');
  });

  test('401 from player API forces one refresh and retries', async () => {
    await setup();
    responses.push({ status: 401, json: { error: { status: 401, message: 'The access token expired' } } }, { status: 200, json: trackBody() });
    const r = await poller.pollOnce(CH);
    assert.equal(tokenCalls.length, 1);
    assert.equal(r.change, 'initial');
  });

  test('revoked refresh token (invalid_grant) -> link marked revoked, not_linked broadcast, polling stops', async () => {
    await setup({ expiresIn: 0 });
    responses.tokenOverride = { status: 400, json: { error: 'invalid_grant', error_description: 'Refresh token revoked' } };
    const r = await poller.pollOnce(CH);
    assert.equal(r.delayMs, null);
    const link = await store.getLink(CH);
    assert.equal(link.status, 'revoked');
    assert.equal(link.lastError, 'revoked');
    assert.equal(link.refreshToken, null);
    assert.equal(published.at(-1).state, 'not_linked');
    assert.deepEqual(await store.listLinkedChannels(), []);
  });

  test('concurrent refreshes are de-duplicated', async () => {
    await setup({ expiresIn: 0 });
    const tm = poller.tokens;
    const [a, b] = await Promise.all([tm.getAccessToken(CH), tm.getAccessToken(CH)]);
    assert.equal(a, b);
    assert.equal(tokenCalls.length, 1);
  });

  test('transient refresh failure (500) does not unlink', async () => {
    await setup({ expiresIn: 0 });
    responses.tokenOverride = { status: 500, text: 'oops' };
    const r = await poller.pollOnce(CH);
    assert.equal(r.delayMs, 30000);
    assert.equal((await store.getLink(CH)).status, 'linked');
  });
});

describe('demand-driven polling (POLL_ONLY_WHEN_VIEWED)', () => {
  test('dormant until viewed, woken by markViewed, sleeps again after window', async () => {
    await setup({ poll: { onlyWhenViewed: true, viewerActivityWindowMs: 60_000 } });
    const r = await poller.pollOnce(CH);
    assert.equal(r.dormant, true);
    assert.equal(fetch.calls.length, 0);
    for (let i = 0; i < 30; i++) responses.push({ status: 200, json: trackBody({ progress: 10_000 + i * 5000 }) });
    assert.equal(poller.markViewed(CH), true);
    await clock.advance(0);
    assert.equal(fetch.calls.length, 1);
    await clock.advance(120_000);
    const n = fetch.calls.length;
    assert.ok(n >= 12 && n <= 14, `polled ${n} times within window`);
    await clock.advance(120_000);
    assert.equal(fetch.calls.length, n, 'no polling after activity window');
    poller.stop();
  });
});

test('detectChange unit cases', () => {
  const base = { state: 'playing', item: { kind: 'track', id: 'a', name: 'x', artists: [] }, progressMs: 0, sampledAt: 0 };
  assert.equal(detectChange(null, base), 'initial');
  assert.equal(detectChange(base, { ...base, progressMs: 5000, sampledAt: 5000 }), null);
  assert.equal(detectChange(base, { ...base, item: { ...base.item, id: 'b' } }), 'item');
  const local = { ...base, item: { kind: 'track', id: null, name: 'Local', artists: ['Me'] } };
  assert.equal(detectChange(local, { ...local, item: { ...local.item, name: 'Other' } }), 'item');
});
