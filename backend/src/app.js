// HTTP layer: routing, CORS, Twitch JWT auth, OAuth linking endpoints.
import crypto from 'node:crypto';
import { verifyExtensionJwt, bearerFrom } from './auth/twitchAuth.js';
import { JwtError } from './auth/jwt.js';
import { createState, verifyState, createPkcePair, StateError } from './auth/oauthState.js';
import { HttpError, sendJson, sendError, sendCallbackPage, readJsonBody, RateLimiter, CONTRACT_VERSION } from './http/util.js';
import { baseState } from './spotify/normalize.js';
import { channelAllowlist } from './config.js';

const STATE_TTL_SEC = 600;

/**
 * @param {{ config:any, store:any, spotify:import('./spotify/client.js').SpotifyClient, poller:import('./poller/poller.js').Poller,
 *           stateKey:Buffer, now?:()=>number, log?:any }} deps
 * @returns {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse)=>Promise<void>}
 */
export function createApp({ config, store, spotify, poller, stateKey, twitchConfig = null, now = () => Date.now(), log = console }) {
  const limiter = new RateLimiter({ perMinute: config.rateLimitPerMinute ?? 120, now });
  const channelAllowed = channelAllowlist(config.allowedChannelIds);
  const NOT_ALLOWED_MSG = 'This extension is private.';
  const allowed = new Set(config.corsAllowedOrigins || []);
  const reqCfg = config.twitch.requiredConfiguration && config.twitch.extensionVersion && twitchConfig
    ? { value: config.twitch.requiredConfiguration, version: config.twitch.extensionVersion }
    : null;

  const page = (res, status, title, message, ok, reason) =>
    sendCallbackPage(res, status, { title, message, ok, reason, postMessageOrigins: [...allowed] });

  /** Write Twitch's required_configuration for a linked channel (idempotent per value+version). Never throws. */
  async function syncRequiredConfig(channelId, link) {
    if (!reqCfg) return null;
    const cur = link?.requiredConfig;
    if (cur && cur.value === reqCfg.value && cur.version === reqCfg.version) return true;
    try {
      await twitchConfig.setRequiredConfiguration(channelId, reqCfg.value);
      await store.updateLink(channelId, { requiredConfig: { ...reqCfg, setAt: new Date(now()).toISOString() } });
      log.info?.(`[twitch] required_configuration "${reqCfg.value}" set for ${channelId} (v${reqCfg.version})`);
      return true;
    } catch (e) {
      log.warn?.(`[twitch] could not set required_configuration for ${channelId}: ${e.message}`);
      return false;
    }
  }

  const withServerTime = (body) => ({ ...body, serverTime: now() });

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && (allowed.has(origin) || allowed.has('*'))) {
      res.setHeader('Access-Control-Allow-Origin', allowed.has('*') ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function auth(req, { role } = {}) {
    const token = bearerFrom(req.headers.authorization);
    if (!token) throw new HttpError(401, 'missing_token', 'Missing Authorization: Bearer <Twitch extension JWT>');
    let claims;
    try {
      claims = verifyExtensionJwt(token, config.twitch.secret, {
        nowSec: Math.floor(now() / 1000),
        clockToleranceSec: config.twitch.jwtClockToleranceSec ?? 0,
      });
    } catch (e) {
      if (e instanceof JwtError) throw new HttpError(401, e.code, e.message);
      throw e;
    }
    // Channel allowlist (ALLOWED_CHANNEL_IDS): checked after the JWT is verified, before the role check.
    if (!channelAllowed(claims.channelId)) throw new HttpError(403, 'channel_not_allowed', NOT_ALLOWED_MSG);
    if (role && claims.role !== role) throw new HttpError(403, 'forbidden_role', `This endpoint requires role "${role}"`);
    limiter.check(`${claims.channelId}:${claims.opaqueUserId || claims.userId || req.socket.remoteAddress}`);
    return claims;
  }

  async function statusBody(channelId) {
    const link = await store.getLink(channelId);
    const pollError = poller.getLastError(channelId);
    if (!link || link.status !== 'linked') {
      return { version: CONTRACT_VERSION, linked: false, spotify: null, linkedAt: null, scopes: [], lastError: link?.lastError || null, requiredConfigSet: reqCfg ? false : null };
    }
    const requiredConfigSet = await syncRequiredConfig(channelId, link); // retries after failures / version bumps
    return {
      version: CONTRACT_VERSION,
      linked: true,
      spotify: { userId: link.spotifyUserId, displayName: link.displayName },
      linkedAt: link.linkedAt,
      scopes: link.scopes,
      lastError: pollError,
      requiredConfigSet,
    };
  }

  const routes = {
    'GET /healthz': async (req, res) => sendJson(res, 200, { ok: true }),

    'GET /api/now-playing': async (req, res) => {
      const { channelId } = auth(req);
      const link = await store.getLink(channelId);
      if (!link || link.status !== 'linked') return sendJson(res, 200, withServerTime(baseState(channelId, 'not_linked', now())));
      const woke = poller.markViewed(channelId);
      let state = poller.getState(channelId);
      const stale = !state || woke;
      if (stale) {
        // Cold cache (restart, or channel was dormant): do one bounded on-demand poll.
        const r = await Promise.race([poller.pollNow(channelId), new Promise((r) => setTimeout(r, 3000, null).unref?.())]);
        if (r === null) log.warn?.(`[api] on-demand poll timed out for ${channelId}`);
        state = poller.getState(channelId);
      }
      return sendJson(res, 200, withServerTime(state || baseState(channelId, 'unknown', now())));
    },

    'GET /api/config/status': async (req, res) => {
      const { channelId } = auth(req, { role: 'broadcaster' });
      poller.markViewed(channelId);
      sendJson(res, 200, await statusBody(channelId));
    },

    'POST /api/config/link/start': async (req, res) => {
      const { channelId } = auth(req, { role: 'broadcaster' });
      await readJsonBody(req);
      const nonce = crypto.randomBytes(16).toString('base64url');
      const pkce = config.spotify.usePkce ? createPkcePair() : null;
      await store.putPendingAuth(nonce, { channelId, codeVerifier: pkce?.verifier || null }, STATE_TTL_SEC * 1000);
      const state = createState({ channelId, nonce, ttlSec: STATE_TTL_SEC, key: stateKey, nowSec: Math.floor(now() / 1000) });
      const authorizeUrl = spotify.buildAuthorizeUrl({ state, codeChallenge: pkce?.challenge });
      sendJson(res, 200, { version: CONTRACT_VERSION, authorizeUrl, expiresIn: STATE_TTL_SEC });
    },

    'POST /api/config/unlink': async (req, res) => unlink(req, res),
    'DELETE /api/config/link': async (req, res) => unlink(req, res),

    'GET /auth/spotify/callback': async (req, res, url) => {
      const q = url.searchParams;
      let st;
      try {
        st = verifyState(q.get('state'), stateKey, Math.floor(now() / 1000));
      } catch (e) {
        if (e instanceof StateError) return page(res, 400, 'Linking failed', `Invalid or expired link request (${e.message}). Start again from the extension configuration page.`, false, 'invalid_state');
        throw e;
      }
      if (!channelAllowed(st.channelId)) {
        await store.takePendingAuth(st.nonce); // consume it anyway
        return page(res, 403, 'Linking not allowed', `${NOT_ALLOWED_MSG} This Twitch channel is not allowed to use it.`, false, 'channel_not_allowed');
      }
      const pending = await store.takePendingAuth(st.nonce); // one-time use
      if (!pending || pending.channelId !== st.channelId) {
        return page(res, 400, 'Linking failed', 'This link request has expired or was already used. Start again from the extension configuration page.', false, 'expired_state');
      }
      if (q.get('error')) {
        return page(res, 400, 'Linking cancelled', `Spotify returned: ${q.get('error')}. You can try again from the extension configuration page.`, false, q.get('error') === 'access_denied' ? 'access_denied' : 'spotify_error');
      }
      const code = q.get('code');
      if (!code) return page(res, 400, 'Linking failed', 'Missing authorization code.', false, 'missing_code');

      let tokens;
      try {
        tokens = await spotify.exchangeCode(code, pending.codeVerifier);
      } catch (e) {
        log.warn?.(`[oauth] code exchange failed for ${st.channelId}: ${e.message} ${e.error || ''}`);
        return page(res, 400, 'Linking failed', 'Spotify rejected the authorization. Please try again.', false, 'exchange_failed');
      }
      let me = null;
      try {
        const r = await spotify.getMe(tokens.access_token);
        if (r.status === 200) me = r.body;
        else if (r.status === 403) log.warn?.(`[oauth] /me 403 for ${st.channelId}: user likely not on the dev-mode allowlist`);
      } catch (e) {
        log.warn?.(`[oauth] /me failed: ${e.message}`);
      }
      const t = now();
      await store.saveLink({
        channelId: st.channelId,
        status: 'linked',
        spotifyUserId: me?.id ?? null,
        displayName: me?.display_name ?? me?.id ?? null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: t + (Number(tokens.expires_in) || 3600) * 1000,
        scopes: String(tokens.scope || '').split(/\s+/).filter(Boolean),
        linkedAt: new Date(t).toISOString(),
        lastError: null,
      });
      poller.markViewed(st.channelId);
      poller.ensure(st.channelId);
      log.info?.(`[oauth] linked Spotify ${me?.id ?? '?'} to channel ${st.channelId}`);
      await syncRequiredConfig(st.channelId, null);
      page(res, 200, 'Spotify linked', `Spotify account ${me?.display_name || me?.id || ''} is now linked to your Twitch channel.`, true, null);
    },
  };

  async function unlink(req, res) {
    const { channelId } = auth(req, { role: 'broadcaster' });
    await store.deleteLink(channelId);
    poller.remove(channelId, { publish: true });
    if (reqCfg && config.twitch.requiredConfigurationOnUnlink) {
      try {
        await twitchConfig.setRequiredConfiguration(channelId, config.twitch.requiredConfigurationOnUnlink);
      } catch (e) {
        log.warn?.(`[twitch] could not reset required_configuration for ${channelId}: ${e.message}`);
      }
    }
    // Note: Spotify has no token-revocation endpoint; users can remove access at spotify.com/account/apps.
    sendJson(res, 200, { version: CONTRACT_VERSION, linked: false });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://internal');
    try {
      cors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) {
        const pathExists = Object.keys(routes).some((k) => k.split(' ')[1] === url.pathname);
        throw pathExists ? new HttpError(405, 'bad_request', 'Method not allowed') : new HttpError(404, 'not_found', 'Not found');
      }
      await route(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return sendError(res, e);
      log.error?.(`[http] ${req.method} ${url.pathname}: ${e.stack || e}`);
      if (!res.headersSent) sendError(res, new HttpError(500, 'internal_error', 'Internal error'));
    }
  };
}
