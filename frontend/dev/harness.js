// DEV ONLY harness controller.
const $ = (s) => document.querySelector(s);
const frames = () => [...document.querySelectorAll('iframe')];
const log = (m) => { $('#log').textContent = `${new Date().toLocaleTimeString()} ${m}\n` + $('#log').textContent; };
const info = await (await fetch('/__dev/info')).json();
$('#info').textContent = `Views use EBS_BASE_URL=${info.ebsBaseUrl}${info.usingMock ? ' (mock EBS)' : ' (REAL EBS — scenario buttons only affect the mock)'}`;
const MOCK = info.mockEbs;

const post = (p, body) => fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const eachMock = (fn) => frames().forEach((f) => { const m = f.contentWindow && f.contentWindow.__mockTwitch; if (m) fn(m, f); });

// Forward everything the mock EBS "broadcasts" to every view (simulated Extension PubSub).
let since = (await (await fetch(MOCK + '/__mock/broadcasts?since=999999999')).json()).seq;
async function pump() {
  try {
    const r = await (await fetch(`${MOCK}/__mock/broadcasts?since=${since}`)).json();
    for (const b of r.items) {
      since = b.seq;
      eachMock((m) => m.broadcast(b.message));
      log(`PubSub broadcast #${b.seq}: ${b.message.slice(0, 120)}`);
    }
  } catch (e) { /* ignore */ }
  setTimeout(pump, 300);
}
pump();
window.__harness = { post, eachMock, get since() { return since; } };

document.querySelectorAll('[data-scenario]').forEach((b) => b.addEventListener('click', async () => {
  await post('/__mock/scenario', { name: b.dataset.scenario });
  log(`scenario ${b.dataset.scenario}`);
}));
$('#malformed').onclick = () => post('/__mock/raw-broadcast', { message: '{"version":1,"type":"now_playing","state":' });
document.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => eachMock((m) => m.setContext({ theme: b.dataset.theme }))));
let hl = false; $('#highlight').onclick = () => { hl = !hl; eachMock((m) => m.setHighlighted(hl)); };
let pc = false; $('#controls').onclick = () => { pc = !pc; eachMock((m) => m.setContext({ arePlayerControlsVisible: pc })); };
$('#latency').onchange = (e) => eachMock((m) => m.setContext({ hlsLatencyBroadcaster: Number(e.target.value) }));
$('#fail').onclick = () => post('/__mock/settings', { failNowPlaying: 3 }).then(() => log('next 3 GETs fail'));
$('#slow').onclick = () => post('/__mock/settings', { delayMs: 2000 });
$('#fast').onclick = () => post('/__mock/settings', { delayMs: 0 });
$('#revoked').onclick = () => post('/__mock/settings', { linked: false, lastError: 'revoked' }).then(() => log('unlinked (revoked)'));
$('#reqcfg-pending').onclick = () => post('/__mock/settings', { requiredConfigSet: false }).then(() => log('requiredConfigSet=false'));
$('#private').onclick = () => post('/__mock/settings', { channelAllowed: false }).then(() => log('channel not allowed: API → 403 channel_not_allowed (reload views to see it)'));
$('#allowed').onclick = () => post('/__mock/settings', { channelAllowed: true }).then(() => log('channel allowed again'));
$('#reqcfg-done').onclick = () => post('/__mock/settings', { requiredConfigSet: true }).then(() => log('requiredConfigSet=true'));
$('#reload').onclick = () => frames().forEach((f) => f.contentWindow.location.reload());
