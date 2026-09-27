/**
 * EBS adapter (API_CONTRACT.md v1). All endpoint paths live here; payload parsing lives in model.js.
 */
import { normalizeNowPlaying, normalizeLinkStatus, parseErrorBody } from './model.js';

export const PATHS = Object.freeze({
  nowPlaying: '/api/now-playing',
  linkStatus: '/api/config/status',
  linkStart: '/api/config/link/start',
  unlink: '/api/config/unlink',
});

export class EbsError extends Error {
  constructor(status, code, message, retryAfterSec = null) {
    super(message || code || `HTTP ${status}`);
    this.name = 'EbsError';
    this.status = status; // 0 = network / timeout / bad payload
    this.code = code || (status ? `http_${status}` : 'network_error');
    this.retryAfterSec = retryAfterSec;
  }
  get isAuth() {
    return this.status === 401;
  }
}

/**
 * @param {{baseUrl:string, getToken:()=>string|null, parseOpts?:object, fetchImpl?:Function, timeoutMs?:number}} cfg
 */
export function createEbsClient({ baseUrl, getToken, parseOpts = {}, fetchImpl, timeoutMs = 10_000, allowHttpAuthorizeUrl = false }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function request(method, path) {
    const token = getToken();
    if (!token) throw new EbsError(401, 'missing_token', 'Not authorized yet');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await doFetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' ? '{}' : undefined,
        cache: 'no-store',
        credentials: 'omit',
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (e) {
      throw new EbsError(0, e && e.name === 'AbortError' ? 'timeout' : 'network_error', 'Could not reach the server');
    } finally {
      if (timer) clearTimeout(timer);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const { code, message } = parseErrorBody(body);
      const ra = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
      throw new EbsError(res.status, code, message, Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    if (body === null) throw new EbsError(0, 'bad_payload', 'Invalid JSON from server');
    return body;
  }

  function unwrap(result) {
    if (!result.ok) throw new EbsError(0, 'bad_payload', result.error);
    return result.value;
  }

  return {
    async getNowPlaying() {
      return unwrap(normalizeNowPlaying(await request('GET', PATHS.nowPlaying), parseOpts));
    },
    async getLinkStatus() {
      return unwrap(normalizeLinkStatus(await request('GET', PATHS.linkStatus)));
    },
    /** @returns {Promise<{authorizeUrl:string, expiresIn:number|null}>} */
    async startLink() {
      const body = await request('POST', PATHS.linkStart);
      let url = null;
      try {
        const u = new URL(body && body.authorizeUrl);
        if (u.protocol === 'https:' || (allowHttpAuthorizeUrl && u.protocol === 'http:')) url = u.href;
      } catch {
        url = null;
      }
      if (!url) throw new EbsError(0, 'bad_payload', 'Missing authorize URL');
      return { authorizeUrl: url, expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : null };
    },
    async unlink() {
      return request('POST', PATHS.unlink);
    },
  };
}
