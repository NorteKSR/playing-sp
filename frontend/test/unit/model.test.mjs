import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNowPlaying, parseBroadcastMessage, isNewer, normalizeLinkStatus, safeUrl, subtitleFor, parseErrorBody } from '../../src/js/model.js';

const OPTS = { imageHosts: ['i.scdn.co'], linkHosts: ['open.spotify.com'] };
const base = {
  version: 1, type: 'now_playing', channelId: '123', state: 'playing',
  item: { kind: 'track', id: 'x', name: 'Song', artists: ['A', 'B'], album: 'Alb', show: null,
    imageUrl: 'https://i.scdn.co/image/abc', durationMs: 200000, url: 'https://open.spotify.com/track/x', explicit: false },
  progressMs: 42000, isPlaying: true, sampledAt: 1000, updatedAt: 900,
};

test('contract example normalises', () => {
  const r = normalizeNowPlaying(base, OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.value.state, 'playing');
  assert.deepEqual(r.value.item.artists, ['A', 'B']);
  assert.equal(r.value.item.imageUrl, 'https://i.scdn.co/image/abc');
  assert.equal(r.value.progressMs, 42000);
  assert.equal(subtitleFor(r.value.item), 'A, B');
});

test('rejects wrong version / type / non-object', () => {
  assert.equal(normalizeNowPlaying({ ...base, version: 2 }, OPTS).error, 'unsupported_version');
  assert.equal(normalizeNowPlaying({ ...base, type: 'chat' }, OPTS).error, 'unsupported_type');
  assert.equal(normalizeNowPlaying(null).ok, false);
  assert.equal(normalizeNowPlaying([1]).ok, false);
});

test('heartbeat is treated like now_playing', () => {
  const r = normalizeNowPlaying({ ...base, type: 'heartbeat' }, OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.value.type, 'heartbeat');
});

test('null-item states and unknown state strings', () => {
  for (const s of ['nothing_playing', 'ad', 'not_linked', 'unknown']) {
    const r = normalizeNowPlaying({ ...base, state: s, item: null }, OPTS);
    assert.equal(r.value.state, s);
    assert.equal(r.value.item, null);
  }
  assert.equal(normalizeNowPlaying({ ...base, state: 'weird' }, OPTS).value.state, 'unknown');
  assert.equal(normalizeNowPlaying({ ...base, item: null }, OPTS).value.state, 'unknown');
});

test('episode subtitle uses show', () => {
  const r = normalizeNowPlaying({ ...base, item: { ...base.item, kind: 'episode', artists: [], album: null, show: 'Pod' } }, OPTS);
  assert.equal(subtitleFor(r.value.item), 'Pod');
});

test('unsafe URLs are dropped', () => {
  const r = normalizeNowPlaying({ ...base, item: { ...base.item, imageUrl: 'http://i.scdn.co/x', url: 'javascript:alert(1)' } }, OPTS);
  assert.equal(r.value.item.imageUrl, null);
  assert.equal(r.value.item.url, null);
  assert.equal(safeUrl('https://evil.com/x', ['i.scdn.co']), null);
  assert.equal(safeUrl('https://user:pw@i.scdn.co/x', ['i.scdn.co']), null);
});

test('text is sanitised and clamped; progress clamped to duration', () => {
  const r = normalizeNowPlaying({ ...base, progressMs: 999999, item: { ...base.item, name: 'a\u0000b' + 'x'.repeat(1000), artists: ['ok', 5, ''] } }, OPTS);
  assert.ok(r.value.item.name.startsWith('abx'));
  assert.equal(r.value.item.name.length, 300);
  assert.deepEqual(r.value.item.artists, ['ok']);
  assert.equal(r.value.progressMs, 200000);
});

test('paused → isPlaying false even if flag missing', () => {
  const r = normalizeNowPlaying({ ...base, state: 'paused', isPlaying: undefined }, OPTS);
  assert.equal(r.value.isPlaying, false);
});

test('parseBroadcastMessage handles strings, bad JSON, content type', () => {
  assert.equal(parseBroadcastMessage('application/json', JSON.stringify(base), OPTS).ok, true);
  assert.equal(parseBroadcastMessage('application/json', '{bad', OPTS).error, 'invalid_json');
  assert.equal(parseBroadcastMessage('text/plain', JSON.stringify(base), OPTS).error, 'bad_content_type');
  assert.equal(parseBroadcastMessage('application/json', { a: 1 }, OPTS).error, 'not_a_string');
  assert.ok(JSON.stringify(base).length < 5120, 'example payload fits the 5 KB PubSub limit');
});

test('isNewer drops out-of-order messages', () => {
  assert.equal(isNewer({ sampledAt: 5 }, null), true);
  assert.equal(isNewer({ sampledAt: 5 }, { sampledAt: 6 }), false);
  assert.equal(isNewer({ sampledAt: 6 }, { sampledAt: 6 }), true);
  assert.equal(isNewer({ sampledAt: null, updatedAt: null }, { sampledAt: 6 }), true);
});

test('v1.2 serverTime parsed; missing → null', () => {
  assert.equal(normalizeNowPlaying({ ...base, serverTime: 1350 }, OPTS).value.serverTime, 1350);
  assert.equal(normalizeNowPlaying(base, OPTS).value.serverTime, null);
  assert.equal(normalizeNowPlaying({ ...base, serverTime: 'x' }, OPTS).value.serverTime, null);
});

test('v1.2 requiredConfigSet: true/false kept, missing/invalid → null (treated as done)', () => {
  const st = (v) => normalizeLinkStatus({ version: 1, linked: true, spotify: null, ...(v === undefined ? {} : { requiredConfigSet: v }) }).value.requiredConfigSet;
  assert.equal(st(true), true);
  assert.equal(st(false), false);
  assert.equal(st(null), null);
  assert.equal(st(undefined), null);
  assert.equal(st('false'), null);
});

test('link status + error envelope', () => {
  const s = normalizeLinkStatus({ version: 1, linked: true, spotify: { userId: 'u', displayName: 'D', product: 'premium' }, linkedAt: 'x', scopes: ['a'], lastError: null });
  assert.equal(s.value.linked, true);
  assert.equal(s.value.spotify.displayName, 'D');
  assert.equal('product' in s.value.spotify, false, 'product is not part of contract v1.1');
  assert.equal(normalizeLinkStatus({ version: 1, linked: false, spotify: null, lastError: 'revoked' }).value.lastError, 'revoked');
  assert.equal(normalizeLinkStatus({}).ok, false);
  assert.deepEqual(parseErrorBody({ version: 1, error: { code: 'token_expired', message: 'm' } }), { code: 'token_expired', message: 'm' });
  assert.deepEqual(parseErrorBody(null), { code: null, message: null });
});
