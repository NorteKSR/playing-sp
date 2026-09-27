// Twitch Helix "Send Extension PubSub Message" with an EBS-signed JWT, plus a per-channel
// rate limiter that coalesces bursts (latest message wins).
import { signHS256 } from '../auth/jwt.js';

export const PUBSUB_MAX_BYTES = 5 * 1024;

/**
 * JWT payload per https://dev.twitch.tv/docs/api/reference/#send-extension-pubsub-message
 * role must be "external"; user_id = extension owner; channel_id = target broadcaster.
 */
export function buildPubsubJwtPayload({ channelId, ownerId, nowSec = Math.floor(Date.now() / 1000), ttlSec = 60 }) {
  return {
    exp: nowSec + ttlSec,
    user_id: String(ownerId),
    role: 'external',
    channel_id: String(channelId),
    pubsub_perms: { send: ['broadcast'] },
  };
}

export class TwitchPubSubError extends Error {
  constructor(message, status, retryAfterMs = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class TwitchPubSubClient {
  /** @param {{ clientId: string, secret: Buffer, ownerId: string, apiBase?: string, fetch?: typeof fetch, now?: () => number }} o */
  constructor(o) {
    this.clientId = o.clientId;
    this.secret = o.secret;
    this.ownerId = o.ownerId;
    this.apiBase = o.apiBase || 'https://api.twitch.tv/helix';
    this.fetch = o.fetch || globalThis.fetch;
    this.now = o.now || (() => Date.now());
  }

  signJwt(channelId) {
    return signHS256(buildPubsubJwtPayload({ channelId, ownerId: this.ownerId, nowSec: Math.floor(this.now() / 1000) }), this.secret);
  }

  buildRequest(channelId, messageObj) {
    const message = typeof messageObj === 'string' ? messageObj : JSON.stringify(messageObj);
    if (Buffer.byteLength(message, 'utf8') > PUBSUB_MAX_BYTES) throw new TwitchPubSubError('PubSub message exceeds 5 KB', 422);
    return {
      url: `${this.apiBase}/extensions/pubsub`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.signJwt(channelId)}`,
          'Client-Id': this.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target: ['broadcast'], broadcaster_id: String(channelId), message }),
      },
    };
  }

  async send(channelId, messageObj) {
    const { url, init } = this.buildRequest(channelId, messageObj);
    const res = await this.fetch(url, init);
    if (res.status === 204 || res.ok) return;
    let retryAfterMs = null;
    if (res.status === 429) {
      const reset = Number(res.headers.get('ratelimit-reset')); // epoch seconds
      retryAfterMs = Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - this.now()) : 5000;
    }
    const text = await res.text().catch(() => '');
    throw new TwitchPubSubError(`Twitch PubSub send failed: ${res.status} ${text.slice(0, 200)}`, res.status, retryAfterMs);
  }
}

/**
 * Per-channel publisher enforcing Twitch limits: >= minIntervalMs (1 msg/s/channel, Building Extensions
 * guide) and <= maxPerMinute (100/min per client+broadcaster, API reference). Bursts are coalesced so
 * only the latest pending message per channel is sent.
 */
export class RateLimitedPublisher {
  constructor({ client, minIntervalMs = 1000, maxPerMinute = 100, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, log = console, disabled = false }) {
    Object.assign(this, { client, minIntervalMs, maxPerMinute, now, setTimer, clearTimer, log, disabled });
    this.channels = new Map(); // channelId -> { lastSent, history: number[], pending, timer, blockedUntil }
    this.sentCount = 0;
  }

  _ch(id) {
    if (!this.channels.has(id)) this.channels.set(id, { lastSent: 0, history: [], pending: null, timer: null, blockedUntil: 0 });
    return this.channels.get(id);
  }

  /** Queue a message; returns immediately. */
  publish(channelId, message) {
    const ch = this._ch(channelId);
    ch.pending = message;
    this._schedule(channelId);
  }

  _delayFor(ch) {
    const t = this.now();
    ch.history = ch.history.filter((x) => t - x < 60_000);
    let wait = Math.max(0, ch.lastSent + this.minIntervalMs - t, ch.blockedUntil - t);
    if (ch.history.length >= this.maxPerMinute) wait = Math.max(wait, ch.history[0] + 60_000 - t);
    return wait;
  }

  _schedule(channelId) {
    const ch = this._ch(channelId);
    if (ch.timer || !ch.pending) return;
    const wait = this._delayFor(ch);
    ch.timer = this.setTimer(() => {
      ch.timer = null;
      this._flush(channelId);
    }, wait);
    ch.timer?.unref?.();
  }

  async _flush(channelId) {
    const ch = this._ch(channelId);
    const msg = ch.pending;
    if (!msg) return;
    if (this._delayFor(ch) > 0) return this._schedule(channelId);
    ch.pending = null;
    ch.lastSent = this.now();
    const out = msg && typeof msg === 'object' ? { ...msg, serverTime: ch.lastSent } : msg; // EBS clock at send time
    ch.history.push(ch.lastSent);
    try {
      if (this.disabled) this.log.info?.(`[pubsub:dry-run] ${channelId} ${JSON.stringify(out)}`);
      else await this.client.send(channelId, out);
      this.sentCount++;
    } catch (e) {
      this.log.warn?.(`[pubsub] ${channelId}: ${e.message}`);
      if (e.status === 429 || (e.status >= 500 && e.status < 600)) {
        ch.blockedUntil = this.now() + (e.retryAfterMs || 5000);
        if (!ch.pending) ch.pending = msg; // retry unless superseded by a newer message
      }
    }
    this._schedule(channelId);
  }

  /** Test helper: resolve when no timers are pending. */
  stop() {
    for (const ch of this.channels.values()) if (ch.timer) this.clearTimer(ch.timer);
    this.channels.clear();
  }
}
