// Integration test against the REAL backend (../backend, unmodified) running on its bundled mock upstreams.
// Starts: mock Spotify/Twitch upstreams (9090), the EBS (8787, CORS for the harness origin), and this frontend's dev
// server (8081) pointed at the EBS with the same extension secret. Drives panel + config in headless Chrome.
//   npm run test:integration
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BACKEND = path.resolve(ROOT, '../backend');
// Ports don't overlap with `npm run dev` (8081/8090) or the e2e test (8181/8190), so they can run in parallel.
const EBS_PORT = 8787, MOCK_PORT = 9090, FE_PORT = 8281, MOCK_EBS_PORT = 8291;
const E = `http://127.0.0.1:${EBS_PORT}`, MK = `http://127.0.0.1:${MOCK_PORT}`, FE = `http://localhost:${FE_PORT}`;
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const SECRET = crypto.randomBytes(32).toString('base64');
const WORK = mkdtempSync(path.join(os.tmpdir(), 'np-int-'));
const env = {
  ...process.env, TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), TWITCH_EXTENSION_SECRET: SECRET,
  PORT: String(EBS_PORT), HOST: '127.0.0.1', DATA_DIR: path.join(WORK, 'data'), LOG_LEVEL: 'warn',
  SPOTIFY_CLIENT_ID: 'int', SPOTIFY_CLIENT_SECRET: 'int', SPOTIFY_REDIRECT_URI: `${E}/auth/spotify/callback`,
  TWITCH_EXTENSION_CLIENT_ID: 'intext', TWITCH_EXTENSION_OWNER_ID: '1000',
  POLL_INTERVAL_PLAYING_MS: '1000', POLL_INTERVAL_IDLE_MS: '1000', POLL_INTERVAL_PAUSED_MS: '1000',
  SPOTIFY_ACCOUNTS_BASE: MK, SPOTIFY_API_BASE: `${MK}/v1`, TWITCH_API_BASE: `${MK}/helix`,
  CORS_ALLOWED_ORIGINS: FE,
  ALLOWED_CHANNEL_IDS: '12345', // v1.3: channel 12345 is allowed; 99999 is used for the private checks
};
const procs = [];
const start = (args, cwd, extra = {}, ready) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  const on = (d) => { out += d; if (!ready || out.includes(ready)) resolve(p); };
  p.stdout.on('data', on); p.stderr.on('data', on);
  p.on('exit', (c) => reject(new Error(`${args[0]} exited ${c}: ${out}`)));
  setTimeout(() => (ready ? reject(new Error(`timeout starting ${args[0]}: ${out}`)) : resolve(p)), 15000);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✔ ${name}`); } catch (e) { results.push(false); console.log(`  ✘ ${name}\n      ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

let browser;
try {
  await start([path.join(BACKEND, 'scripts/mock-upstreams.js'), String(MOCK_PORT)], WORK, {}, 'mock upstreams');
  await start([path.join(BACKEND, 'src/server.js')], WORK);
  for (let i = 0; i < 50; i++) { try { if ((await fetch(E + '/healthz')).ok) break; } catch { /* wait */ } await sleep(100); }
  await start(['dev/server.mjs'], ROOT, { EBS_BASE_URL: E, DEV_EXTENSION_SECRET: SECRET, PORT: String(FE_PORT), MOCK_EBS_PORT: String(MOCK_EBS_PORT), DEV_OUT_DIR: '.build/integration' }, 'mock EBS');

  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 700, height: 500 } });
  const errors = [];
  context.on('page', (p) => p.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); }));
  const panel = await context.newPage();
  panel.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
  const state = (p) => p.evaluate(() => document.getElementById('app').dataset.state);
  const waitState = async (p, want, t = 8000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < t) { s = await state(p); if (s === want) return; await sleep(150); } throw new Error(`expected ${want}, got ${s}`); };

  const npBodies = [];
  panel.on('response', async (r) => { if (r.url().endsWith('/api/now-playing') && r.request().method() === 'GET') { try { npBodies.push(await r.json()); } catch { /* preflight */ } } });
  const statusBodies = [];
  context.on('response', async (r) => { if (r.url().endsWith('/api/config/status')) { try { statusBodies.push(await r.json()); } catch { /* ignore */ } } });
  console.log('Integration vs real EBS', E);
  await panel.goto(`${FE}/panel.html?channel=12345&anchor=panel&mode=viewer`);
  await check('panel: real EBS returns not_linked (CORS + JWT accepted)', () => waitState(panel, 'not_linked'));

  const cfg = await context.newPage();
  await cfg.goto(`${FE}/config.html?channel=12345&mode=config`);
  await check('config: real status → Not connected', () => waitState(cfg, 'unlinked'));

  await check('config: Connect → popup gets real authorizeUrl → callback → polling reaches Connected', async () => {
    const popupP = context.waitForEvent('page');
    await cfg.getByRole('button', { name: 'Connect Spotify' }).click();
    const popup = await popupP;
    await popup.waitForURL(/\/authorize\?/, { timeout: 5000 }).catch(() => {});
    const u = new URL(popup.url());
    const st = u.searchParams.get('state');
    assert(st, 'no state in authorize URL ' + popup.url());
    await popup.goto(`${E}/auth/spotify/callback?code=intcode&state=${encodeURIComponent(st)}`);
    assert((await popup.textContent('body')).includes('Spotify linked'), 'callback page');
    await popup.close();
    await waitState(cfg, 'linked', 8000);
    const txt = await cfg.textContent('body');
    assert(txt.includes('Mock Streamer'), 'display name');
    assert(!/premium|free/i.test(txt), 'no product shown');
  });

  await check('panel: real now-playing (re-auth triggers GET) renders the track', async () => {
    await panel.evaluate(() => window.__mockTwitch.authorize());
    await waitState(panel, 'playing', 8000);
    assert((await panel.textContent('.np-title')) === 'Sunrise Parade', 'title');
    assert((await panel.textContent('.np-subtitle')) === 'The Sample Band', 'artist');
  });

  await check('real EBS v1.2 fields: serverTime on now-playing, requiredConfigSet on status (null/absent → done)', async () => {
    const withItem = npBodies.filter((b) => b.state === 'playing');
    assert(withItem.length && typeof withItem[0].serverTime === 'number', 'serverTime missing in ' + JSON.stringify(withItem[0] || npBodies[0]));
    const st = statusBodies.filter((b) => b.linked)[0];
    assert(st && 'requiredConfigSet' in st, 'requiredConfigSet missing in status ' + JSON.stringify(st));
    assert(await cfg.evaluate(() => document.getElementById('app').dataset.finishing) === (st.requiredConfigSet === false ? 'true' : 'false'), 'finishing flag mismatch');
  });

  await check('real PubSub payloads sent by the EBS parse and render (forwarded into listen)', async () => {
    await fetch(`${MK}/mock/playing`, { method: 'POST', body: JSON.stringify({ status: 204 }) });
    await sleep(2500);
    const log = await (await fetch(`${MK}/mock/pubsub`)).json();
    assert(log.length > 0, 'no pubsub messages');
    const last = log[log.length - 1].body;
    assert(last.target[0] === 'broadcast' && typeof last.message === 'string', 'pubsub body shape');
    assert(typeof JSON.parse(last.message).serverTime === 'number', 'PubSub payload lacks serverTime');
    await panel.evaluate((m) => window.__mockTwitch.broadcast(m), last.message);
    await waitState(panel, 'nothing_playing', 3000);
  });

  await check('config: Disconnect → real unlink', async () => {
    await cfg.getByRole('button', { name: 'Disconnect' }).click();
    await cfg.getByRole('button', { name: 'Yes, disconnect' }).click();
    await waitState(cfg, 'unlinked');
  });

  // ---------- v1.3 channel allowlist against the real EBS ----------
  const tok = async (role, channel) => (await (await fetch(`${FE}/__dev/token?role=${role}&channel=${channel}`)).json()).token;
  const PRIVATE_BODY = JSON.stringify({ version: 1, error: { code: 'channel_not_allowed', message: 'This extension is private.' } });
  await check('real EBS v1.3: blocked channel → 403 with the exact §6 envelope on every endpoint (unlink POST + DELETE); 401 still first; channel before role', async () => {
    const b = await tok('broadcaster', '99999');
    const v = await tok('viewer', '99999');
    const cases = [['GET', '/api/now-playing', v], ['GET', '/api/config/status', b], ['POST', '/api/config/link/start', b],
      ['POST', '/api/config/unlink', b], ['DELETE', '/api/config/link', b], ['GET', '/api/config/status', v]];
    for (const [method, p, t] of cases) {
      const r = await fetch(E + p, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      const body = await r.text();
      assert(r.status === 403 && JSON.stringify(JSON.parse(body)) === PRIVATE_BODY, `${method} ${p}: ${r.status} ${body}`);
    }
    const r401 = await fetch(E + '/api/now-playing');
    assert(r401.status === 401, 'missing JWT should be 401, got ' + r401.status);
  });

  await check('real EBS v1.3: panel + config on a blocked channel render private and stop requesting', async () => {
    const pp = await context.newPage();
    let gets = 0;
    pp.on('request', (r) => { if (r.url().endsWith('/api/now-playing') && r.method() === 'GET') gets += 1; });
    await pp.goto(`${FE}/panel.html?channel=99999&anchor=panel&mode=viewer`);
    await waitState(pp, 'private');
    assert((await pp.textContent('.np-msg-title')) === 'This extension is private', 'panel copy');
    const cp = await context.newPage();
    let st = 0;
    cp.on('request', (r) => { if (r.url().endsWith('/api/config/status') && r.method() === 'GET') st += 1; });
    await cp.goto(`${FE}/config.html?channel=99999&mode=config`);
    await waitState(cp, 'private');
    assert(!(await cp.getByRole('button', { name: 'Connect Spotify' }).isVisible()), 'connect hidden');
    const vp = await context.newPage();
    await vp.goto(`${FE}/config.html?channel=99999&mode=config&role=viewer`);
    await waitState(vp, 'private'); // channel check before role check → not "forbidden"
    await sleep(4000);
    assert(gets === 1 && st === 1, `requests after 403: now-playing ${gets}, status ${st}`);
    await Promise.all([pp.close(), cp.close(), vp.close()]);
  });

  await check('no CSP violations', async () => assert(errors.length === 0, errors.join(' | ')));
} catch (e) {
  console.error('setup failed:', e.message);
  results.push(false);
} finally {
  if (browser) await browser.close();
  procs.forEach((p) => p.kill());
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} integration checks passed`);
process.exit(failed ? 1 : 0);
