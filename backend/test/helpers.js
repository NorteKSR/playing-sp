import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { signHS256 } from '../src/auth/jwt.js';

export const EXT_SECRET_B64 = crypto.randomBytes(32).toString('base64');
export const EXT_SECRET = Buffer.from(EXT_SECRET_B64, 'base64');
export const ENC_KEY_B64 = crypto.randomBytes(32).toString('base64');

export function testEnv(overrides = {}) {
  return {
    SPOTIFY_CLIENT_ID: 'spotify-client-id',
    SPOTIFY_CLIENT_SECRET: 'spotify-client-secret',
    SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:8080/auth/spotify/callback',
    TWITCH_EXTENSION_CLIENT_ID: 'extclientid123',
    TWITCH_EXTENSION_SECRET: EXT_SECRET_B64,
    TWITCH_EXTENSION_OWNER_ID: '999',
    TOKEN_ENCRYPTION_KEY: ENC_KEY_B64,
    SPOTIFY_ACCOUNTS_BASE: 'https://accounts.mock',
    SPOTIFY_API_BASE: 'https://api.mock/v1',
    TWITCH_API_BASE: 'https://twitch.mock/helix',
    CORS_ALLOWED_ORIGINS: 'https://extclientid123.ext-twitch.tv,http://localhost:8081',
    POLL_ONLY_WHEN_VIEWED: 'false',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

export const testConfig = (o) => loadConfig(testEnv(o));

export const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

export function mintExtJwt({ role = 'viewer', channelId = '12345', expOffsetSec = 3600, secret = EXT_SECRET, nowSec = Math.floor(Date.now() / 1000), extra = {} } = {}) {
  return signHS256({ exp: nowSec + expOffsetSec, opaque_user_id: role === 'broadcaster' ? `U${channelId}` : 'A987', channel_id: channelId, role, pubsub_perms: { listen: ['broadcast'] }, ...extra }, secret);
}

/** Programmable fetch mock. handler(url: URL, init) -> {status, json?, text?, headers?} */
export function mockFetch(handler) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init, body: init.body });
    const r = (await handler(url, init, calls.length)) || { status: 404 };
    const headers = new Headers(r.headers || {});
    const bodyText = r.json !== undefined ? JSON.stringify(r.json) : r.text ?? '';
    return new Response(r.status === 204 ? null : bodyText, { status: r.status, headers });
  };
  fn.calls = calls;
  return fn;
}

export class FakeClock {
  constructor(t = 1_790_000_000_000) {
    this.t = t;
    this.timers = [];
    this.seq = 0;
  }
  now = () => this.t;
  setTimer = (fn, ms) => {
    const t = { id: ++this.seq, at: this.t + ms, fn };
    this.timers.push(t);
    return t;
  };
  clearTimer = (t) => {
    this.timers = this.timers.filter((x) => x !== t);
  };
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      await next.fn();
      await new Promise((r) => setImmediate(r));
    }
    this.t = end;
  }
}

// ---- Spotify fixtures ----
export const trackBody = ({ id = 'track1', isPlaying = true, progress = 10_000, duration = 200_000, name = 'Song One' } = {}) => ({
  timestamp: 0,
  progress_ms: progress,
  is_playing: isPlaying,
  currently_playing_type: 'track',
  item: {
    type: 'track',
    id,
    name,
    duration_ms: duration,
    explicit: false,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
    album: { name: 'Album X', images: [{ url: 'https://i.scdn.co/640', width: 640, height: 640 }, { url: 'https://i.scdn.co/300', width: 300, height: 300 }, { url: 'https://i.scdn.co/64', width: 64, height: 64 }] },
  },
});

export const episodeBody = ({ id = 'ep1', isPlaying = true, progress = 5000 } = {}) => ({
  progress_ms: progress,
  is_playing: isPlaying,
  currently_playing_type: 'episode',
  item: { type: 'episode', id, name: 'Episode 1', duration_ms: 3_600_000, explicit: false, external_urls: { spotify: `https://open.spotify.com/episode/${id}` }, images: [{ url: 'https://i.scdn.co/ep300', width: 300, height: 300 }], show: { name: 'My Podcast', images: [] } },
});

export const adBody = () => ({ progress_ms: 1000, is_playing: true, currently_playing_type: 'ad', item: null });
