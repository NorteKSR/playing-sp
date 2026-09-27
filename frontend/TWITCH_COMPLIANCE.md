# Twitch Extension compliance notes (frontend)

Checked against the live Twitch docs on **2026-09-26**. Each rule lists the source and how this frontend complies.

## Sources
- Guidelines & Policies — https://dev.twitch.tv/docs/extensions/guidelines-and-policies/
- Extensions overview (security model, CSP, sandbox) — https://dev.twitch.tv/docs/extensions/
- Life Cycle Management (Asset Hosting, zip upload, CSP for reference, Hosted Test) — https://dev.twitch.tv/docs/extensions/life-cycle/
- Building Extensions (helper, JWT to EBS) — https://dev.twitch.tv/docs/extensions/building/
- Extensions Reference (helper API, query params, JWT schema) — https://dev.twitch.tv/docs/extensions/reference/
- Submission Best Practices (allowlist examples, human-readable code) — https://dev.twitch.tv/docs/extensions/submission-best-practices/
- CSP allowlist fields announcement — https://discuss.dev.twitch.com/t/new-extensions-policy-for-content-security-policy-csp-directives-and-timeline-for-enforcement/33695
- Extension PubSub not affected by the legacy PubSub shutdown — https://discuss.dev.twitch.com/t/legacy-pubsub-deprecation-and-shutdown-timeline/58043 ; product status "Extensions: Active" — https://dev.twitch.tv/docs/product-lifecycle/
- PubSub limits (5 KB/message, 100 msgs/min/channel) — forum answer https://discuss.dev.twitch.com/t/custom-topic-for-pubsub-service/41873 (also referenced from the "Send Extension PubSub Message" API docs)

## Rules and how we comply

| Rule (source) | Status in this frontend |
|---|---|
| **Helper must be the first script** in every front-end HTML file (Guidelines 2.9); loaded from `https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js` (Building / CSP `script-src` allows that host). | Every `*.html` loads the helper first. `scripts/package.mjs` fails the build otherwise. |
| **All front-end HTML/CSS/JS must be in the zip**; no extraneous files (2.8). CSP `script-src` = `'self'`, the extension host, `extension-files.twitch.tv`, Google Analytics only → **no remote code** (Extensions overview CSP table). | All JS is bundled locally by esbuild; no CDN libraries, no remote fonts/styles. The zip only contains the 5 HTML files, `css/`, `js/`. Mock/dev code lives in `dev/` and is never built into `dist/` (validator checks for mock references). |
| **No inline scripts** without nonce/hash (Life Cycle → "Content Security Policy": "You cannot run inline scripts without a nonce/hash"). `style-src` does allow `'unsafe-inline'`. | No inline `<script>` bodies or `on*=` attributes (validator enforces). Inline styles are only set via CSSOM (`el.style.transform`), which is allowed anyway. |
| **No `eval()` / human-readable JS** (2.5, 2.6). | Bundles are **not minified**, no source maps, no `eval`/`new Function` (validator enforces). |
| **No iframes inside the extension** (2.2, Life Cycle CSP). | None. (The dev harness uses iframes, but it is dev-only and not packaged.) |
| **Declare every URL the front end fetches** (2.12) and use the three allowlist fields: "Allowlist for **Image** Domains" → `img-src`, "**Media**" → `media-src`, "**URL Fetching**" → `connect-src` (CSP announcement; Extensions overview). Shared hosts must be narrowed (2.13, Best Practices). | We fetch only the EBS (`connect-src`) and album art (`img-src`). Values to configure: **URL Fetching:** the EBS origin, `https://<your EBS host>`. **Config URLs:** `https://accounts.spotify.com` (Spotify authorize popup) + `https://open.spotify.com` (config preview's link back to the track). **Panel URLs:** `https://open.spotify.com` ("LISTEN ON SPOTIFY ↗"). **Image:** `https://i.scdn.co`. **Media:** none. The Spotify logos are bundled in the zip (`img/spotify/*.svg`), so they need no allowlist entry. The Panel/Config URL allowlists are enforced by Twitch, not by CSP, so the harness can't emulate them; instead the e2e test asserts that every rendered link targets `https://open.spotify.com`. The frontend drops any image URL whose host isn't `i.scdn.co` and any link that isn't `open.spotify.com`, so it shows the placeholder art instead of a CSP-blocked image. |
| **HTTPS/WSS only** for external connections; `block-all-mixed-content` (Life Cycle CSP, Extensions overview CSP). | Production build refuses a non-`https://` `EBS_BASE_URL`. |
| **Fonts** only local or Google Fonts; base64 data-URI fonts via bundlers violate CSP (Life Cycle). | System font stack only; no font files. |
| **Sandbox**: `allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox`; **no** `allow-modals` (no `alert/confirm/prompt`), **no top-level navigation** (Extensions overview → "Restrictions on browser APIs"). | Spotify OAuth opens in a **popup/new window** (`window.open`), never top-level navigation. Disconnect confirmation is an inline UI row, not `confirm()`. Fallback link with `target="_blank" rel="noopener noreferrer"` if the popup is blocked. |
| **Relative paths** from the Testing Base URI; zip the **files, not the folder**, HTML at the zip root (Life Cycle; Extensions overview "Package your Extension"). | All asset references are relative (`css/…`, `js/…`); validator rejects absolute/remote paths. The zip has the HTML files at its root. |
| **Zip content**: `.zip` only, no executables or non-asset files (Life Cycle "Upload Version Assets"). Size limit is **not publicly documented**; forum moderators cite "zip too big" and "file names with spaces" as upload failures (https://discuss.dev.twitch.com/t/cannot-upload-files-for-hosted-test/62499). | Zip ≈ 47 KB, 15 files, no spaces in names (validator enforces). |
| **Mobile**: initial page load from Twitch CDN ≤ **1 MB**, load < 3 s at ~500 Kb/s (3.2, 3.3). | Each view's initial load ≈ 25–32 KB (+ album art ~30 KB). `npm run package` prints per-view sizes. |
| **Component extensions must use the entire iframe** and not duplicate component frame UI (2.10, 2.11). | `video_component.html` fills 100% of the frame, no close/minimize/title bar. |
| **Off-site links need a visible indicator** (4.6.2); no Twitch branding (4.3); product branding only as "powered by X" (4.9). | "LISTEN ON SPOTIFY ↗" button (explicit text + arrow). The Spotify logo is shown only as attribution for Spotify content, i.e. it identifies the underlying technology (4.9(b)), with no second brand next to it. No Twitch name/logo in the UI. |
| **Audio** must be muted by default (2.4). | No audio. |
| **No keyboard shortcuts** for functionality (2.3). | None. |
| **Don't inject AJAX data into the DOM without validation** (2.7). | All EBS/PubSub data goes through `src/js/model.js` (type checks, length clamps, control-char stripping, URL host allowlists) and is rendered with `textContent` only. |
| **Bits** (6.x): **6.2.2 forbids Bits "to play a specific musical track … (e.g., jukebox-like functionality)"**; 6.2.8 forbids free-form items. | Bits are **not implemented**. See the warning in `src/js/bits.js` and README: a literal "request a song for Bits" feature would fail review. |

## Other relevant facts
- `onAuthorized` fires on every JWT refresh → we always use the latest token; `token_expired` from the EBS waits for the next `onAuthorized` and retries (Reference → onAuthorized).
- `onContext` provides `theme` (`light`/`dark`), `hlsLatencyBroadcaster`, `arePlayerControlsVisible`, `mode` (Reference → onContext). We apply the theme and optionally delay live updates by the stream latency so viewers see the song they currently hear.
- `onVisibilityChanged`: "must perform only minimal work in the background" (Reference) → while hidden, the progress timer and the 5-min keep-alive fetch both stop. Both resume with an immediate fetch when the view is visible again. `document.visibilitychange` is honoured the same way.
- Client query params include `anchor`, `mode`, `platform`, `popout`, `state` (Reference → Client Query Parameters).
- Extension PubSub (`Twitch.ext.listen('broadcast', …)`) is unaffected by the legacy PubSub shutdown (2025-04-14).

## Spotify Design & Branding (checked 2026-09-26)

**Sources**
- Design & Branding Guidelines: https://developer.spotify.com/documentation/design
- Developer Terms (v10, effective 15 May 2025): https://developer.spotify.com/terms. Section I makes the Branding Guidelines part of the Developer Agreement, and Section III gives a limited, revocable licence to use the Spotify Marks shown in the Branding Guidelines.
- Developer Policy (VI. Naming and Branding): https://developer.spotify.com/policy

**Asset (official source only, bundled unmodified)**
- Downloaded from the "Download Full Logo" button on the guidelines page:
  `https://developer.spotify.com/images/guidelines/design/2024-spotify-full-logo.zip`
  (sha256 `b3d28ef2474a46b88aeb67c1449b522046003233a3df59e8e63582830101270f`, files dated 2024-08-19).
- Bundled files, copied byte-for-byte from that zip:
  - `img/spotify/Full_Logo_White_RGB.svg`: sha256 `31cdfcdd58d3533a32d287267a1c404f376749b1fc4da99e4baa2233684f053c`
  - `img/spotify/Full_Logo_Green_RGB.svg`: sha256 `6e01367cde4cb752b11fd9250becc4a579d1f40bdddaaf23522f27aaa5cf8d70`
  - `scripts/package.mjs` and `test/unit/brand.test.mjs` fail if either file changes.
- The black variant and the icon-only zip (`2024-spotify-logo-icon.zip`) are not bundled, because they're unused (Twitch 2.8 bans extraneous files).
- **Licensing:** the logo is a Spotify trademark. We may use it only under the Developer Terms licence and only as the guidelines describe. It is not covered by this project's licence, grants no ownership, and Spotify can revoke it.

**Rules applied**
| Guideline rule | Implementation |
|---|---|
| Spotify metadata and artwork "must always be accompanied by the Spotify brand"; partner integrations should use the **full logo** (icon + wordmark); the icon alone only when there isn't room. | The full logo appears in the panel, overlay and component footers, and in the config/live-config preview, whenever a track or episode is shown. When no metadata is shown (loading, nothing playing, not connected, error), the logo is hidden. |
| Green logo only on black or white; black logo on light backgrounds, white logo on dark ones. | Dark theme (`#191414`) → **white** logo. Light theme (pure `#ffffff`, including the config card) → **green** logo. Overlay card (dark, 88% opaque over video) → always **white**. Chosen by CSS on `html[data-theme]`; the e2e test checks every case. |
| Minimum size: logo ≥ 70 px digital (icon ≥ 21 px). | 84 px wide × ~23 px (the icon is ~22 px). The e2e test asserts ≥ 70 px. |
| Exclusion zone = half the icon height. | 11 px transparent padding around the logo (`.sp-logo`); no other element sits inside it. |
| No modification: no rotating, recolouring, stretching, using it in a sentence, or placing it on busy/low-contrast areas. | Unmodified SVG files, `height: auto` (aspect ratio kept), never inside text, never on artwork; the overlay puts it on a solid dark card, not directly on the video. |
| Metadata "must always link back to the Spotify Service"; link text OPEN SPOTIFY / PLAY ON SPOTIFY / LISTEN ON SPOTIFY. | A **LISTEN ON SPOTIFY ↗** link to `item.url` (open.spotify.com) in the panel, overlay, component and config preview. |
| Artwork: original form, no crop/overlay/blur; corners rounded 4 px (small/medium) or 8 px (large); no logo on artwork; OK to omit artwork if space is limited. | `object-fit: contain`, nothing drawn over the art. 4 px radius in panel and overlay, 8 px in the component view. A neutral placeholder when `imageUrl` is null or fails to load. |
| Metadata must be legible and unmodified; truncation is allowed but the full text must be viewable. | Text comes straight from the EBS (only control characters stripped and length capped at 300). Truncated lines carry the full text in a `title` tooltip, and the link opens the full item. The panel title wraps to 2 lines. |
| Podcasts: episode title + podcast name. | The episode shows its title and the show name as the subtitle, with a "Podcast" eyebrow. |
| Playing views: background from artwork colour, otherwise `#191414`. | The dark theme and overlay card use `#191414`. **Deviation (project-lead decision, 2026-09-26):** the light theme stays pure white to match the viewer's Twitch light theme; artwork-derived backgrounds won't be built. |
| No play controls recommended; the progress bar must not imply seeking. | No controls. The progress bar has no handle, no pointer cursor and no interaction. |
| Explicit badge (required for South Korea). | An "E" badge next to explicit titles. |
| Fonts: platform default sans-serif, then Helvetica Neue / Helvetica / Arial. | System stack (Inter/Roobert first to match Twitch, then Helvetica Neue, Helvetica, Arial, system-ui). |
| Don't pair brands / co-brand. App name mustn't include "Spotify" (suggesting "for Spotify" is OK). | No other brand next to the Spotify logo. The config heading was renamed from "Now Playing — Spotify" to **"Now Playing"**. The Twitch listing name should also avoid "Spotify" (e.g. "Now Playing for Spotify" is OK). |

**Legal flags for the project lead (from the Spotify Developer Policy, not verified with counsel)**
- The policy says "Do not synchronize any sound recordings with any visual media, including … video" and "Do not create any product or service which is integrated with streams or content from another service". It also says Spotify is for personal, non-commercial use and "can't be broadcast or played publicly".
- This extension only *displays* now-playing metadata (it plays no audio). Still, a Twitch integration could be read as "integrated with streams from another service", and streamers playing Spotify music on stream is itself restricted by Spotify's user terms.
- The Developer Terms licence for SDAs also mentions "private personal use".
- Recommend a legal/partner check with Spotify before public release (the backend team's quota-extension application would surface this anyway).
