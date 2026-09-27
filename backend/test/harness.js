import http from 'node:http';
import { buildServices } from '../src/services.js';
import { MemoryTokenStore } from '../src/store/tokenStore.js';
import { testConfig, mockFetch, silentLog, trackBody } from './helpers.js';

/**
 * Starts the real HTTP app on an ephemeral port with mocked Spotify + Twitch upstreams.
 * `upstream.spotifyPlaying` controls the currently-playing response.
 */
export async function startHarness({ env = {}, now } = {}) {
  const config = testConfig(env);
  const upstream = {
    spotifyPlaying: { status: 200, json: trackBody() },
    tokenResponses: [],
    pubsub: [],
    requiredConfig: [],
    requiredConfigStatus: 204,
    tokenCalls: [],
    me: { status: 200, json: { id: 'spotuser', display_name: 'Streamer Name' } },
  };
  const fetch = mockFetch(async (url, init) => {
    if (url.origin === 'https://accounts.mock' && url.pathname === '/api/token') {
      const params = Object.fromEntries(new URLSearchParams(init.body));
      upstream.tokenCalls.push({ params, headers: init.headers });
      return upstream.tokenResponses.shift() || { status: 200, json: { access_token: 'AT-new', token_type: 'Bearer', expires_in: 3600, scope: 'user-read-currently-playing user-read-playback-state' } };
    }
    if (url.origin === 'https://api.mock' && url.pathname === '/v1/me') return upstream.me;
    if (url.origin === 'https://api.mock' && url.pathname === '/v1/me/player/currently-playing') return upstream.spotifyPlaying;
    if (url.origin === 'https://twitch.mock' && url.pathname === '/helix/extensions/pubsub') {
      upstream.pubsub.push({ headers: init.headers, body: JSON.parse(init.body) });
      return { status: 204 };
    }
    if (url.origin === 'https://twitch.mock' && url.pathname === '/helix/extensions/required_configuration') {
      upstream.requiredConfig.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
      return { status: upstream.requiredConfigStatus, text: upstream.requiredConfigStatus === 204 ? '' : '{"error":"x"}' };
    }
    return { status: 404, json: { error: 'unmocked' } };
  });
  const store = new MemoryTokenStore();
  const svc = buildServices(config, { fetch, store, log: silentLog, ...(now ? { now } : {}) });
  svc.publisher.minIntervalMs = 0; // make publishes immediate for HTTP tests
  const server = http.createServer(svc.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, { method = 'GET', token, headers = {}, body } = {}) =>
    globalThis.fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body,
    });
  const close = async () => {
    svc.poller.stop();
    svc.publisher.stop();
    await new Promise((r) => server.close(r));
  };
  return { config, svc, store, upstream, fetch, base, req, close };
}

export const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
