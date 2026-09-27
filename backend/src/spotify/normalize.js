// Convert Spotify "currently playing" responses into the contract's NowPlaying object.
export const CONTRACT_VERSION = 1;
const MAX_STR = 200;

const trunc = (s) => (typeof s === 'string' && s.length > MAX_STR ? `${s.slice(0, MAX_STR - 1)}…` : s ?? null);

/** Pick a medium (~300px) image from Spotify's widest-first images array. */
function pickImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 0) >= 250) || sorted[sorted.length - 1]).url || null;
}

function normalizeItem(item) {
  if (!item) return null;
  if (item.type === 'track') {
    return {
      kind: 'track',
      id: item.id ?? null, // null for local files
      name: trunc(item.name) || '',
      artists: (item.artists || []).slice(0, 10).map((a) => trunc(a.name)).filter(Boolean),
      album: trunc(item.album?.name),
      show: null,
      imageUrl: pickImage(item.album?.images),
      durationMs: item.duration_ms ?? null,
      url: item.external_urls?.spotify ?? null,
      explicit: !!item.explicit,
    };
  }
  if (item.type === 'episode') {
    return {
      kind: 'episode',
      id: item.id ?? null,
      name: trunc(item.name) || '',
      artists: [],
      album: null,
      show: trunc(item.show?.name),
      imageUrl: pickImage(item.images?.length ? item.images : item.show?.images),
      durationMs: item.duration_ms ?? null,
      url: item.external_urls?.spotify ?? null,
      explicit: !!item.explicit,
    };
  }
  return null;
}

export function baseState(channelId, state, now) {
  return {
    version: CONTRACT_VERSION,
    type: 'now_playing',
    channelId,
    state,
    item: null,
    progressMs: null,
    isPlaying: false,
    sampledAt: now,
    updatedAt: now,
  };
}

/**
 * @param {string} channelId
 * @param {{status:number, body:any}} res  result of SpotifyClient.getCurrentlyPlaying (200 or 204)
 * @param {number} now epoch ms
 */
export function normalizeCurrentlyPlaying(channelId, res, now) {
  if (res.status === 204 || !res.body) return baseState(channelId, 'nothing_playing', now);
  const b = res.body;
  const type = b.currently_playing_type;
  if (type === 'ad') return { ...baseState(channelId, 'ad', now), isPlaying: !!b.is_playing };
  const item = normalizeItem(b.item);
  if (type === 'track' || type === 'episode') {
    if (!item) {
      // Spotify sometimes returns item:null for episodes without additional_types, or during transitions.
      return baseState(channelId, b.is_playing ? 'unknown' : 'nothing_playing', now);
    }
    return {
      ...baseState(channelId, b.is_playing ? 'playing' : 'paused', now),
      item,
      progressMs: b.progress_ms ?? null,
      isPlaying: !!b.is_playing,
    };
  }
  return { ...baseState(channelId, 'unknown', now), isPlaying: !!b.is_playing };
}
