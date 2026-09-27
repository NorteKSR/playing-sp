// Token store interface + implementations. Swap FileTokenStore for SQLite/Postgres/Redis by
// implementing the same async methods.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} SpotifyLink
 * @property {string} channelId          Twitch channel (broadcaster) ID
 * @property {'linked'|'revoked'} status
 * @property {string|null} spotifyUserId
 * @property {string|null} displayName
 * @property {string|null} accessToken   plaintext in memory; encrypted at rest
 * @property {string|null} refreshToken  plaintext in memory; encrypted at rest
 * @property {number} expiresAt          epoch ms
 * @property {string[]} scopes
 * @property {string} linkedAt           ISO date
 * @property {string|null} lastError     e.g. "revoked"
 * @property {string} updatedAt
 * @property {{value:string, version:string, setAt:string}|null} [requiredConfig] last required_configuration written to Twitch
 */

/**
 * @interface TokenStore
 *   getLink(channelId): Promise<SpotifyLink|null>
 *   saveLink(link: SpotifyLink): Promise<void>
 *   updateTokens(channelId, {accessToken, refreshToken?, expiresAt}): Promise<void>
 *   updateLink(channelId, patch: Partial<SpotifyLink>): Promise<void> // non-token metadata
 *   markRevoked(channelId, reason): Promise<void>      // wipes tokens, keeps record w/ lastError
 *   deleteLink(channelId): Promise<void>
 *   listLinkedChannels(): Promise<string[]>
 *   putPendingAuth(nonce, data, ttlMs): Promise<void>  // one-time OAuth session (PKCE verifier)
 *   takePendingAuth(nonce): Promise<object|null>        // returns & deletes; null if missing/expired
 */

export class MemoryTokenStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.links = new Map();
    this.pending = new Map();
  }
  async getLink(channelId) {
    const l = this.links.get(channelId);
    return l ? structuredClone(l) : null;
  }
  async saveLink(link) {
    this.links.set(link.channelId, structuredClone({ ...link, updatedAt: new Date(this.now()).toISOString() }));
    await this._persist();
  }
  async updateTokens(channelId, { accessToken, refreshToken, expiresAt }) {
    const l = this.links.get(channelId);
    if (!l) return;
    l.accessToken = accessToken;
    if (refreshToken) l.refreshToken = refreshToken;
    l.expiresAt = expiresAt;
    l.updatedAt = new Date(this.now()).toISOString();
    await this._persist();
  }
  async updateLink(channelId, patch) {
    const l = this.links.get(channelId);
    if (!l) return;
    const { accessToken, refreshToken, channelId: _c, ...safe } = patch;
    Object.assign(l, structuredClone(safe), { updatedAt: new Date(this.now()).toISOString() });
    await this._persist();
  }
  async markRevoked(channelId, reason = 'revoked') {
    const l = this.links.get(channelId);
    if (!l) return;
    Object.assign(l, { status: 'revoked', accessToken: null, refreshToken: null, expiresAt: 0, lastError: reason, updatedAt: new Date(this.now()).toISOString() });
    await this._persist();
  }
  async deleteLink(channelId) {
    this.links.delete(channelId);
    await this._persist();
  }
  async listLinkedChannels() {
    return [...this.links.values()].filter((l) => l.status === 'linked').map((l) => l.channelId);
  }
  async putPendingAuth(nonce, data, ttlMs) {
    this._gcPending();
    this.pending.set(nonce, { data, expiresAt: this.now() + ttlMs });
    await this._persist();
  }
  async takePendingAuth(nonce) {
    const p = this.pending.get(nonce);
    this.pending.delete(nonce);
    this._gcPending();
    await this._persist();
    if (!p || p.expiresAt < this.now()) return null;
    return p.data;
  }
  _gcPending() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k);
  }
  async _persist() {}
}

/**
 * JSON-file-backed store. Tokens (and PKCE verifiers) are encrypted with AES-256-GCM (SecretBox).
 * Writes are atomic (tmp file + rename) and serialized. Suitable for a single EBS instance.
 */
export class FileTokenStore extends MemoryTokenStore {
  /** @param {{ file: string, secretBox: import('../crypto/secretBox.js').SecretBox, now?: () => number }} opts */
  constructor({ file, secretBox, now }) {
    super({ now });
    this.file = file;
    this.box = secretBox;
    this._writing = Promise.resolve();
    this._load();
  }
  _load() {
    if (!fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const l of raw.links || []) {
      this.links.set(l.channelId, { ...l, accessToken: this.box.decrypt(l.accessToken), refreshToken: this.box.decrypt(l.refreshToken) });
    }
    for (const [k, v] of Object.entries(raw.pending || {})) {
      this.pending.set(k, { expiresAt: v.expiresAt, data: JSON.parse(this.box.decrypt(v.data)) });
    }
  }
  _serialize() {
    const links = [...this.links.values()].map((l) => ({
      ...l,
      accessToken: this.box.encrypt(l.accessToken),
      refreshToken: this.box.encrypt(l.refreshToken),
    }));
    const pending = {};
    for (const [k, v] of this.pending) pending[k] = { expiresAt: v.expiresAt, data: this.box.encrypt(JSON.stringify(v.data)) };
    return JSON.stringify({ version: 1, links, pending }, null, 2);
  }
  async _persist() {
    const content = this._serialize();
    this._writing = this._writing.then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, content, { mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    });
    return this._writing;
  }
}
