// Entry point: node src/server.js
import http from 'node:http';
import { loadConfig, loadDotEnv } from './config.js';
import { buildServices, createLogger } from './services.js';

loadDotEnv();
let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  console.error('See .env.example. Generate local test secrets with: npm run gen-secrets');
  process.exit(1);
}
const log = createLogger(config.logLevel);
const svc = buildServices(config, { log });
const server = http.createServer(svc.handler);
server.requestTimeout = 15000;
server.headersTimeout = 10000;

server.listen(config.port, config.host, async () => {
  log.info(`EBS listening on http://${config.host}:${config.port} (CORS: ${config.corsAllowedOrigins.join(', ') || 'none'})`);
  const n = config.allowedChannelIds?.length || 0;
  log.info(n ? `Channel allowlist: ${n} channel(s) allowed (ALLOWED_CHANNEL_IDS)` : 'Channel allowlist: disabled (all channels allowed)');
  if (config.twitch.pubsubDisabled) log.warn('TWITCH_PUBSUB_DISABLED=true: PubSub messages are only logged');
  if (config.poll.enabled) {
    await svc.poller.start();
    log.info(`Poller started (onlyWhenViewed=${config.poll.onlyWhenViewed})`);
  }
});

function shutdown(sig) {
  log.info(`${sig} received, shutting down`);
  svc.poller.stop();
  svc.publisher.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
