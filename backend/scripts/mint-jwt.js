// Mint a Twitch-extension-style JWT signed with TWITCH_EXTENSION_SECRET for local curl testing.
// Usage: node scripts/mint-jwt.js [role=broadcaster] [channel_id=12345] [ttlSec=3600]
import { loadDotEnv } from '../src/config.js';
import { signHS256 } from '../src/auth/jwt.js';
loadDotEnv();
const [role = 'broadcaster', channelId = '12345', ttl = '3600'] = process.argv.slice(2);
const secret = process.env.TWITCH_EXTENSION_SECRET;
if (!secret) { console.error('TWITCH_EXTENSION_SECRET not set'); process.exit(1); }
const payload = {
  exp: Math.floor(Date.now() / 1000) + Number(ttl),
  opaque_user_id: role === 'broadcaster' ? `U${channelId}` : 'A1234567890',
  channel_id: channelId,
  role,
  is_unlinked: false,
  pubsub_perms: { listen: ['broadcast', 'global'], send: role === 'broadcaster' ? ['broadcast'] : [] },
  ...(role === 'broadcaster' ? { user_id: channelId } : {}),
};
process.stdout.write(signHS256(payload, Buffer.from(secret, 'base64')));
