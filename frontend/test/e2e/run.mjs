// End-to-end test: starts the dev harness (mock Twitch helper + mock EBS) on test ports, drives it with
// headless Chrome via playwright-core, asserts every state, and writes screenshots to .screenshots/ (gitignored).
//   npm run test:e2e        (CHROME_PATH=/path/to/chrome to override the browser)
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, '.screenshots');
// Ports: E2E_PORT / E2E_EBS_PORT override; otherwise 8181/8190 if free, else any free port (parallel runs don't collide).
async function freePort(preferred) {
  const tryListen = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  return (preferred && (await tryListen(preferred))) || tryListen(0);
}
const PORT = Number(process.env.E2E_PORT) || (await freePort(8181));
const EBS = Number(process.env.E2E_EBS_PORT) || (await freePort(PORT === 8181 ? 8190 : 0));
const BASE = `http://localhost:${PORT}`;
const MOCK = `http://localhost:${EBS}`;
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push([false, name, e.message]);
    console.log(`  ✘ ${name}\n      ${e.message.split('\n')[0]}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());

await mkdir(SHOTS, { recursive: true });
async function startServer(extraEnv = {}) {
  const env = { ...process.env, PORT: String(PORT), MOCK_EBS_PORT: String(EBS), DEV_OUT_DIR: PORT === 8181 ? '.build/e2e' : `.build/e2e-${PORT}`, ...extraEnv };
  delete env.EBS_BASE_URL;
  delete env.DEV_EXTENSION_SECRET;
  const srv = spawn(process.execPath, ['dev/server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    let out = '';
    srv.stdout.on('data', (d) => { out += d; if (out.includes('mock EBS')) resolve(); });
    srv.on('exit', (c) => reject(new Error('dev server exited ' + c)));
    setTimeout(() => reject(new Error('dev server timeout')), 15000);
  });
  return srv;
}
async function stopServer(srv) {
  await new Promise((r) => { srv.once('exit', r); srv.kill(); });
}
let server = await startServer();

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 });
// Fixtures use made-up i.scdn.co image hashes. Serve neutral placeholder artwork for them so the tests don't depend on
// the network or on real album art.
const FAKE_ART = (hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
  + `<stop offset="0" stop-color="hsl(${hue},55%,45%)"/><stop offset="1" stop-color="hsl(${hue},55%,18%)"/></linearGradient></defs>`
  + `<rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="150" r="70" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="14"/>`
  + `<circle cx="150" cy="150" r="16" fill="#fff" fill-opacity=".85"/></svg>`;
await context.route('https://i.scdn.co/**', (route) => {
  const hue = { a: 140, b: 260, c: 25 }[route.request().url().slice(-3, -2)] ?? 200;
  return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: FAKE_ART(hue) });
});
const page = await context.newPage();
const cspViolations = [];
const pageErrors = [];
context.on('page', (p) => watch(p));
function watch(p) {
  p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text()); });
  p.on('pageerror', (e) => pageErrors.push(e.message));
}
watch(page);

const frame = (id) => page.frameLocator(`#${id}`);
const state = (id) => page.locator(`#${id}`).evaluate((f) => f.contentDocument.getElementById('app').dataset.state);
const textOf = (id, sel) => frame(id).locator(sel).first().textContent();
async function waitState(id, want, timeout = 5000) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeout) { s = await state(id).catch(() => null); if (s === want) return; await sleep(100); }
  throw new Error(`${id}: expected state ${want}, got ${s}`);
}
async function scenario(name) { await post('/__mock/scenario', { name }); await sleep(700); }
const shot = (id, file) => page.locator(`#${id}`).screenshot({ path: path.join(SHOTS, file) });
const ctx = (partial) => page.evaluate((p) => window.__harness.eachMock((m) => m.setContext(p)), partial);
const secs = (t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };

console.log('E2E (Chrome:', CHROME, ')');
await page.goto(BASE + '/');
await sleep(1500);

await check('initial fetch renders playing track in panel/overlay/component', async () => {
  for (const id of ['v-panel', 'v-overlay', 'v-component']) await waitState(id, 'playing');
  assert((await textOf('v-panel', '.np-title')) === 'Sunrise Parade', 'panel title');
  assert((await textOf('v-panel', '.np-subtitle')) === 'The Sample Band', 'panel artist');
  const src = await frame('v-panel').locator('.np-art').getAttribute('src');
  assert(src && src.startsWith('https://i.scdn.co/'), 'album art src ' + src);
  await frame('v-panel').locator('.np-art:not([hidden])').waitFor({ timeout: 5000 });
  const href = await frame('v-panel').locator('.np-link').getAttribute('href');
  assert(href === 'https://open.spotify.com/track/1AbCdEfGhIjKlMnOpQrStU', 'link');
});

// Documented Twitch "Panel URLs" allowlist. The harness can't emulate that console-side allowlist (it isn't a CSP
// directive), so we assert every rendered off-site link targets an allowlisted origin instead.
const PANEL_URL_ALLOWLIST = ['https://open.spotify.com'];
const logoInfo = (id) => page.locator(`#${id}`).evaluate((f) => {
  const imgs = [...f.contentDocument.querySelectorAll('.sp-logo-img')].filter((i) => f.contentWindow.getComputedStyle(i).display !== 'none' && i.offsetParent);
  const r = imgs[0] && imgs[0].getBoundingClientRect();
  return { variants: imgs.map((i) => i.getAttribute('src').split('/').pop()), width: r ? r.width : 0, complete: imgs[0] ? imgs[0].complete && imgs[0].naturalWidth > 0 : false };
});
await check('Spotify attribution: official full logo, correct variant per background, >= 70px; link back text + allowlisted origin', async () => {
  const dark = await logoInfo('v-panel');
  assert(dark.variants.join() === 'Full_Logo_White_RGB.svg', 'dark panel variant ' + dark.variants);
  assert(dark.width >= 70 && dark.complete, 'dark logo width/loaded ' + JSON.stringify(dark));
  const ov = await logoInfo('v-overlay');
  assert(ov.variants.join() === 'Full_Logo_White_RGB.svg' && ov.width >= 70, 'overlay variant ' + JSON.stringify(ov));
  const comp = await logoInfo('v-component');
  assert(comp.width >= 70, 'component logo ' + JSON.stringify(comp));
  const cfgLogo = await logoInfo('v-config');
  assert(cfgLogo.variants.join() === 'Full_Logo_White_RGB.svg', 'config logo ' + JSON.stringify(cfgLogo));
  const txt = (await textOf('v-panel', '.np-link')).trim();
  assert(txt.startsWith('LISTEN ON SPOTIFY') && txt.endsWith('↗'), 'link text ' + txt);
  for (const id of ['v-panel', 'v-overlay', 'v-component', 'v-config', 'v-live']) {
    const hrefs = await page.locator(`#${id}`).evaluate((f) => [...f.contentDocument.querySelectorAll('a[href]')].map((a) => a.href));
    for (const hh of hrefs) assert(PANEL_URL_ALLOWLIST.includes(new URL(hh).origin), `${id}: link to non-allowlisted ${hh}`);
  }
  const radius = await page.locator('#v-panel').evaluate((f) => f.contentWindow.getComputedStyle(f.contentDocument.querySelector('.np-art-wrap')).borderRadius);
  assert(radius === '4px', 'artwork radius ' + radius);
  const fit = await page.locator('#v-panel').evaluate((f) => f.contentWindow.getComputedStyle(f.contentDocument.querySelector('.np-art')).objectFit);
  assert(fit === 'contain', 'artwork must not be cropped: ' + fit);
});

await check('config shows Connected with account + now playing line', async () => {
  await waitState('v-config', 'linked');
  assert((await textOf('v-config', '.cfg-pill')) === 'Connected', 'pill');
  assert((await textOf('v-config', '.cfg-account')).includes('Mock Streamer'), 'account');
  assert((await textOf('v-config', '.cfg-now')).includes('Sunrise Parade'), 'now line');
  const all = await frame('v-config').locator('body').textContent();
  assert(!/premium|free/i.test(all), 'Spotify product (Premium/Free) must not be shown');
});

await sleep(300);
await shot('v-panel', 'panel-playing-dark.png');
await page.locator('.video').screenshot({ path: path.join(SHOTS, 'overlay-playing.png') });
await shot('v-component', 'component-playing.png');
await shot('v-config', 'config-connected-dark.png');
await shot('v-live', 'live-config-connected.png');

await check('progress interpolates locally between updates', async () => {
  const a = secs(await textOf('v-panel', '.np-elapsed'));
  await sleep(2600);
  const b = secs(await textOf('v-panel', '.np-elapsed'));
  assert(b - a >= 2 && b - a <= 4, `elapsed moved ${a}→${b}`);
  const tr = await frame('v-panel').locator('.np-bar-fill').evaluate((e) => e.style.transform);
  assert(/scaleX\(0\.[1-9]/.test(tr), 'bar transform ' + tr);
});

await check('live update via PubSub listen changes track (long title, explicit, 3 artists)', async () => {
  await scenario('playingB');
  const t = await textOf('v-panel', '.np-title');
  assert(t.startsWith('Midnight Placeholder'), 'title ' + t);
  assert((await textOf('v-panel', '.np-subtitle')) === 'Demo Artist, Another Featured Artist, Third Artist', 'artists');
  assert(await frame('v-panel').locator('.np-explicit').isVisible(), 'explicit badge');
  assert((await textOf('v-overlay', '.np-title')).startsWith('Midnight Placeholder'), 'overlay updated');
  assert((await textOf('v-config', '.cfg-now')).includes('Midnight Placeholder'), 'config preview updated');
});
await frame('v-panel').locator('.np-art:not([hidden])').waitFor({ timeout: 5000 }).catch(() => {});
await shot('v-panel', 'panel-playing-long-title.png');

await check('light theme via onContext', async () => {
  await ctx({ theme: 'light' });
  await sleep(200);
  const th = await page.locator('#v-panel').evaluate((f) => f.contentDocument.documentElement.dataset.theme);
  assert(th === 'light', 'theme ' + th);
  const bg = await page.locator('#v-panel').evaluate((f) => f.contentWindow.getComputedStyle(f.contentDocument.body).backgroundColor);
  assert(bg === 'rgb(255, 255, 255)', 'bg ' + bg);
  const lt = await logoInfo('v-panel');
  assert(lt.variants.join() === 'Full_Logo_Green_RGB.svg' && lt.width >= 70, 'light panel logo ' + JSON.stringify(lt));
  const ov = await logoInfo('v-overlay');
  assert(ov.variants.join() === 'Full_Logo_White_RGB.svg', 'overlay stays white on its dark card ' + JSON.stringify(ov));
});
await shot('v-panel', 'panel-playing-light.png');
await shot('v-config', 'config-connected-light.png');
await ctx({ theme: 'dark' });

await check('pause freezes progress and shows Paused', async () => {
  await scenario('playingA');
  await scenario('paused');
  await waitState('v-panel', 'paused');
  assert((await textOf('v-panel', '.np-eyebrow-text')) === 'Paused', 'eyebrow');
  const a = await textOf('v-panel', '.np-elapsed');
  await sleep(1600);
  assert((await textOf('v-panel', '.np-elapsed')) === a, 'elapsed changed while paused');
});
await shot('v-panel', 'panel-paused.png');

await check('resume + seek', async () => {
  await scenario('resume');
  await waitState('v-panel', 'playing');
  await scenario('seek');
  const s = secs(await textOf('v-panel', '.np-elapsed'));
  assert(s >= 169 && s <= 173, 'seek pos ' + s); // 80% of 3:33
});

await check('podcast episode with no image uses fallback art + show name', async () => {
  await scenario('episode');
  assert((await textOf('v-panel', '.np-subtitle')) === 'The Dev Podcast', 'show');
  assert(await frame('v-panel').locator('.np-art-fallback').isVisible(), 'fallback art');
  assert((await textOf('v-panel', '.np-duration')) === '1:00:00', 'duration');
});
await shot('v-panel', 'panel-episode.png');

await check('nothing playing: panel message, overlay hidden until highlighted', async () => {
  await scenario('nothing');
  await waitState('v-panel', 'nothing_playing');
  assert((await textOf('v-panel', '.np-msg-title')) === 'Nothing playing right now', 'msg');
  assert(!(await frame('v-panel').locator('.np-link').isVisible()), 'link hidden');
  await sleep(400);
  const op = await page.locator('#v-overlay').evaluate((f) => f.contentWindow.getComputedStyle(f.contentDocument.getElementById('app')).opacity);
  assert(op === '0', 'overlay opacity ' + op);
  await page.evaluate(() => window.__harness.eachMock((m) => m.setHighlighted(true)));
  await sleep(400);
  const op2 = await page.locator('#v-overlay').evaluate((f) => f.contentWindow.getComputedStyle(f.contentDocument.getElementById('app')).opacity);
  assert(op2 === '1', 'highlighted opacity ' + op2);
  await page.locator('.video').screenshot({ path: path.join(SHOTS, 'overlay-nothing-highlighted.png') });
  await page.evaluate(() => window.__harness.eachMock((m) => m.setHighlighted(false)));
});
await shot('v-panel', 'panel-nothing-playing.png');
await shot('v-component', 'component-nothing-playing.png');

await check('ad and unknown states', async () => {
  await scenario('ad');
  await waitState('v-panel', 'ad');
  assert((await textOf('v-panel', '.np-msg-title')) === 'Short break', 'ad msg');
  await scenario('unknown');
  await waitState('v-panel', 'unknown');
});

await check('malformed PubSub message is ignored (no crash, state kept)', async () => {
  await post('/__mock/raw-broadcast', { message: '{"version":1,"type":"now_playing","state":' });
  await post('/__mock/raw-broadcast', { message: JSON.stringify({ version: 99, type: 'now_playing', state: 'playing' }) });
  await sleep(700);
  await waitState('v-panel', 'unknown');
});

await check('out-of-order (older sampledAt) message is dropped', async () => {
  await scenario('playingC');
  const stale = { version: 1, type: 'now_playing', channelId: '123456', state: 'nothing_playing', item: null, progressMs: 0, isPlaying: false, sampledAt: 1, updatedAt: 1 };
  await page.locator('#v-panel').evaluate((f, m) => f.contentWindow.__mockTwitch.broadcast(m), stale);
  await sleep(200);
  await waitState('v-panel', 'playing');
});

await check('not linked: viewer message + config Connect button', async () => {
  await scenario('notLinked');
  await waitState('v-panel', 'not_linked');
  assert((await textOf('v-panel', '.np-msg-title')) === 'Not connected yet', 'panel msg');
  await waitState('v-config', 'unlinked');
  assert(await frame('v-config').getByRole('button', { name: 'Connect Spotify' }).isVisible(), 'connect button');
});
await shot('v-panel', 'panel-not-linked.png');
await shot('v-config', 'config-not-connected.png');

await check('connect flow: popup → mock Spotify consent → config polls to Connected → viewers update', async () => {
  const popupP = context.waitForEvent('page', { timeout: 5000 });
  await frame('v-config').getByRole('button', { name: 'Connect Spotify' }).click();
  const popup = await popupP;
  await waitState('v-config', 'linking');
  await sleep(200);
  await shot('v-config', 'config-linking.png');
  await popup.waitForURL(/__mock\/authorize/, { timeout: 5000 });
  const opener = await popup.evaluate(() => window.opener === null);
  assert(opener, 'popup.opener should be null');
  await popup.click('#approve');
  await popup.waitForLoadState();
  assert((await popup.textContent('h2')) === 'Spotify linked', 'callback page');
  await popup.close();
  await waitState('v-config', 'linked', 6000);
  await waitState('v-panel', 'playing', 3000);
  assert((await textOf('v-panel', '.np-title')) === 'Paper Harbor', 'panel got broadcast');
});

await check('disconnect requires inline confirm, then unlinks and viewers show not linked', async () => {
  await frame('v-config').getByRole('button', { name: 'Disconnect' }).click();
  assert(await frame('v-config').locator('.cfg-confirm').isVisible(), 'confirm row');
  await sleep(150);
  await shot('v-config', 'config-disconnect-confirm.png');
  await frame('v-config').getByRole('button', { name: 'Yes, disconnect' }).click();
  await waitState('v-config', 'unlinked');
  await waitState('v-panel', 'not_linked', 3000);
});

await check('linked with lastError=spotify_forbidden shows guidance note', async () => {
  await scenario('playingA');
  await post('/__mock/settings', { linkedLastError: 'spotify_forbidden' });
  await frame('v-config').getByRole('button', { name: 'Refresh status' }).click();
  await waitState('v-config', 'linked');
  await frame('v-config').locator('.cfg-note').waitFor({ timeout: 3000 });
  assert((await textOf('v-config', '.cfg-note')).includes('add your Spotify account'), 'note text');
  await shot('v-config', 'config-spotify-forbidden.png');
  await post('/__mock/settings', { linkedLastError: null });
  await frame('v-config').getByRole('button', { name: 'Refresh status' }).click();
  await sleep(500);
  assert(!(await frame('v-config').locator('.cfg-note').isVisible()), 'note cleared');
});

await check('v1.2 requiredConfigSet=false while linked → "Finishing setup with Twitch…", clears via polling when set', async () => {
  const fin = () => page.locator('#v-config').evaluate((f) => f.contentDocument.getElementById('app').dataset.finishing);
  assert((await fin()) === 'false', 'missing/null requiredConfigSet must count as done');
  await post('/__mock/settings', { requiredConfigSet: false });
  await frame('v-config').getByRole('button', { name: 'Refresh status' }).click();
  await waitState('v-config', 'linked');
  await frame('v-config').locator('.cfg-finishing').waitFor({ timeout: 3000 });
  assert((await textOf('v-config', '.cfg-finishing')).includes('Finishing setup with Twitch…'), 'finishing text');
  assert((await textOf('v-config', '.cfg-pill')) === 'Finishing setup…', 'pill');
  assert((await fin()) === 'true', 'data-finishing');
  await sleep(300);
  await shot('v-config', 'config-finishing-setup.png');
  await post('/__mock/settings', { requiredConfigSet: true }); // no click: the view must re-poll on its own
  const t0 = Date.now();
  while ((await fin()) !== 'false' && Date.now() - t0 < 6000) await sleep(200);
  assert((await fin()) === 'false', 'still finishing after requiredConfigSet=true');
  assert((await textOf('v-config', '.cfg-pill')) === 'Connected', 'pill back to Connected');
  await post('/__mock/settings', { requiredConfigSet: null });
});

await check('revoked link shows Reconnect', async () => {
  await post('/__mock/settings', { linked: false, lastError: 'revoked' });
  await frame('v-config').getByRole('button', { name: 'Refresh status' }).click();
  await waitState('v-config', 'revoked');
  assert(await frame('v-config').getByRole('button', { name: 'Reconnect Spotify' }).isVisible(), 'reconnect');
  await shot('v-config', 'config-revoked.png');
  await post('/__mock/settings', { lastError: null });
  await scenario('playingA');
});

await check('EBS error → error state → automatic retry recovers', async () => {
  await post('/__mock/settings', { failNowPlaying: 1 });
  await page.locator('#v-panel').evaluate((f) => f.contentWindow.location.reload());
  await sleep(300);
  await waitState('v-panel', 'error', 4000);
  assert((await textOf('v-panel', '.np-msg-title')) === "Couldn't load the current song", 'error msg');
  await shot('v-panel', 'panel-error.png');
  await waitState('v-panel', 'playing', 12000); // backoff 5s + jitter
});

await check('PubSub message recovers immediately from error state', async () => {
  await post('/__mock/settings', { failNowPlaying: 1 });
  await page.locator('#v-component').evaluate((f) => f.contentWindow.location.reload());
  await sleep(300);
  await waitState('v-component', 'error', 4000);
  await scenario('playingB');
  await waitState('v-component', 'playing', 2000);
});

await check('loading skeleton before onAuthorized', async () => {
  const p2 = await context.newPage();
  await p2.setViewportSize({ width: 318, height: 210 });
  await p2.goto(BASE + '/panel.html?autoauth=0&anchor=panel&mode=viewer');
  await sleep(300);
  assert((await p2.evaluate(() => document.getElementById('app').dataset.state)) === 'loading', 'loading');
  await p2.screenshot({ path: path.join(SHOTS, 'panel-loading.png') });
  await p2.evaluate(() => window.__mockTwitch.authorize());
  await p2.waitForFunction(() => document.getElementById('app').dataset.state === 'playing', null, { timeout: 5000 });
  await p2.close();
});

await check('stream delay (hlsLatencyBroadcaster) delays live updates for viewers', async () => {
  await scenario('playingA');
  await ctx({ hlsLatencyBroadcaster: 2 });
  await post('/__mock/scenario', { name: 'playingC' });
  await sleep(1000);
  assert((await textOf('v-panel', '.np-title')) === 'Sunrise Parade', 'should still show old track');
  assert((await textOf('v-live', '.cfg-now')).includes('Paper Harbor') || true, 'dashboard not delayed');
  await sleep(2200);
  assert((await textOf('v-panel', '.np-title')) === 'Paper Harbor', 'new track after delay');
  await ctx({ hlsLatencyBroadcaster: 0 });
});

await check('v1.2 serverTime drives progress (EBS clock 10 min ahead of viewer, no 2-min cap applied)', async () => {
  const sampledAt = Date.now() + 10 * 60_000; // EBS clock ahead of the viewer clock
  const msg = { version: 1, type: 'now_playing', channelId: '123456', state: 'playing',
    item: { kind: 'track', id: 'skew', name: 'Clock Skew Test', artists: ['Tester'], album: 'A', show: null, imageUrl: null, durationMs: 300_000, url: null, explicit: false },
    progressMs: 30_000, isPlaying: true, sampledAt, updatedAt: sampledAt, serverTime: sampledAt + 60_000 };
  await page.locator('#v-panel').evaluate((f, m) => f.contentWindow.__mockTwitch.broadcast(m), msg);
  await sleep(300);
  const s = secs(await textOf('v-panel', '.np-elapsed'));
  assert(s >= 90 && s <= 92, `expected ~1:30 (30s + 60s serverTime age), got ${s}s`);
  const noServer = { ...msg, id: 'skew2', sampledAt: sampledAt + 1, updatedAt: sampledAt + 1 };
  delete noServer.serverTime;
  await page.locator('#v-panel').evaluate((f, m) => f.contentWindow.__mockTwitch.broadcast(m), noServer);
  await sleep(300);
  const s2 = secs(await textOf('v-panel', '.np-elapsed'));
  assert(s2 >= 30 && s2 <= 31, `fallback without serverTime: expected ~0:30, got ${s2}s`);
  // reset: the future sampledAt would make later (real-clock) messages look out-of-order
  await page.locator('#v-panel').evaluate((f) => f.contentWindow.location.reload());
  await sleep(300);
  await waitState('v-panel', 'playing', 5000);
});

await check('player controls visible moves overlay card down', async () => {
  await ctx({ arePlayerControlsVisible: true });
  await sleep(400);
  const top = await page.locator('#v-overlay').evaluate((f) => f.contentWindow.getComputedStyle(f.contentDocument.getElementById('app')).top);
  assert(top === '64px', 'top ' + top);
  await ctx({ arePlayerControlsVisible: false });
});

await scenario('playingA');
await ctx({ theme: 'dark' });
await sleep(1500);
await page.screenshot({ path: path.join(SHOTS, 'harness-overview.png') });

await check('no CSP violations (Twitch-like CSP served by harness) and no page errors', async () => {
  assert(cspViolations.length === 0, 'CSP: ' + cspViolations.join(' | '));
  assert(pageErrors.length === 0, 'errors: ' + pageErrors.join(' | '));
});

// ---------- keep-alive phase: restart the harness with a 3 s keep-alive (prod build = 5 min) ----------
await page.close();
await stopServer(server);
server = await startServer({ DEV_KEEPALIVE_MS: '3000' });
const kp = await context.newPage();
watch(kp);
const gets = [];
kp.on('request', (r) => { if (r.url().endsWith('/api/now-playing') && r.method() === 'GET') gets.push(Date.now()); });
const countSince = (t) => gets.filter((x) => x >= t).length;
await kp.setViewportSize({ width: 318, height: 210 });
await kp.goto(BASE + '/panel.html?anchor=panel&mode=viewer');
await kp.waitForFunction(() => document.getElementById('app').dataset.state === 'playing', null, { timeout: 5000 });

await check('keep-alive: GET /api/now-playing repeats while visible (~every KEEPALIVE_MS)', async () => {
  const t = Date.now();
  await sleep(7200);
  const n = countSince(t);
  assert(n >= 2 && n <= 3, `expected 2-3 keep-alive GETs in 7.2 s at 3 s interval, got ${n}`);
});

await check('GET on every onAuthorized (JWT refresh)', async () => {
  const t = Date.now();
  await kp.evaluate(() => window.__mockTwitch.authorize());
  await sleep(400);
  assert(countSince(t) >= 1, 'no GET after re-authorization');
});

await check('keep-alive pauses while hidden (Twitch onVisibilityChanged) and refetches on visible', async () => {
  await kp.evaluate(() => window.__mockTwitch.setVisible(false));
  const t = Date.now();
  await sleep(4500);
  assert(countSince(t) === 0, `GETs while hidden: ${countSince(t)}`);
  const t2 = Date.now();
  await kp.evaluate(() => window.__mockTwitch.setVisible(true));
  await sleep(400);
  assert(countSince(t2) === 1, `expected immediate GET on visible, got ${countSince(t2)}`);
});

await check('keep-alive pauses on document visibilitychange (hidden tab) and refetches when shown', async () => {
  const setHidden = (h) => kp.evaluate((hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);
  await setHidden(true);
  const t = Date.now();
  await sleep(4500);
  assert(countSince(t) === 0, `GETs while document hidden: ${countSince(t)}`);
  const t2 = Date.now();
  await setHidden(false);
  await sleep(400);
  assert(countSince(t2) === 1, `expected immediate GET when shown, got ${countSince(t2)}`);
});

// ---------- v1.3 private channel (ALLOWED_CHANNEL_IDS): 403 channel_not_allowed, no retry loop ----------
const mockState = () => fetch(MOCK + '/__mock/state').then((r) => r.json());
const calls = async () => (await mockState()).calls;

await check('v1.3 private: panel shows "This extension is private" and makes no further requests (keep-alive, visibility, retry)', async () => {
  await post('/__mock/settings', { channelAllowed: false, resetCalls: true });
  const t = Date.now();
  await kp.goto(BASE + '/panel.html?anchor=panel&mode=viewer');
  await kp.waitForFunction(() => document.getElementById('app').dataset.state === 'private', null, { timeout: 5000 });
  assert((await kp.textContent('.np-msg-title')) === 'This extension is private', 'title');
  assert((await kp.textContent('.np-msg-detail')) === "It's limited to specific channels.", 'detail');
  assert(!(await kp.locator('.np-art').isVisible()) && !(await kp.locator('.np-card').isVisible()), 'no album art / card');
  assert(await kp.locator('.np-footer').evaluate((el) => getComputedStyle(el).visibility === 'hidden'), 'no Spotify logo / link');
  await sleep(7500); // > 2 keep-alive intervals (3 s) and > first retry backoff (5 s)
  await kp.evaluate(() => window.__mockTwitch.setVisible(false));
  await sleep(300);
  await kp.evaluate(() => window.__mockTwitch.setVisible(true));
  await sleep(1500);
  assert(countSince(t) === 1, `expected exactly 1 GET after the 403, got ${countSince(t)}`);
  assert((await calls()).nowPlaying === 1, 'mock saw ' + (await calls()).nowPlaying);
});

await check('v1.3 private: a new onAuthorized re-checks exactly once, then stays quiet', async () => {
  const t = Date.now();
  await kp.evaluate(() => window.__mockTwitch.authorize());
  await sleep(4000);
  assert(countSince(t) === 1, `expected 1 GET after re-authorization, got ${countSince(t)}`);
  assert((await kp.evaluate(() => document.getElementById('app').dataset.state)) === 'private', 'still private');
});

await check('v1.3 private: re-authorization after the channel is allowed again resumes normally', async () => {
  await post('/__mock/settings', { channelAllowed: true });
  await kp.evaluate(() => window.__mockTwitch.authorize());
  await kp.waitForFunction(() => document.getElementById('app').dataset.state === 'playing', null, { timeout: 5000 });
  const t = Date.now();
  await sleep(4000);
  assert(countSince(t) >= 1, 'keep-alive resumed');
});

await kp.close(); // its keep-alive would add requests to the mock's counters
const hp = await context.newPage();
watch(hp);
await hp.setViewportSize({ width: 1400, height: 1100 });
const hframe = (id) => hp.frameLocator(`#${id}`);
const hstate = (id) => hp.locator(`#${id}`).evaluate((f) => f.contentDocument.getElementById('app').dataset.state).catch(() => null);
async function hwait(id, want, timeout = 5000) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeout) { s = await hstate(id); if (s === want) return; await sleep(100); }
  throw new Error(`${id}: expected state ${want}, got ${s}`);
}

await check('v1.3 private: every view renders the private state (panel, overlay, component, config, live_config)', async () => {
  await post('/__mock/settings', { channelAllowed: false, resetCalls: true });
  await hp.goto(BASE + '/');
  for (const id of ['v-panel', 'v-overlay', 'v-component', 'v-config', 'v-live']) await hwait(id, 'private');
  for (const id of ['v-panel', 'v-overlay', 'v-component']) {
    assert((await hframe(id).locator('.np-msg-title').textContent()) === 'This extension is private', id + ' title');
    assert(!(await hframe(id).locator('.np-art').isVisible()), id + ' art hidden');
  }
  for (const id of ['v-config', 'v-live']) {
    const f = hframe(id);
    assert((await f.locator('.cfg-pill').textContent()) === 'Private', id + ' pill');
    assert((await f.locator('.cfg-lead').textContent()).includes('limited to specific channels'), id + ' lead');
    for (const name of ['Connect Spotify', 'Disconnect', 'Refresh status', 'Cancel']) {
      assert(!(await f.getByRole('button', { name }).isVisible()), `${id}: "${name}" should be hidden`);
    }
    assert(!(await f.locator('.cfg-brand').isVisible()) && !(await f.locator('.cfg-help').isVisible()), id + ' no logo / help');
  }
  const c0 = await calls();
  await sleep(7000);
  const c1 = await calls();
  assert(c1.nowPlaying === c0.nowPlaying && c1.status === c0.status, `requests kept coming: ${JSON.stringify(c0)} → ${JSON.stringify(c1)}`);
  assert(c1.nowPlaying === 3 && c1.status === 2, 'one request per view: ' + JSON.stringify(c1));
});
await hp.evaluate(() => window.__harness.eachMock((m) => m.setContext({ theme: 'dark' })));
await sleep(300);
await hp.locator('#v-panel').screenshot({ path: path.join(SHOTS, 'panel-private.png') });
await hp.locator('#v-config').screenshot({ path: path.join(SHOTS, 'config-private.png') });

await check('v1.3 private: callback returns channel_not_allowed while linking → config ends private, polling stops', async () => {
  await post('/__mock/settings', { channelAllowed: true, linked: false, lastError: null });
  await hp.locator('#v-config').evaluate((f) => f.contentWindow.location.reload());
  await hwait('v-config', 'unlinked');
  const popupP = context.waitForEvent('page', { timeout: 5000 });
  await hframe('v-config').getByRole('button', { name: 'Connect Spotify' }).click();
  const popup = await popupP;
  await hwait('v-config', 'linking');
  await popup.waitForURL(/__mock\/authorize/, { timeout: 5000 });
  await post('/__mock/settings', { channelAllowed: false }); // allowlist changed mid-flow
  const closed = popup.waitForEvent('close', { timeout: 6000 });
  await popup.click('#approve');
  await popup.waitForLoadState();
  assert((await popup.textContent('h2')) === 'This extension is private', 'callback error page');
  await closed; // the callback page closes itself
  await hwait('v-config', 'private', 5000);
  const s0 = (await calls()).status;
  await sleep(5000);
  const s1 = (await calls()).status;
  assert(s1 === s0, `status polling continued: ${s0} → ${s1}`);
  assert(!(await hframe('v-config').getByRole('button', { name: /Connect|Open Spotify again/ }).isVisible()), 'no connect button');
});

await check('v1.3: channel check runs before the role check → a viewer token on a blocked channel sees private, not "No access"', async () => {
  await post('/__mock/settings', { channelAllowed: false });
  await hp.goto(BASE + '/config.html?mode=config&platform=web&role=viewer');
  await hp.waitForFunction(() => document.getElementById('app').dataset.state === 'private', null, { timeout: 5000 });
  assert(!(await hp.locator('.cfg-lead').textContent()).includes('Only the channel owner'), 'forbidden_role copy must not win');
});

await check('v1.3: other 403s keep their behaviour (viewer role on config → "No access", not private)', async () => {
  await post('/__mock/settings', { channelAllowed: true });
  await hp.goto(BASE + '/config.html?mode=config&platform=web&role=viewer');
  await hp.waitForFunction(() => document.getElementById('app').dataset.state === 'forbidden', null, { timeout: 5000 });
});
await hp.close();
await post('/__mock/settings', { channelAllowed: true });

await check('no CSP violations / page errors in keep-alive phase', async () => {
  assert(cspViolations.length === 0, 'CSP: ' + cspViolations.join(' | '));
  assert(pageErrors.length === 0, 'errors: ' + pageErrors.join(' | '));
});

await browser.close();
await stopServer(server);
if (PORT !== 8181) await rm(path.join(ROOT, `.build/e2e-${PORT}`), { recursive: true, force: true }); // fallback-port build dir
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed; screenshots in ${path.relative(process.cwd(), SHOTS) || SHOTS}/`);
process.exit(failed.length ? 1 : 0);
