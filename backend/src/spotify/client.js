// Thin Spotify Web API / Accounts client. `fetch` is injectable for tests.

export class SpotifyAuthError extends Error {
  constructor(message, { status, error, description } = {}) {
    super(message);
    this.status = status;
    this.error = error; // e.g. "invalid_grant"
    this.description = description;
  }
}

export class SpotifyClient {
  /**
   * @param {{ clientId: string, clientSecret: string, redirectUri: string, scopes: string[],
   *           accountsBase?: string, apiBase?: string, fetch?: typeof fetch }} opts
   */
  constructor(opts) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.redirectUri = opts.redirectUri;
    this.scopes = opts.scopes;
    this.accountsBase = opts.accountsBase || 'https://accounts.spotify.com';
    this.apiBase = opts.apiBase || 'https://api.spotify.com/v1';
    this.fetch = opts.fetch || globalThis.fetch;
  }

  buildAuthorizeUrl({ state, codeChallenge, showDialog = true }) {
    const u = new URL('/authorize', this.accountsBase);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: this.scopes.join(' '),
      redirect_uri: this.redirectUri,
      state,
      ...(codeChallenge ? { code_challenge_method: 'S256', code_challenge: codeChallenge } : {}),
      ...(showDialog ? { show_dialog: 'true' } : {}),
    }).toString();
    return u.toString();
  }

  async _tokenRequest(params) {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetch(new URL('/api/token', this.accountsBase), {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      throw new SpotifyAuthError(`Spotify token endpoint returned ${res.status}`, {
        status: res.status,
        error: body?.error,
        description: body?.error_description,
      });
    }
    return body;
  }

  /** Authorization code -> tokens. */
  async exchangeCode(code, codeVerifier) {
    return this._tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    });
  }

  /** Refresh; response may or may not include a new refresh_token. */
  async refresh(refreshToken) {
    return this._tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async _api(path, accessToken) {
    const res = await this.fetch(`${this.apiBase}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const out = { status: res.status, body: null, retryAfterSec: null, reason: null };
    if (res.status === 429) {
      const ra = Number.parseInt(res.headers.get('retry-after') || '', 10);
      out.retryAfterSec = Number.isFinite(ra) ? ra : null;
    }
    if (res.status !== 204) {
      const text = await res.text();
      if (text) {
        try {
          out.body = JSON.parse(text);
        } catch {
          out.body = { raw: text.slice(0, 500) };
        }
      }
    }
    out.reason = out.body?.error?.reason || null; // e.g. QUOTA_EXCEEDED (dev-mode quota, Jul 2026)
    return out;
  }

  getMe(accessToken) {
    return this._api('/me', accessToken);
  }

  getCurrentlyPlaying(accessToken) {
    return this._api('/me/player/currently-playing?additional_types=track,episode', accessToken);
  }
}
