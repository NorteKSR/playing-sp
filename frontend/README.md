# Now Playing (Spotify) — Twitch Extension frontend

Viewer views show the streamer's current Spotify track (album art, title, artists, progress bar that
interpolates locally). The broadcaster config view links/unlinks Spotify through the EBS.
Implements `../API_CONTRACT.md` **v1.2** (payload `version: 1`). Twitch rule notes with sources: `TWITCH_COMPLIANCE.md`.

Plain HTML/CSS/JS. esbuild bundles each view into one readable (unminified) IIFE. No runtime dependencies.

## Layout
```
src/                       ← everything that ships
  panel.html  video_overlay.html  video_component.html  config.html  live_config.html
  css/common.css  css/viewer.css  css/config.css
  js/config.js         build-time config (EBS_BASE_URL, image/link host allowlists, stream-delay sync)
  js/api.js            EBS adapter: every endpoint path lives here
  js/model.js          THE parser/normaliser for HTTP + PubSub payloads (contract changes go here)
  js/progress.js       progress interpolation + time formatting (pure)
  js/viewer.js         panel / overlay / component controller
  js/config-view.js    config + live_config controller (link, poll, unlink)
  js/brand.js          Spotify attribution: official logo (per-theme variant) + "LISTEN ON SPOTIFY ↗" link
  img/spotify/         official, unmodified Spotify full-logo SVGs (green + white)
  js/bits.js           Bits extension point (no-op; read the policy warning)
  js/twitch.js theme.js dom.js, *.entry.js (one per view)
dev/                       ← NEVER shipped: harness, mock Twitch helper, mock EBS
scripts/build.mjs          build → dist/ (dev servers build into their own .build/<name>/)
scripts/package.mjs        build + validate + zip → release/
test/unit/                 node:test unit tests (model, progress, api)
test/e2e/run.mjs           headless Chrome end-to-end test + screenshots
.screenshots/              output of the e2e run (gitignored)
```

## Run / preview locally (no Twitch or Spotify keys needed)
```bash
cd frontend
npm install
npm run dev          # harness → http://localhost:8081/   mock EBS → http://localhost:8090
```
The harness loads all five views in iframes. The dev server swaps the helper `<script>` for
`dev/mock-twitch-ext.js` (fake `onAuthorized` with a signed dev JWT, `onContext`, `listen`, …) and serves the
views with a **Twitch-like CSP**, so CSP mistakes show up locally. Harness buttons:
- **EBS → PubSub broadcast**: play track A/B/C, near end, podcast, pause, resume, seek, nothing playing, ad,
  unknown, not linked, malformed message. The mock EBS changes its state and "broadcasts"; the harness forwards the
  message to every view's `listen('broadcast')` callback.
- **Twitch context**: dark/light theme, overlay highlight, player controls, stream delay (`hlsLatencyBroadcaster`).
- **Mock EBS**: fail the next GETs (error state + retry), slow EBS, "revoked" unlink, reload views.
- Config view: **Connect Spotify** opens a popup to a mock consent page (Agree/Cancel) → the config view polls to "Connected".
  "Required config pending/set" toggles the v1.2 `requiredConfigSet` flag ("Finishing setup with Twitch…").

Each dev server builds into its own folder (`DEV_OUT_DIR`; default `.build/dev`, e2e `.build/e2e`, integration
`.build/integration`) and uses its own ports (dev 8081/8090, e2e 8181/8190, integration 8281/8291 + EBS 8787 + upstream
mocks 9090), so `npm run dev`, `test:e2e` and `test:integration` can run at the same time.

A single view can also be opened directly, e.g. `http://localhost:8081/panel.html?theme=light&latency=3`
(`autoauth=0` keeps it in the loading state; see the header of `dev/mock-twitch-ext.js` for all params).

**Against the real EBS (`../backend`)** (still with the mock helper):
```bash
EBS_BASE_URL=http://localhost:8080 DEV_EXTENSION_SECRET=<same base64 secret as the EBS> npm run dev
```
The dev JWTs are then signed with that secret (channel `123456`; change it with `?channel=`). You can also run the
backend against its bundled mocks (see `backend/README.md`; it mints test JWTs with `npm run -s mint-jwt -- viewer 12345`). The EBS must allow
origin `http://localhost:8081` in CORS. Scenario buttons only drive the mock EBS; real PubSub goes through Twitch.

## Tests
```bash
npm test             # unit tests (29): parsing/normalisation, progress math (incl. v1.2 serverTime), API adapter, Spotify logo integrity
npm run test:e2e     # headless Chrome (playwright-core + system Chrome; CHROME_PATH to override): 31 checks, writes .screenshots/ (gitignored)
npm run test:integration  # REAL ../backend (unmodified; EBS on 8787) on its bundled mock upstreams + this harness: 8 checks
```

## Configuration
| Value | Where | Notes |
|---|---|---|
| `EBS_BASE_URL` | env var at build/package time (esbuild `define`) | Must be `https://` for production. Also add it to **Allowlist for URL Fetching Domains**. |
| Image hosts | `src/js/config.js` `ALLOWED_IMAGE_HOSTS` | `i.scdn.co` only. Keep in sync with **Allowlist for Image Domains**; other hosts fall back to placeholder art. |
| Keep-alive | `src/js/config.js` `KEEPALIVE_MS` | 5 min (+ up to 20 s jitter). Viewer views `GET /api/now-playing` on load, on every `onAuthorized`, and every ~5 min while visible. The timer pauses while hidden (Twitch `onVisibilityChanged` **or** `document.hidden`) and fetches right away when the view is visible again. Contract v1.1: the EBS only polls Spotify for channels viewed in the last 10 min. |
| Link hosts | `src/js/config.js` `ALLOWED_LINK_HOSTS` | `open.spotify.com` |
| Stream-delay sync | `src/js/config.js` `SYNC_TO_STREAM_DELAY` | Viewer views apply live updates `hlsLatencyBroadcaster` seconds late (max 30 s) so the card matches what the viewer hears. |

## Package for Twitch
```bash
EBS_BASE_URL=https://<your-app>.fly.dev npm run package
# → release/now-playing-frontend-<version>.zip (~47 KB, 15 files, HTML at zip root)
```
Production EBS (e.g. Fly.io, see `../DEPLOY.md`): `https://<your-app>.fly.dev`. Put that origin in
**Allowlist for URL Fetching Domains**; the Spotify app's redirect URI is `https://<your-app>.fly.dev/auth/spotify/callback`.
Production CORS allows only `https://YOUR_TWITCH_EXTENSION_CLIENT_ID.ext-twitch.tv` (Hosted Test / release), not the
Local Test origin, so Local Test needs a local EBS (see below).
The package script refuses to write the zip if any check fails: helper not the first script, inline/remote scripts,
inline handlers, `eval`/`new Function`, source maps, mock/dev/localhost references, absolute paths, file names
with spaces, disallowed file types, a missing view, or a Spotify logo that is not byte-identical to the official asset. It also prints per-view initial-load sizes against the 1 MB
mobile budget.

## Upload + Hosted Test (Twitch developer console → your extension → version)
1. **Asset Hosting**
   - Type of Extension: Panel, Video - Fullscreen (overlay), Video - Component (tick the ones you want).
   - Panel Viewer Path: `panel.html`, Panel Height: **210** (range 100–500; leaves room for the Spotify logo + its clear space)
   - Video - Fullscreen Viewer Path: `video_overlay.html`
   - Video - Component Viewer Path: `video_component.html` (pick an aspect ratio/size in the console)
   - Config Path: `config.html`
   - Live Config Path: `live_config.html`
   - Testing Base URI (Local Test only): e.g. `https://localhost:8080/`, serving a build of this folder. The backend's
     CORS allows the Local Test origin by default via `TWITCH_LOCAL_TEST_ORIGINS` (default `https://localhost:8080`;
     change it if you use another port). **Both the EBS and the Local Test server default to port 8080**: on one
     machine, run the EBS with `PORT=8787` and build with `EBS_BASE_URL` pointing there, e.g.
     `node scripts/build.mjs --dev --out dist --ebs http://localhost:8787` (a `--dev` build is for Local Test only and
     is never uploaded; `npm run package` always rebuilds a production build that requires an `https://` EBS URL).
2. **Capabilities** (allowlists per API_CONTRACT v1.1)
   - Allowlist for URL Fetching Domains: `https://<your EBS host>` (the `EBS_BASE_URL` origin)
   - Allowlist for Config URLs: `https://accounts.spotify.com` (the Spotify authorize popup opened by the config view) and
     `https://open.spotify.com` (the config/live-config "now playing" preview links back to Spotify, as Spotify's guidelines require)
   - Allowlist for Image Domains: `https://i.scdn.co` (album art)
   - Allowlist for Media Domains: none
   - Allowlist for Panel URLs: `https://open.spotify.com` (the "LISTEN ON SPOTIFY ↗" link back to the track, kept per project-lead decision)
   - Identity link: not required. Chat capabilities: off. Bits: off (v1).
   - Extension Configuration Service: **None** (default). If the owner turns on required configuration, choose
     **"Custom/My Own Service"** and set the Required Configurations string to **`spotify-linked-v1`**. It must equal
     the backend's `TWITCH_REQUIRED_CONFIGURATION` for the version in `TWITCH_EXTENSION_VERSION`. The EBS sets the
     string after a successful link. Until then, `GET /api/config/status` returns `requiredConfigSet: false` and
     the config view shows **"Finishing setup with Twitch…"** and re-polls. A missing or `null` `requiredConfigSet`
     means the feature is off and counts as done.
3. **Files** → Upload Version Assets → the zip from `release/` (the version must be in Local Test to upload).
4. Move to **Hosted Test**. Install it on your channel (Extensions manager → My Extensions), open **Configure** →
   Connect Spotify (a popup opens; allow popups for twitch.tv), then activate it as a panel/overlay/component and play something on Spotify.
5. Before review: add an icon and 1024×768 (4:3) screenshots (`.screenshots/` from the e2e run and `../docs/images/` have raw material), and give the EBS the extension secret and client ID.

## Spotify OAuth popup
The config view opens the popup synchronously on click (so popup blockers allow it) and then clears
`popup.opener` (the noopener equivalent; kept for security). The EBS callback page closes itself (1.5 s on success,
10 s on failure). Because the opener is cleared, the frontend deliberately ignores the callback's optional
`postMessage` hint. **Status polling is the source of truth:** `GET /api/config/status` every 2 s for up to 2 min,
plus on window focus, until `linked: true`.

## Progress interpolation
With v1.2 `serverTime`: `pos = progressMs + (serverTime - sampledAt) + (Date.now() - receivedAt)`, where
`receivedAt` is the local time the response or PubSub message arrived. All server values come from one EBS clock,
so a skewed viewer clock doesn't matter. Without `serverTime` (older EBS): `progressMs + (Date.now() - sampledAt)`,
with that age capped to 0–2 min. In both cases the viewer's stream delay is subtracted (when stream-delay sync is
on) and the result is clamped to `[0, durationMs]`.

## Spotify branding
Spotify metadata is always shown with the official Spotify full logo plus a **LISTEN ON SPOTIFY ↗** link to the item.
The logo is white on dark backgrounds and green on pure white, at least 70 px wide, with a clear-space zone.
Artwork has 4 px corners (8 px in the large component view) and is never cropped. The asset source, SHA-256 hashes
and all rules applied are in `TWITCH_COMPLIANCE.md` → "Spotify Design & Branding". Don't edit the SVGs: the package
step fails if they differ from the official files.

## Bits extension point (not built)
- Layout slot: `<section id="bits-slot" hidden>` at the bottom of the panel (built in `viewer.js`).
- Hook: `initBits({ slot, ext, auth, getNowPlaying })` in `src/js/bits.js`, called once after the first
  `onAuthorized` in the panel. It is a no-op now. The file sketches the helper calls (`features.isBitsEnabled`,
  `bits.getProducts`, `bits.useBits`, `onTransactionComplete` → send the receipt to the EBS for verification).
- ⚠️ **Policy blocker:** Twitch Guideline **6.2.2** says Bits may not be used "to allow an end user to use Bits to play
  a specific musical track … (e.g., jukebox-like functionality)". A "request a song for Bits" feature as described
  would fail review. Pick a compliant design with product/legal before building anything here.
