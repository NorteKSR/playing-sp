// Configuration from environment variables (optionally loaded from a .env file). No secrets are hardcoded.
import fs from 'node:fs';
import path from 'node:path';
import { parseKey } from './crypto/secretBox.js';

/** Tiny .env loader (KEY=VALUE, # comments, optional quotes). Existing env vars win. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

/**
 * Build a validated config object.
 * @param {Record<string,string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const errors = [];
  const req = (k) => {
    const v = env[k];
    if (!v) errors.push(`${k} is required`);
    return v;
  };

  const cfg = {
    port: int(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    logLevel: env.LOG_LEVEL || 'info',

    spotify: {
      clientId: req('SPOTIFY_CLIENT_ID'),
      clientSecret: req('SPOTIFY_CLIENT_SECRET'),
      redirectUri: req('SPOTIFY_REDIRECT_URI'),
      usePkce: bool(env.SPOTIFY_USE_PKCE, true),
      scopes: ['user-read-currently-playing', 'user-read-playback-state'],
      accountsBase: env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com',
      apiBase: env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1',
    },

    twitch: {
      clientId: req('TWITCH_EXTENSION_CLIENT_ID'),
      secretB64: req('TWITCH_EXTENSION_SECRET'),
      ownerId: req('TWITCH_EXTENSION_OWNER_ID'),
      apiBase: env.TWITCH_API_BASE || 'https://api.twitch.tv/helix',
      pubsubDisabled: bool(env.TWITCH_PUBSUB_DISABLED, false),
      jwtClockToleranceSec: int(env.TWITCH_JWT_CLOCK_TOLERANCE_SEC, 5),
      // Helix "Set Extension Required Configuration": enabled only if both are set.
      extensionVersion: env.TWITCH_EXTENSION_VERSION || '',
      requiredConfiguration: env.TWITCH_REQUIRED_CONFIGURATION || '',
      // Value written on unlink (e.g. "unlinked"); empty = leave Twitch's value alone.
      requiredConfigurationOnUnlink: env.TWITCH_REQUIRED_CONFIGURATION_ON_UNLINK || '',
    },

    tokenEncryptionKey: null,
    corsAllowedOrigins: [],

    poll: {
      playingMs: int(env.POLL_INTERVAL_PLAYING_MS, 5000),
      pausedMs: int(env.POLL_INTERVAL_PAUSED_MS, 15000),
      idleMs: int(env.POLL_INTERVAL_IDLE_MS, 30000),
      maxBackoffMs: int(env.POLL_MAX_BACKOFF_MS, 300000),
      quotaBackoffMs: int(env.POLL_QUOTA_BACKOFF_MS, 600000),
      heartbeatMs: int(env.HEARTBEAT_INTERVAL_MS, 60000),
      seekThresholdMs: int(env.SEEK_THRESHOLD_MS, 10000),
      onlyWhenViewed: bool(env.POLL_ONLY_WHEN_VIEWED, true),
      viewerActivityWindowMs: int(env.VIEWER_ACTIVITY_WINDOW_MS, 600000),
      enabled: bool(env.POLLER_ENABLED, true),
    },
    rateLimitPerMinute: int(env.API_RATE_LIMIT_PER_MINUTE, 120),
  };

  if (cfg.twitch.secretB64) {
    const buf = Buffer.from(cfg.twitch.secretB64, 'base64');
    if (buf.length < 16) errors.push('TWITCH_EXTENSION_SECRET must be the base64 secret from the Twitch console');
    cfg.twitch.secret = buf;
  }
  try {
    cfg.tokenEncryptionKey = parseKey(env.TOKEN_ENCRYPTION_KEY);
  } catch (e) {
    errors.push(e.message);
  }
  if (cfg.spotify.redirectUri) {
    try {
      const u = new URL(cfg.spotify.redirectUri);
      const loopback = u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if (u.hostname === 'localhost') errors.push('SPOTIFY_REDIRECT_URI: Spotify disallows "localhost"; use http://127.0.0.1:PORT/... or HTTPS');
      else if (u.protocol !== 'https:' && !loopback) errors.push('SPOTIFY_REDIRECT_URI must be HTTPS (only loopback IP literals may use http)');
    } catch {
      errors.push('SPOTIFY_REDIRECT_URI is not a valid URL');
    }
  }
  const list = (v) => String(v || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
  // Twitch Local Test serves the frontend from the console's "Testing Base URI" origin (default https://localhost:8080).
  // Set TWITCH_LOCAL_TEST_ORIGINS= (empty) in production to disable.
  cfg.localTestOrigins = list(env.TWITCH_LOCAL_TEST_ORIGINS === undefined ? 'https://localhost:8080' : env.TWITCH_LOCAL_TEST_ORIGINS);
  cfg.corsAllowedOrigins = [...new Set([
    ...list(env.CORS_ALLOWED_ORIGINS || (cfg.twitch.clientId ? `https://${cfg.twitch.clientId}.ext-twitch.tv` : '')),
    ...cfg.localTestOrigins,
  ])];
  for (const o of cfg.corsAllowedOrigins) {
    if (o === '*') continue;
    try {
      const u = new URL(o);
      if (u.origin !== o) errors.push(`CORS origin "${o}" must be a bare origin like https://host[:port] (no path)`);
    } catch {
      errors.push(`CORS origin "${o}" is not a valid URL`);
    }
  }
  if (cfg.twitch.requiredConfiguration && !cfg.twitch.extensionVersion) {
    errors.push('TWITCH_REQUIRED_CONFIGURATION requires TWITCH_EXTENSION_VERSION (the feature is enabled only when both are set)');
  }

  if (errors.length) {
    const err = new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
    err.errors = errors;
    throw err;
  }
  return cfg;
}
