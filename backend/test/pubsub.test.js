import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwitchPubSubClient, RateLimitedPublisher, buildPubsubJwtPayload } from '../src/twitch/pubsub.js';
import { verifyHS256 } from '../src/auth/jwt.js';
import { EXT_SECRET, FakeClock, mockFetch, silentLog } from './helpers.js';

const mkClient = (fetch, now = () => 1_790_000_000_000) => new TwitchPubSubClient({ clientId: 'extclient', secret: EXT_SECRET, ownerId: '999', apiBase: 'https://twitch.mock/helix', fetch, now });

test('PubSub JWT: HS256, role external, user_id=owner, channel_id, pubsub_perms.send=[broadcast], short exp', () => {
  const c = mkClient(null);
  const token = c.signJwt('12345');
  const [h] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  const p = verifyHS256(token, EXT_SECRET, { nowSec: 1_790_000_000 });
  assert.deepEqual(p, { exp: 1_790_000_060, user_id: '999', role: 'external', channel_id: '12345', pubsub_perms: { send: ['broadcast'] } });
  assert.deepEqual(Object.keys(buildPubsubJwtPayload({ channelId: 1, ownerId: 2 })).sort(), ['channel_id', 'exp', 'pubsub_perms', 'role', 'user_id']);
});

test('PubSub request: POST helix/extensions/pubsub with Client-Id, Bearer JWT, JSON body', async () => {
  const fetch = mockFetch(() => ({ status: 204 }));
  const c = mkClient(fetch);
  const msg = { version: 1, type: 'now_playing', channelId: '12345', state: 'paused' };
  await c.send('12345', msg);
  const call = fetch.calls[0];
  assert.equal(call.url.toString(), 'https://twitch.mock/helix/extensions/pubsub');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Client-Id'], 'extclient');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.match(call.init.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const body = JSON.parse(call.body);
  assert.deepEqual(Object.keys(body).sort(), ['broadcaster_id', 'message', 'target']);
  assert.deepEqual(body.target, ['broadcast']);
  assert.equal(body.broadcaster_id, '12345');
  assert.equal(typeof body.message, 'string');
  assert.deepEqual(JSON.parse(body.message), msg);
});

test('message > 5KB rejected before sending', async () => {
  const fetch = mockFetch(() => ({ status: 204 }));
  await assert.rejects(mkClient(fetch).send('1', { big: 'x'.repeat(6000) }), /5 KB/);
  assert.equal(fetch.calls.length, 0);
});

test('non-2xx surfaces error with status; 429 uses Ratelimit-Reset', async () => {
  const now = 1_790_000_000_000;
  const fetch = mockFetch(() => ({ status: 429, headers: { 'Ratelimit-Reset': String(now / 1000 + 3) }, text: 'Too Many Requests' }));
  await assert.rejects(mkClient(fetch, () => now).send('1', {}), (e) => e.status === 429 && e.retryAfterMs === 3000);
  const f403 = mockFetch(() => ({ status: 403, json: { message: 'JWT could not be verified' } }));
  await assert.rejects(mkClient(f403).send('1', {}), (e) => e.status === 403);
});

test('publisher: >=1s between sends per channel and bursts coalesced (latest wins)', async () => {
  const clock = new FakeClock();
  const sent = [];
  const pub = new RateLimitedPublisher({ client: { send: async (ch, m) => sent.push({ ch, m, t: clock.now() }) }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: silentLog });
  pub.publish('A', { n: 1 });
  await clock.advance(0);
  pub.publish('A', { n: 2 });
  pub.publish('A', { n: 3 });
  pub.publish('B', { n: 1 });
  await clock.advance(0);
  assert.deepEqual(sent.map((s) => `${s.ch}${s.m.n}`), ['A1', 'B1']);
  await clock.advance(1000);
  assert.deepEqual(sent.map((s) => `${s.ch}${s.m.n}`), ['A1', 'B1', 'A3']);
  assert.equal(sent[2].t - sent[0].t, 1000);
});

test('publisher: caps at 100/min per channel', async () => {
  const clock = new FakeClock();
  let count = 0;
  const pub = new RateLimitedPublisher({ client: { send: async () => count++ }, minIntervalMs: 0, maxPerMinute: 100, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: silentLog });
  for (let i = 0; i < 150; i++) {
    pub.publish('A', { i });
    await clock.advance(100);
  }
  assert.ok(count <= 100, `sent ${count}`);
  await clock.advance(60_000);
  assert.ok(count > 100);
});

test('publisher: retries after 429 unless superseded', async () => {
  const clock = new FakeClock();
  const calls = [];
  let fail = true;
  const pub = new RateLimitedPublisher({
    client: { send: async (ch, m) => { calls.push(m.n); if (fail) { fail = false; const e = new Error('429'); e.status = 429; e.retryAfterMs = 2000; throw e; } } },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: silentLog,
  });
  pub.publish('A', { n: 1 });
  await clock.advance(0);
  await clock.advance(1500);
  assert.deepEqual(calls, [1]);
  await clock.advance(600);
  assert.deepEqual(calls, [1, 1]);
});
