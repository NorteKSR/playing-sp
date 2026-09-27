// Keeps Spotify access tokens fresh per channel; handles revoked refresh tokens.
import { SpotifyAuthError } from './client.js';

export class NotLinkedError extends Error {
  constructor(channelId, reason = 'not_linked') {
    super(`Channel ${channelId} has no usable Spotify link (${reason})`);
    this.reason = reason;
  }
}

export class TokenManager {
  /**
   * @param {{ store: any, spotify: import('./client.js').SpotifyClient, now?: () => number,
   *           refreshSkewMs?: number, onRevoked?: (channelId: string) => void, log?: any }} opts
   */
  constructor({ store, spotify, now = () => Date.now(), refreshSkewMs = 60_000, onRevoked, log = console }) {
    this.store = store;
    this.spotify = spotify;
    this.now = now;
    this.refreshSkewMs = refreshSkewMs;
    this.onRevoked = onRevoked;
    this.log = log;
    this.inflight = new Map();
  }

  /** Returns a valid access token, refreshing if it expires within refreshSkewMs. */
  async getAccessToken(channelId, { force = false } = {}) {
    const link = await this.store.getLink(channelId);
    if (!link || link.status !== 'linked' || !link.refreshToken) throw new NotLinkedError(channelId, link?.lastError || 'not_linked');
    if (!force && link.accessToken && link.expiresAt - this.now() > this.refreshSkewMs) return link.accessToken;
    // De-duplicate concurrent refreshes for the same channel.
    if (!this.inflight.has(channelId)) {
      const p = this._refresh(link).finally(() => this.inflight.delete(channelId));
      this.inflight.set(channelId, p);
    }
    return this.inflight.get(channelId);
  }

  async _refresh(link) {
    try {
      const t = await this.spotify.refresh(link.refreshToken);
      const expiresAt = this.now() + (Number(t.expires_in) || 3600) * 1000;
      await this.store.updateTokens(link.channelId, { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt });
      return t.access_token;
    } catch (e) {
      // invalid_grant = refresh token revoked/expired (user removed app access, password change, etc.)
      if (e instanceof SpotifyAuthError && e.error === 'invalid_grant') {
        this.log.warn?.(`[tokens] refresh token revoked for channel ${link.channelId}; marking unlinked`);
        await this.store.markRevoked(link.channelId, 'revoked');
        this.onRevoked?.(link.channelId);
        throw new NotLinkedError(link.channelId, 'revoked');
      }
      throw e;
    }
  }
}
