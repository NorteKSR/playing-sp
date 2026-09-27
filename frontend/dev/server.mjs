// Dev harness: serves the built extension with a MOCK Twitch helper + a mock EBS implementing API_CONTRACT.md.
// Nothing in dev/ is ever included in the production zip (scripts/package.mjs only zips dist/).
//
//   npm run dev                         → harness http://localhost:8081/  +  mock EBS http://localhost:8090
//   EBS_BASE_URL=http://localhost:8080 DEV_EXTENSION_SECRET=<base64> npm run dev
//                                       → views talk to a REAL EBS (../backend) using JWTs signed with that secret
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from '../scripts/build.mjs';
import { signJwt, verifyJwt } from './jwt.mjs';
import { TRACKS } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8081);
const MOCK_EBS_PORT = Number(process.env.MOCK_EBS_PORT || 8090);
const MOCK_EBS = `http://localhost:${MOCK_EBS_PORT}`;
const EBS_BASE_URL = process.env.EBS_BASE_URL || MOCK_EBS;
const SECRET = process.env.DEV_EXTENSION_SECRET || Buffer.from('dev-only-extension-secret').toString('base64');
const CLIENT_ID = process.env.DEV_CLIENT_ID || 'devclientid0000000000000000000';
// Each server instance gets its own build folder so dev / e2e / integration runs can't clobber each other.
const OUT = path.resolve(ROOT, process.env.DEV_OUT_DIR || '.build/dev');
const HELPER_TAG = '<script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"></script>';
const IMAGE_ALLOW = 'https://i.scdn.co'; // == Twitch "Allowlist for Image Domains" (API_CONTRACT v1.1)

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function rebuild() {
  await buildExtension({ outDir: OUT, ebsBaseUrl: EBS_BASE_URL, dev: true, keepAliveMs: process.env.DEV_KEEPALIVE_MS ? Number(process.env.DEV_KEEPALIVE_MS) : undefined });
  console.log(`[dev] built ${path.relative(ROOT, OUT)} (EBS_BASE_URL=${EBS_BASE_URL})`);
}
await rebuild();
let t;
watch(path.join(ROOT, 'src'), { recursive: true }, () => {
  clearTimeout(t);
  t = setTimeout(() => rebuild().catch((e) => console.error('[dev] build failed', e.message)), 150);
});

// CSP modelled on Twitch's hosted CSP (https://dev.twitch.tv/docs/extensions/) so violations show up locally.
// Only difference: the mock helper is served from 'self' instead of extension-files.twitch.tv.
const EXT_CSP = [
  "default-src 'self'",
  `img-src 'self' ${IMAGE_ALLOW} data: blob:`,
  "media-src 'self' data: blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${new URL(EBS_BASE_URL).origin}`,
  "script-src 'self'",
  "object-src 'none'",
].join('; ');

async function sendFile(res, file, transform) {
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    let body = await readFile(file);
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (transform) {
      const r = transform(body.toString('utf8'), headers);
      body = r;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

// ---------------- frontend / harness server ----------------
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  if (p === '/') return sendFile(res, path.join(ROOT, 'dev/harness.html'));
  if (p === '/__dev/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mockEbs: MOCK_EBS, ebsBaseUrl: EBS_BASE_URL, usingMock: EBS_BASE_URL === MOCK_EBS }));
  }
  if (p === '/__dev/token') {
    const role = url.searchParams.get('role') || 'viewer';
    const channelId = url.searchParams.get('channel') || '123456';
    const opaque = role === 'broadcaster' ? `U${channelId}` : 'A' + Math.random().toString(36).slice(2, 12);
    const payload = {
      exp: Math.floor(Date.now() / 1000) + Number(url.searchParams.get('ttl') || 3600),
      opaque_user_id: opaque, channel_id: channelId, role, is_unlinked: false,
      pubsub_perms: { listen: ['broadcast', 'global'], send: role === 'broadcaster' ? ['broadcast'] : [] },
      ...(role === 'broadcaster' ? { user_id: channelId } : {}),
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ token: signJwt(payload, SECRET), channelId, clientId: CLIENT_ID, userId: opaque, role, mockEbs: MOCK_EBS }));
  }
  if (p.startsWith('/__dev/')) return sendFile(res, path.join(ROOT, 'dev', path.normalize(p.slice(7)).replace(/^(\.\.[/\\])+/, '')));
  const file = path.join(OUT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(OUT)) { res.writeHead(403); return res.end(); }
  if (file.endsWith('.html')) {
    return sendFile(res, file, (html, headers) => {
      headers['Content-Security-Policy'] = EXT_CSP;
      if (!html.includes(HELPER_TAG)) throw new Error('helper tag missing');
      return html.replace(HELPER_TAG, '<script src="/__dev/mock-twitch-ext.js"></script>');
    });
  }
  return sendFile(res, file);
}).listen(PORT, () => console.log(`[dev] harness  → http://localhost:${PORT}/`));

// ---------------- mock EBS (API_CONTRACT.md v1) ----------------
const mock = {
  linked: true,
  spotify: { userId: 'mockuser', displayName: 'Mock Streamer' },
  linkedAt: new Date().toISOString(),
  lastError: null,
  np: null,
  failNowPlaying: 0, // number of upcoming /api/now-playing calls that fail with 502
  delayMs: 0,
  nowPlayingCalls: 0,
  linkedLastError: null, // lastError reported while linked (spotify_forbidden, rate_limited, ...)
  requiredConfigSet: null, // v1.2: null = feature disabled, false = pending, true = set
};
function nowPlaying(state, item, progressMs = 0, isPlaying = state === 'playing') {
  const now = Date.now();
  return { version: 1, type: 'now_playing', channelId: '123456', state, item: item || null, progressMs, isPlaying, sampledAt: now, updatedAt: now };
}
mock.np = nowPlaying('playing', TRACKS.trackA, 42_000);

function currentNp() {
  // Re-sample progress like a real EBS cache would.
  const np = { ...mock.np };
  if (np.isPlaying && np.item) {
    const now = Date.now();
    np.progressMs = Math.min(np.progressMs + (now - np.sampledAt), np.item.durationMs);
    np.sampledAt = now;
  }
  return np;
}

const SCENARIOS = {
  playingA: () => nowPlaying('playing', TRACKS.trackA, 42_000),
  playingB: () => nowPlaying('playing', TRACKS.trackB, 150_000),
  playingC: () => nowPlaying('playing', TRACKS.trackC, 5_000),
  nearEnd: () => nowPlaying('playing', TRACKS.trackC, TRACKS.trackC.durationMs - 3_000),
  episode: () => nowPlaying('playing', TRACKS.episode, 1_234_000),
  paused: () => ({ ...currentNp(), state: 'paused', isPlaying: false, sampledAt: Date.now(), updatedAt: Date.now() }),
  resume: () => ({ ...currentNp(), state: 'playing', isPlaying: true, sampledAt: Date.now(), updatedAt: Date.now() }),
  seek: () => ({ ...currentNp(), progressMs: Math.floor((mock.np.item?.durationMs || 0) * 0.8), sampledAt: Date.now(), updatedAt: Date.now() }),
  nothing: () => nowPlaying('nothing_playing', null),
  ad: () => nowPlaying('ad', null),
  unknown: () => nowPlaying('unknown', null),
  notLinked: () => nowPlaying('not_linked', null),
};

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
}
function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}
const err = (res, status, code, message, extra) => json(res, status, { version: 1, error: { code, message } }, extra);
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
const html = (res, status, title, msg) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset=utf-8><title>${title}</title><body style="font-family:sans-serif;background:#121212;color:#fff;padding:24px"><h2>${title}</h2><p>${msg}</p></body>`); };
const pendingStates = new Set();
// Simulated Extension PubSub: everything the "EBS" broadcasts is queued; the harness polls and
// forwards each message to every view through the mock Twitch.ext.listen('broadcast') callbacks.
const broadcasts = [];
let bseq = 0;
// serverTime (v1.2) is stamped when the message is "sent".
function broadcast(np) { broadcasts.push({ seq: ++bseq, message: JSON.stringify({ ...np, serverTime: Date.now() }) }); if (broadcasts.length > 100) broadcasts.shift(); }

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, MOCK_EBS);
  const p = url.pathname;
  if (mock.delayMs && p.startsWith('/api/')) await new Promise((r) => setTimeout(r, mock.delayMs));

  // ---- harness control (dev only) ----
  if (p === '/__mock/scenario' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!SCENARIOS[name]) return err(res, 400, 'bad_request', 'unknown scenario');
    mock.np = SCENARIOS[name]();
    if (name === 'notLinked') { mock.linked = false; mock.spotify = null; mock.linkedAt = null; }
    else if (!mock.linked) { mock.linked = true; mock.spotify = { userId: 'mockuser', displayName: 'Mock Streamer' }; mock.linkedAt = new Date().toISOString(); }
    broadcast(mock.np);
    return json(res, 200, mock.np); // harness forwards this to every view via mock Twitch.ext.listen
  }
  if (p === '/__mock/settings' && req.method === 'POST') {
    const b = await readBody(req);
    if (typeof b.failNowPlaying === 'number') mock.failNowPlaying = b.failNowPlaying;
    if (typeof b.delayMs === 'number') mock.delayMs = b.delayMs;
    if (typeof b.linked === 'boolean') { mock.linked = b.linked; if (!b.linked) { mock.spotify = null; mock.np = nowPlaying('not_linked', null); } }
    if (b.lastError !== undefined) mock.lastError = b.lastError;
    if (b.linkedLastError !== undefined) mock.linkedLastError = b.linkedLastError;
    if (b.requiredConfigSet !== undefined) mock.requiredConfigSet = b.requiredConfigSet;
    return json(res, 200, { ok: true, mock: { ...mock } });
  }
  if (p === '/__mock/state') return json(res, 200, mock);
  if (p === '/__mock/broadcasts') {
    const since = Number(url.searchParams.get('since') || 0);
    return json(res, 200, { seq: bseq, items: broadcasts.filter((b) => b.seq > since) });
  }
  if (p === '/__mock/raw-broadcast' && req.method === 'POST') {
    const b = await readBody(req);
    broadcasts.push({ seq: ++bseq, message: String(b.message) });
    return json(res, 200, { ok: true });
  }
  if (p === '/__mock/authorize') {
    const state = url.searchParams.get('state');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><title>Mock Spotify authorize</title><body style="font-family:sans-serif;background:#121212;color:#fff;padding:24px"><h2>Mock Spotify</h2><p>"Now Playing" wants to read your currently playing track.</p><p><a id="approve" style="color:#1db954" href="/auth/spotify/callback?code=mockcode&state=${encodeURIComponent(state)}">Agree</a> &nbsp; <a id="deny" style="color:#aaa" href="/auth/spotify/callback?error=access_denied&state=${encodeURIComponent(state)}">Cancel</a></p></body>`);
  }
  if (p === '/auth/spotify/callback') {
    const state = url.searchParams.get('state');
    if (!pendingStates.has(state)) return html(res, 400, 'Link failed', 'Invalid or expired state.');
    pendingStates.delete(state);
    if (url.searchParams.get('error')) return html(res, 400, 'Link cancelled', 'Spotify access was denied.');
    mock.linked = true;
    mock.spotify = { userId: 'mockuser', displayName: 'Mock Streamer' };
    mock.linkedAt = new Date().toISOString();
    mock.lastError = null;
    mock.np = nowPlaying('playing', TRACKS.trackC, 5_000);
    broadcast(mock.np);
    return html(res, 200, 'Spotify linked', 'You can close this window.');
  }
  if (p === '/healthz') return json(res, 200, { ok: true });

  // ---- contract endpoints ----
  if (!p.startsWith('/api/')) return err(res, 404, 'not_found', 'unknown route');
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return err(res, 401, 'missing_token', 'missing bearer token');
  const v = verifyJwt(m[1], SECRET);
  if (!v.ok) return err(res, 401, v.code, v.code);
  const role = v.payload.role;

  if (p === '/api/now-playing' && req.method === 'GET') {
    mock.nowPlayingCalls += 1;
    if (mock.failNowPlaying > 0) { mock.failNowPlaying -= 1; return err(res, 502, 'upstream_error', 'Spotify failed (mock)'); }
    const np = mock.linked ? currentNp() : nowPlaying('not_linked', null);
    return json(res, 200, { ...np, serverTime: Date.now() }); // v1.2: stamped when the response is built
  }
  if (p.startsWith('/api/config/') && role !== 'broadcaster') return err(res, 403, 'forbidden_role', 'broadcaster only');
  if (p === '/api/config/status' && req.method === 'GET') {
    return json(res, 200, mock.linked
      ? { version: 1, linked: true, spotify: mock.spotify, linkedAt: mock.linkedAt, scopes: ['user-read-currently-playing', 'user-read-playback-state'], lastError: mock.linkedLastError, requiredConfigSet: mock.requiredConfigSet }
      : { version: 1, linked: false, spotify: null, linkedAt: null, scopes: [], lastError: mock.lastError, requiredConfigSet: mock.requiredConfigSet === null ? null : false });
  }
  if (p === '/api/config/link/start' && req.method === 'POST') {
    const state = Math.random().toString(36).slice(2);
    pendingStates.add(state);
    return json(res, 200, { version: 1, authorizeUrl: `${MOCK_EBS}/__mock/authorize?state=${state}`, expiresIn: 600 });
  }
  if ((p === '/api/config/unlink' && req.method === 'POST') || (p === '/api/config/link' && req.method === 'DELETE')) {
    mock.linked = false; mock.spotify = null; mock.linkedAt = null; mock.lastError = null;
    mock.np = nowPlaying('not_linked', null);
    broadcast(mock.np);
    return json(res, 200, { version: 1, linked: false });
  }
  return err(res, 404, 'not_found', 'unknown route');
}).listen(MOCK_EBS_PORT, () => console.log(`[dev] mock EBS → ${MOCK_EBS}  (views use EBS_BASE_URL=${EBS_BASE_URL})`));
