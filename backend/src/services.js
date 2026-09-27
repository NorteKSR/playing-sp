// Composition root: wires config -> store, clients, poller, app. Injectable fetch/now for tests.
import path from 'node:path';
import { SecretBox, deriveKey } from './crypto/secretBox.js';
import { FileTokenStore } from './store/tokenStore.js';
import { SpotifyClient } from './spotify/client.js';
import { TokenManager } from './spotify/tokenManager.js';
import { TwitchPubSubClient, RateLimitedPublisher } from './twitch/pubsub.js';
import { TwitchExtensionConfigClient } from './twitch/extensionConfig.js';
import { Poller } from './poller/poller.js';
import { createApp } from './app.js';
import { channelAllowlist } from './config.js';

export function createLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  const min = order[level] ?? 20;
  const mk = (lvl, fn) => (order[lvl] >= min ? (...a) => fn(new Date().toISOString(), lvl.toUpperCase(), ...a) : () => {});
  return { debug: mk('debug', console.log), info: mk('info', console.log), warn: mk('warn', console.warn), error: mk('error', console.error) };
}

export function buildServices(config, { fetch = globalThis.fetch, now = () => Date.now(), store, log = createLogger(config.logLevel) } = {}) {
  const box = new SecretBox(config.tokenEncryptionKey);
  store ||= new FileTokenStore({ file: path.join(config.dataDir, 'tokens.json'), secretBox: box, now });
  const stateKey = deriveKey(config.tokenEncryptionKey, 'oauth-state-v1');
  const spotify = new SpotifyClient({ ...config.spotify, fetch });
  const twitchClient = new TwitchPubSubClient({ clientId: config.twitch.clientId, secret: config.twitch.secret, ownerId: config.twitch.ownerId, apiBase: config.twitch.apiBase, fetch, now });
  const publisher = new RateLimitedPublisher({ client: twitchClient, now, log, disabled: config.twitch.pubsubDisabled });
  const tokens = new TokenManager({ store, spotify, now, log, onRevoked: () => {} });
  const poller = new Poller({ store, tokens, spotify, publisher, poll: config.poll, now, log, isChannelAllowed: channelAllowlist(config.allowedChannelIds) });
  const twitchConfig = config.twitch.requiredConfiguration
    ? new TwitchExtensionConfigClient({ clientId: config.twitch.clientId, secret: config.twitch.secret, ownerId: config.twitch.ownerId, extensionVersion: config.twitch.extensionVersion, apiBase: config.twitch.apiBase, fetch, now })
    : null;
  const handler = createApp({ config, store, spotify, poller, stateKey, twitchConfig, now, log });
  return { store, spotify, tokens, publisher, twitchClient, twitchConfig, poller, handler, stateKey, log };
}
