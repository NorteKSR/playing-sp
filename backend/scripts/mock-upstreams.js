// Local mock of Spotify Accounts, Spotify Web API and Twitch Helix PubSub for smoke tests.
// Usage: TWITCH_EXTENSION_SECRET=... node scripts/mock-upstreams.js [port=9090]
// Control: POST /mock/playing with a JSON body {"status":200,"body":{...}} or {"status":204}
import http from 'node:http';
import { verifyHS256 } from '../src/auth/jwt.js';
import { loadDotEnv } from '../src/config.js';
loadDotEnv();

const port = Number(process.argv[2] || 9090);
const secret = Buffer.from(process.env.TWITCH_EXTENSION_SECRET || '', 'base64');
let playing = {
  status: 200,
  body: {
    progress_ms: 42000, is_playing: true, currently_playing_type: 'track',
    item: { type: 'track', id: '1AbCdEfGhIjKlMnOpQrStU', name: 'Sunrise Parade', duration_ms: 213573, explicit: false,
      external_urls: { spotify: 'https://open.spotify.com/track/1AbCdEfGhIjKlMnOpQrStU' }, artists: [{ name: 'The Sample Band' }],
      album: { name: 'Demo Sessions', images: [{ url: 'https://i.scdn.co/image/mock300', width: 300, height: 300 }] } },
  },
};
const pubsubLog = [];
const requiredConfigLog = [];
const read = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
const json = (res, s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const body = await read(req);
  if (url.pathname === '/api/token') {
    const p = new URLSearchParams(body);
    console.log(`[mock spotify] token grant_type=${p.get('grant_type')} code=${p.get('code') || ''} pkce=${!!p.get('code_verifier')}`);
    if (p.get('code') === 'bad') return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, { access_token: `mock-at-${Date.now()}`, refresh_token: 'mock-rt', expires_in: 3600, token_type: 'Bearer', scope: 'user-read-currently-playing user-read-playback-state' });
  }
  if (url.pathname === '/v1/me') return json(res, 200, { id: 'mockuser', display_name: 'Mock Streamer' });
  if (url.pathname === '/v1/me/player/currently-playing') {
    if (playing.status === 204) { res.writeHead(204); return res.end(); }
    if (playing.status === 429) { res.writeHead(429, { 'Retry-After': '3', 'Content-Type': 'application/json' }); return res.end('{"error":{"status":429,"message":"rate limited"}}'); }
    return json(res, playing.status, playing.body);
  }
  if (url.pathname === '/helix/extensions/pubsub') {
    try {
      const claims = verifyHS256(String(req.headers.authorization).replace(/^Bearer /, ''), secret);
      const b = JSON.parse(body);
      pubsubLog.push({ claims, body: b, clientId: req.headers['client-id'] });
      console.log(`[mock twitch] pubsub ok client-id=${req.headers['client-id']} role=${claims.role} channel=${claims.channel_id} msg=${b.message}`);
      res.writeHead(204); return res.end();
    } catch (e) {
      console.log(`[mock twitch] pubsub rejected: ${e.message}`);
      return json(res, 403, { error: 'Forbidden', message: 'JWT could not be verified' });
    }
  }
  if (url.pathname === '/helix/extensions/required_configuration' && req.method === 'PUT') {
    try {
      const claims = verifyHS256(String(req.headers.authorization).replace(/^Bearer /, ''), secret);
      const b = JSON.parse(body);
      requiredConfigLog.push({ broadcasterId: url.searchParams.get('broadcaster_id'), claims, body: b, clientId: req.headers['client-id'] });
      console.log(`[mock twitch] required_configuration broadcaster=${url.searchParams.get('broadcaster_id')} value=${b.required_configuration} version=${b.extension_version}`);
      res.writeHead(204); return res.end();
    } catch (e) {
      return json(res, 401, { error: 'Unauthorized', message: e.message });
    }
  }
  if (url.pathname === '/mock/required-configuration') return json(res, 200, requiredConfigLog);
  if (url.pathname === '/mock/playing' && req.method === 'POST') { playing = JSON.parse(body); return json(res, 200, { ok: true }); }
  if (url.pathname === '/mock/pubsub') return json(res, 200, pubsubLog);
  json(res, 404, { error: 'not mocked' });
}).listen(port, '127.0.0.1', () => console.log(`mock upstreams on http://127.0.0.1:${port}`));
