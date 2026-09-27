// Prints freshly generated LOCAL TEST values (not real Twitch/Spotify credentials).
import crypto from 'node:crypto';
console.log(`# Local test secrets generated ${new Date().toISOString()}`);
console.log(`TOKEN_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`);
console.log(`# Fake Twitch extension secret for local testing only (real one comes from the Twitch console):`);
console.log(`TWITCH_EXTENSION_SECRET=${crypto.randomBytes(32).toString('base64')}`);
