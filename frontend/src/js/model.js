/**
 * THE single place where EBS payloads are parsed / normalised (HTTP responses and PubSub messages).
 * Follows /API_CONTRACT.md v1. If the contract changes, change only this file (and api.js for paths).
 *
 * Pure functions only (unit-tested in test/unit/model.test.mjs).
 */

export const CONTRACT_VERSION = 1;

/** Normalised states used by the UI. */
export const STATE = Object.freeze({
  PLAYING: 'playing',
  PAUSED: 'paused',
  NOTHING_PLAYING: 'nothing_playing',
  AD: 'ad',
  NOT_LINKED: 'not_linked',
  UNKNOWN: 'unknown',
});

const KNOWN_STATES = new Set(Object.values(STATE));
const MESSAGE_TYPES = new Set(['now_playing', 'heartbeat']);
const MAX_TEXT = 300;

function text(v, max = MAX_TEXT) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return t ? t.slice(0, max) : null;
}

function num(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Returns the URL string if it is https and its host is allowlisted, else null. */
export function safeUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!allowedHosts.includes(u.hostname.toLowerCase())) return null;
  return u.href;
}

function normalizeItem(raw, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name);
  if (!name) return null;
  const kind = raw.kind === 'episode' ? 'episode' : 'track';
  const artists = Array.isArray(raw.artists)
    ? raw.artists.map((a) => text(a, 200)).filter(Boolean).slice(0, 20)
    : [];
  return {
    kind,
    id: text(raw.id, 100),
    name,
    artists,
    album: text(raw.album),
    show: text(raw.show),
    imageUrl: safeUrl(raw.imageUrl, opts.imageHosts),
    durationMs: num(raw.durationMs),
    url: safeUrl(raw.url, opts.linkHosts),
    explicit: raw.explicit === true,
  };
}

/**
 * Normalise a NowPlaying object (contract §4).
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function normalizeNowPlaying(raw, opts = {}) {
  const o = { imageHosts: opts.imageHosts || [], linkHosts: opts.linkHosts || [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'not_an_object' };
  if (raw.version !== CONTRACT_VERSION) return { ok: false, error: 'unsupported_version' };
  if (raw.type !== undefined && !MESSAGE_TYPES.has(raw.type)) return { ok: false, error: 'unsupported_type' };

  let state = KNOWN_STATES.has(raw.state) ? raw.state : STATE.UNKNOWN;
  let item = null;
  if (state === STATE.PLAYING || state === STATE.PAUSED) {
    item = normalizeItem(raw.item, o);
    if (!item) state = STATE.UNKNOWN; // playing without a usable item → treat as unknown
  }
  const isPlaying = state === STATE.PLAYING && raw.isPlaying !== false;
  let progressMs = num(raw.progressMs) ?? 0;
  if (item && item.durationMs != null) progressMs = Math.min(progressMs, item.durationMs);

  return {
    ok: true,
    value: {
      type: raw.type || 'now_playing',
      channelId: text(raw.channelId, 64),
      state,
      item,
      progressMs,
      isPlaying,
      sampledAt: num(raw.sampledAt),
      updatedAt: num(raw.updatedAt),
      serverTime: num(raw.serverTime), // v1.2 (null from older EBS versions)
    },
  };
}

/**
 * Parse a Twitch.ext.listen('broadcast') callback payload. `message` is always a string.
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function parseBroadcastMessage(contentType, message, opts) {
  if (typeof message !== 'string') return { ok: false, error: 'not_a_string' };
  if (message.length > 16_384) return { ok: false, error: 'too_large' };
  if (contentType && !/json/i.test(contentType)) return { ok: false, error: 'bad_content_type' };
  let raw;
  try {
    raw = JSON.parse(message);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  return normalizeNowPlaying(raw, opts);
}

/**
 * Should `next` replace `current`? Drops out-of-order messages.
 * Uses sampledAt (then updatedAt) as the ordering key; missing timestamps always win.
 */
export function isNewer(next, current) {
  if (!current) return true;
  const a = next.sampledAt ?? next.updatedAt;
  const b = current.sampledAt ?? current.updatedAt;
  if (a == null || b == null) return true;
  return a >= b;
}

/** Normalise GET /api/config/status (contract §3). */
export function normalizeLinkStatus(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== CONTRACT_VERSION) {
    return { ok: false, error: 'unsupported_version' };
  }
  const s = raw.spotify && typeof raw.spotify === 'object' ? raw.spotify : null;
  return {
    ok: true,
    value: {
      linked: raw.linked === true,
      spotify: s
        ? { userId: text(s.userId, 100), displayName: text(s.displayName, 100) }
        : null,
      linkedAt: text(raw.linkedAt, 40),
      scopes: Array.isArray(raw.scopes) ? raw.scopes.map((x) => text(x, 80)).filter(Boolean) : [],
      lastError: text(raw.lastError, 80),
      // v1.2: true | false | null (null = EBS doesn't manage Twitch Required Configuration). Missing → null (treated as done).
      requiredConfigSet: raw.requiredConfigSet === true ? true : raw.requiredConfigSet === false ? false : null,
    },
  };
}

/** Parse the contract error envelope { version, error: {code, message} }. */
export function parseErrorBody(raw) {
  const e = raw && typeof raw === 'object' && raw.error && typeof raw.error === 'object' ? raw.error : null;
  return { code: text(e && e.code, 64) || null, message: text(e && e.message, 300) || null };
}

/** "Artist A, Artist B" for tracks, show name for episodes. */
export function subtitleFor(item) {
  if (!item) return '';
  if (item.kind === 'episode') return item.show || '';
  return item.artists.join(', ');
}
