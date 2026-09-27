import test from 'node:test';
import assert from 'node:assert/strict';
import { createEbsClient, EbsError, PATHS } from '../../src/js/api.js';

function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (k) => headers[k] ?? null } };
  };
  f.calls = calls;
  return f;
}

test('sends bearer token to contract path and normalises', async () => {
  const f = fakeFetch(200, { version: 1, type: 'now_playing', state: 'nothing_playing', item: null, progressMs: 0, isPlaying: false });
  const api = createEbsClient({ baseUrl: 'https://ebs.test', getToken: () => 'jwt', fetchImpl: f });
  const np = await api.getNowPlaying();
  assert.equal(np.state, 'nothing_playing');
  assert.equal(f.calls[0].url, 'https://ebs.test' + PATHS.nowPlaying);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer jwt');
  assert.equal(f.calls[0].init.credentials, 'omit');
});

test('maps error envelope + Retry-After', async () => {
  const api = createEbsClient({ baseUrl: 'https://ebs.test', getToken: () => 'jwt', fetchImpl: fakeFetch(429, { version: 1, error: { code: 'rate_limited', message: 'slow down' } }, { 'Retry-After': '7' }) });
  await assert.rejects(api.getNowPlaying(), (e) => e instanceof EbsError && e.status === 429 && e.code === 'rate_limited' && e.retryAfterSec === 7);
});

test('no token → missing_token without fetching', async () => {
  const f = fakeFetch(200, {});
  const api = createEbsClient({ baseUrl: 'https://ebs.test', getToken: () => null, fetchImpl: f });
  await assert.rejects(api.getLinkStatus(), (e) => e.code === 'missing_token');
  assert.equal(f.calls.length, 0);
});

test('startLink validates authorizeUrl', async () => {
  const ok = createEbsClient({ baseUrl: 'https://ebs.test', getToken: () => 'j', fetchImpl: fakeFetch(200, { version: 1, authorizeUrl: 'https://accounts.spotify.com/authorize?x=1', expiresIn: 600 }) });
  assert.equal((await ok.startLink()).authorizeUrl, 'https://accounts.spotify.com/authorize?x=1');
  const bad = createEbsClient({ baseUrl: 'https://ebs.test', getToken: () => 'j', fetchImpl: fakeFetch(200, { version: 1, authorizeUrl: 'javascript:alert(1)' }) });
  await assert.rejects(bad.startLink(), (e) => e.code === 'bad_payload');
});

test('network failure → status 0', async () => {
  const api = createEbsClient({ baseUrl: 'https://ebs.test', getToken: () => 'j', fetchImpl: async () => { throw new TypeError('fail'); } });
  await assert.rejects(api.getNowPlaying(), (e) => e.status === 0 && e.code === 'network_error');
});
