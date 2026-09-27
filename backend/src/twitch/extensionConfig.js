// Helix "Set Extension Required Configuration"
// https://dev.twitch.tv/docs/api/reference/#set-extension-required-configuration
// PUT /helix/extensions/required_configuration?broadcaster_id=<id>
// Body: { extension_id, extension_version, required_configuration }
// JWT (EBS-signed, HS256 with base64-decoded secret): { exp, user_id: <extension owner>, role: "external" }
import { signHS256 } from '../auth/jwt.js';

export function buildRequiredConfigJwtPayload({ ownerId, nowSec = Math.floor(Date.now() / 1000), ttlSec = 60 }) {
  return { exp: nowSec + ttlSec, user_id: String(ownerId), role: 'external' };
}

export class TwitchApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class TwitchExtensionConfigClient {
  /** @param {{ clientId:string, secret:Buffer, ownerId:string, extensionVersion:string, apiBase?:string, fetch?:typeof fetch, now?:()=>number, timeoutMs?:number }} o */
  constructor(o) {
    this.clientId = o.clientId;
    this.secret = o.secret;
    this.ownerId = o.ownerId;
    this.extensionVersion = o.extensionVersion;
    this.apiBase = o.apiBase || 'https://api.twitch.tv/helix';
    this.fetch = o.fetch || globalThis.fetch;
    this.now = o.now || (() => Date.now());
    this.timeoutMs = o.timeoutMs ?? 5000;
  }

  buildRequest(broadcasterId, requiredConfiguration) {
    const token = signHS256(buildRequiredConfigJwtPayload({ ownerId: this.ownerId, nowSec: Math.floor(this.now() / 1000) }), this.secret);
    return {
      url: `${this.apiBase}/extensions/required_configuration?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
      init: {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': this.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ extension_id: this.clientId, extension_version: this.extensionVersion, required_configuration: requiredConfiguration }),
      },
    };
  }

  async setRequiredConfiguration(broadcasterId, requiredConfiguration) {
    const { url, init } = this.buildRequest(broadcasterId, requiredConfiguration);
    const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 204 || res.ok) return;
    const text = await res.text().catch(() => '');
    throw new TwitchApiError(`Set required configuration failed: ${res.status} ${text.slice(0, 200)}`, res.status);
  }
}
