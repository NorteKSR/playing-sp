// Per-channel adaptive poller for Spotify "currently playing", with change detection + heartbeat.
import { NotLinkedError } from '../spotify/tokenManager.js';
import { normalizeCurrentlyPlaying, baseState } from '../spotify/normalize.js';
import { detectChange } from './changeDetect.js';

export class Poller {
  /**
   * @param {{ store:any, tokens:import('../spotify/tokenManager.js').TokenManager,
   *   spotify:import('../spotify/client.js').SpotifyClient, publisher:{publish(channelId:string,msg:object):void},
   *   poll:object, now?:()=>number, setTimer?:Function, clearTimer?:Function, log?:any,
   *   isChannelAllowed?:(channelId:string)=>boolean }} o
   */
  constructor({ store, tokens, spotify, publisher, poll, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, log = console, isChannelAllowed = () => true }) {
    Object.assign(this, { store, tokens, spotify, publisher, now, setTimer, clearTimer, log, isChannelAllowed });
    this.cfg = {
      playingMs: 5000, pausedMs: 15000, idleMs: 30000, maxBackoffMs: 300000, quotaBackoffMs: 600000,
      heartbeatMs: 60000, seekThresholdMs: 10000, onlyWhenViewed: false, viewerActivityWindowMs: 600000,
      ...poll,
    };
    this.cache = new Map(); // channelId -> NowPlaying
    this.meta = new Map(); // channelId -> { timer, running, errors, lastPublishedAt, lastViewedAt, dormant, lastError }
    this.stopped = false;
  }

  _m(id) {
    if (!this.meta.has(id)) this.meta.set(id, { timer: null, running: null, errors: 0, lastPublishedAt: 0, lastViewedAt: 0, dormant: false, lastError: null });
    return this.meta.get(id);
  }

  async start() {
    this.stopped = false;
    let skipped = 0;
    for (const id of await this.store.listLinkedChannels()) {
      if (this.isChannelAllowed(id)) this.ensure(id);
      else skipped++;
    }
    if (skipped) this.log.info?.(`[poller] skipping ${skipped} linked channel(s) not in ALLOWED_CHANNEL_IDS`);
  }

  stop() {
    this.stopped = true;
    for (const m of this.meta.values()) if (m.timer) this.clearTimer(m.timer);
    for (const m of this.meta.values()) m.timer = null;
  }

  /** Start polling a channel (idempotent). */
  ensure(channelId, delayMs = 0) {
    if (!this.isChannelAllowed(channelId)) return;
    const m = this._m(channelId);
    m.dormant = false;
    if (!m.timer && !m.running) this._schedule(channelId, delayMs);
  }

  getState(channelId) {
    return this.cache.get(channelId) || null;
  }

  getLastError(channelId) {
    return this.meta.get(channelId)?.lastError || null;
  }

  /** Record viewer demand; wakes a dormant channel. Returns true if the channel was woken. */
  markViewed(channelId) {
    const m = this._m(channelId);
    m.lastViewedAt = this.now();
    if (m.dormant) {
      m.dormant = false;
      if (!m.timer && !m.running) this._schedule(channelId, 0);
      return true;
    }
    return false;
  }

  /** Stop polling and broadcast not_linked (used on unlink / revoke). */
  remove(channelId, { publish = true } = {}) {
    const m = this._m(channelId);
    if (m.timer) this.clearTimer(m.timer);
    m.timer = null;
    m.dormant = false;
    const s = baseState(channelId, 'not_linked', this.now());
    this.cache.set(channelId, s);
    if (publish) this._publish(channelId, s);
  }

  /** Poll right now (coalesces with an in-flight poll). */
  pollNow(channelId) {
    const m = this._m(channelId);
    if (m.running) return m.running;
    if (m.timer) {
      this.clearTimer(m.timer);
      m.timer = null;
    }
    return this._run(channelId);
  }

  _schedule(channelId, delayMs) {
    if (this.stopped) return;
    const m = this._m(channelId);
    if (m.timer) this.clearTimer(m.timer);
    m.timer = this.setTimer(() => {
      m.timer = null;
      this._run(channelId);
    }, Math.max(0, delayMs));
    m.timer?.unref?.();
  }

  _run(channelId) {
    const m = this._m(channelId);
    if (!this.isChannelAllowed(channelId)) return Promise.resolve({ delayMs: null, skipped: 'channel_not_allowed' });
    m.running = this.pollOnce(channelId)
      .catch((e) => {
        this.log.error?.(`[poller] ${channelId}: unexpected ${e.stack || e}`);
        return { delayMs: this.cfg.maxBackoffMs };
      })
      .then((r) => {
        m.running = null;
        if (r.delayMs != null && !this.stopped) this._schedule(channelId, r.delayMs);
        return r;
      });
    return m.running;
  }

  _publish(channelId, msg) {
    if (!this.isChannelAllowed(channelId)) return;
    this._m(channelId).lastPublishedAt = this.now();
    try {
      this.publisher.publish(channelId, msg);
    } catch (e) {
      this.log.warn?.(`[poller] publish failed for ${channelId}: ${e.message}`);
    }
  }

  _backoff(m) {
    m.errors++;
    return Math.min(this.cfg.maxBackoffMs, this.cfg.idleMs * 2 ** (m.errors - 1));
  }

  /**
   * One poll cycle. Returns { delayMs: number|null, change?: string|null, status?: number, dormant?: boolean }.
   * delayMs=null means "stop scheduling" (unlinked or dormant).
   */
  async pollOnce(channelId) {
    const m = this._m(channelId);
    const now = this.now();
    if (this.cfg.onlyWhenViewed && now - m.lastViewedAt > this.cfg.viewerActivityWindowMs) {
      m.dormant = true;
      return { delayMs: null, dormant: true };
    }

    let token;
    try {
      token = await this.tokens.getAccessToken(channelId);
    } catch (e) {
      if (e instanceof NotLinkedError) {
        m.lastError = e.reason === 'revoked' ? 'revoked' : null;
        const prev = this.cache.get(channelId);
        if (!prev || prev.state !== 'not_linked') this.remove(channelId, { publish: true });
        return { delayMs: null, change: 'state' };
      }
      m.lastError = 'token_refresh_failed';
      return { delayMs: this._backoff(m) };
    }

    let res;
    try {
      res = await this.spotify.getCurrentlyPlaying(token);
      if (res.status === 401) {
        token = await this.tokens.getAccessToken(channelId, { force: true });
        res = await this.spotify.getCurrentlyPlaying(token);
      }
    } catch (e) {
      if (e instanceof NotLinkedError) {
        m.lastError = 'revoked';
        this.remove(channelId, { publish: true });
        return { delayMs: null, change: 'state' };
      }
      m.lastError = 'network_error';
      this.log.warn?.(`[poller] ${channelId}: ${e.message}`);
      return { delayMs: this._backoff(m) };
    }

    if (res.status === 429) {
      m.lastError = res.reason === 'QUOTA_EXCEEDED' ? 'quota_exceeded' : 'rate_limited';
      const jitter = Math.floor(Math.random() * 500);
      let delayMs;
      if (res.retryAfterSec != null) delayMs = Math.max(1000, res.retryAfterSec * 1000) + jitter;
      else if (res.reason === 'QUOTA_EXCEEDED') delayMs = this.cfg.quotaBackoffMs;
      else delayMs = this._backoff(m);
      this.log.warn?.(`[poller] ${channelId}: 429 (${m.lastError}), retry in ${delayMs}ms`);
      return { delayMs, status: 429 };
    }
    if (res.status === 403) {
      // Dev-mode: user not on the app's allowlist, or app owner lost Premium.
      m.lastError = 'spotify_forbidden';
      this.log.warn?.(`[poller] ${channelId}: 403 ${JSON.stringify(res.body)?.slice(0, 200)}`);
      return { delayMs: this.cfg.maxBackoffMs, status: 403 };
    }
    if (res.status !== 200 && res.status !== 204) {
      m.lastError = `spotify_${res.status}`;
      return { delayMs: this._backoff(m), status: res.status };
    }

    m.errors = 0;
    m.lastError = null;
    const prev = this.cache.get(channelId) || null;
    const next = normalizeCurrentlyPlaying(channelId, res, now);
    const change = detectChange(prev, next, { seekThresholdMs: this.cfg.seekThresholdMs });

    if (change) {
      this.cache.set(channelId, next);
      this._publish(channelId, next);
    } else {
      const merged = { ...next, updatedAt: prev.updatedAt };
      this.cache.set(channelId, merged);
      if (merged.state === 'playing' && now - m.lastPublishedAt >= this.cfg.heartbeatMs) {
        this._publish(channelId, { ...merged, type: 'heartbeat' });
      }
    }
    return { delayMs: this._nextDelay(next), change, status: res.status };
  }

  _nextDelay(s) {
    const c = this.cfg;
    switch (s.state) {
      case 'playing': {
        // Poll shortly after the current item should end to catch the track change quickly.
        if (s.item?.durationMs && s.progressMs != null) {
          const remaining = s.item.durationMs - s.progressMs + 750;
          if (remaining > 1000 && remaining < c.playingMs) return remaining;
        }
        return c.playingMs;
      }
      case 'ad':
        return c.playingMs * 2;
      case 'paused':
      case 'unknown':
        return c.pausedMs;
      default:
        return c.idleMs;
    }
  }
}
