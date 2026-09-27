// AES-256-GCM encryption for tokens at rest + HKDF-derived subkeys.
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

/** Parse a 32-byte key given as base64 (44 chars) or hex (64 chars). */
export function parseKey(value, name = 'TOKEN_ENCRYPTION_KEY') {
  if (!value) throw new Error(`${name} is required`);
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(value)) buf = Buffer.from(value, 'hex');
  else buf = Buffer.from(value, 'base64');
  if (buf.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes (got ${buf.length})`);
  return buf;
}

/** Derive an independent subkey (e.g. for state signing) from the master key. */
export function deriveKey(masterKey, info) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from(info), 32));
}

export class SecretBox {
  /** @param {Buffer} key 32 bytes */
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    this.key = key;
  }

  encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined) return plaintext;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
  }

  decrypt(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) throw new Error('Value is not encrypted with SecretBox');
    const [ivB, tagB, ctB] = value.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
  }
}
