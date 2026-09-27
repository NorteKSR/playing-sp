/**
 * Build-time configuration.
 *
 * __EBS_BASE_URL__ is replaced by esbuild `define` (see scripts/build.mjs):
 *   - production:  EBS_BASE_URL env var (must be https://), e.g. https://ebs.example.com
 *   - dev harness: the local mock EBS (http://localhost:8090) or any EBS you point it at
 * Remember: the same origin must be in the Twitch console "Allowlist for URL Fetching Domains".
 */
/* global __EBS_BASE_URL__, __DEV_BUILD__, __KEEPALIVE_MS__ */
export const EBS_BASE_URL = String(__EBS_BASE_URL__).replace(/\/+$/, '');

/** Hosts we accept for album art. Every host here must also be in "Allowlist for Image Domains". */
export const ALLOWED_IMAGE_HOSTS = ['i.scdn.co'];

/** Hosts we accept for the "LISTEN ON SPOTIFY" link (also the Panel/Config URL allowlist). */
export const ALLOWED_LINK_HOSTS = ['open.spotify.com'];

/**
 * Viewers see the stream HLS_LATENCY seconds after the broadcaster hears it.
 * When true, viewer views delay applying live updates by context.hlsLatencyBroadcaster
 * so the displayed song matches what the viewer actually hears.
 */
export const SYNC_TO_STREAM_DELAY = true;
export const MAX_STREAM_DELAY_MS = 30_000;

/** Ignore absurd sampledAt ages caused by client clock skew (see progress.js). */
export const MAX_SAMPLE_AGE_MS = 120_000;

export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Keep-alive (API_CONTRACT v1.1): GET /api/now-playing every ~5 min while the view is visible.
 * The EBS only polls Spotify for channels viewed in the last 10 minutes.
 */
export const KEEPALIVE_MS = Number(__KEEPALIVE_MS__); // 300000 in production builds
export const KEEPALIVE_JITTER_MS = Math.min(20_000, KEEPALIVE_MS * 0.1);

/** true only in the dev-harness build (lets the mock EBS return an http:// authorize URL). */
export const DEV_BUILD = __DEV_BUILD__ === true;
