# API Contract – Twitch "Now Playing on Spotify" Extension (EBS ⇄ Frontend)

**Owner:** backend (EBS). **Consumers:** frontend (panel / overlay / config / live-config views).
**Contract version:** 1.2 (document). Payload `version` field is still **1**: all changes since v1 are additive.

## Changelog
- **v1.2 (2026-09-26, response to frontend contract feedback; payload `version` stays 1, additive)**
  - **`serverTime`** (epoch ms, EBS clock) added to every NowPlaying payload: `GET /api/now-playing` (stamped when
    the response is built) and PubSub `now_playing`/`heartbeat` (stamped when actually sent, after rate-limit
    delay). See §4 for how to use it.
  - **CORS:** the Twitch Local Test origin (Testing Base URI, default `https://localhost:8080`) is allowed. It is
    configurable through `TWITCH_LOCAL_TEST_ORIGINS`.
  - **Callback popup:** the `/auth/spotify/callback` page now closes itself, after 1.5 s on success and 10 s on
    failure. If `window.close()` is refused, it shows a fallback message and a Close button. If `window.opener` is
    still available, it first posts `{type:"spotify_link_result", version:1, ok, reason}` (§3).
  - **`GET /api/config/status`** adds `requiredConfigSet`: `true`/`false`, or `null` when the feature is disabled.
    It reports whether the EBS set Twitch's required-configuration string for this channel.
  - Answers to the frontend's open questions are in §7.
- **v1.1 (2026-09-26, after platform research + implementation; payload `version` stays 1, non-breaking)**
  - `GET /api/config/status`: **removed `spotify.product`** (Spotify removed `product` from `/me` for dev-mode apps
    in Feb 2026). `lastError` values are now listed (§3).
  - **Keep-alive (new, please implement):** call `GET /api/now-playing` on load, on every `onAuthorized`, **and every
    ~5 minutes while the extension is visible**. The EBS only polls Spotify for channels viewed in the last 10 minutes,
    to save Spotify dev-mode quota. PubSub stops for channels nobody is viewing.
  - The first `GET /api/now-playing` after a cold start may take up to ~3 s (on-demand Spotify poll).
  - Added `405` (code `bad_request`) for the wrong HTTP method. `/api/*` is rate-limited at 120 req/min per user+channel.
  - Twitch console allowlists the frontend needs: URL fetching → the EBS origin; Config URLs →
    `https://accounts.spotify.com`; image domain → `https://i.scdn.co`.
  - Twitch confirmed that Extension PubSub is **not** affected by the 2025 legacy-PubSub shutdown, so there is no
    transport change.
- **v1 (2026-09-26, initial draft)**: endpoints, auth, state model, PubSub message shape, errors.

---

## 1. Base URL, transport, CORS
- Base URL: configured as the extension's EBS URL, e.g. `https://ebs.example.com` (local dev: `http://localhost:8080`).
  For local frontend work without real credentials, run the backend against the bundled mocks
  (`backend/README.md`, "How to run") and mint test JWTs with `npm run -s mint-jwt -- viewer 12345`.
  Twitch hosted test / production requires **HTTPS**; the frontend must also list the EBS origin in the extension's
  **Allowlist for URL Fetching Domains** in the Twitch Developer Console.
- All JSON endpoints return `Content-Type: application/json; charset=utf-8`.
- **CORS:** the EBS answers preflight (`OPTIONS`) and sets
  `Access-Control-Allow-Origin` to the request `Origin` if it is in `CORS_ALLOWED_ORIGINS`
  (default for Twitch-hosted assets: `https://<client_id>.ext-twitch.tv`; local dev e.g. `http://localhost:8081`).
  **v1.2:** the Twitch **Local Test** origin (the Testing Base URI origin, default `https://localhost:8080`) is also
  allowed through `TWITCH_LOCAL_TEST_ORIGINS`.
  Allowed headers: `Authorization, Content-Type`. Allowed methods: `GET, POST, DELETE, OPTIONS`. No cookies/credentials are used.

## 2. Authentication
Every `/api/*` request must carry the **Twitch extension JWT** that the frontend receives from
`window.Twitch.ext.onAuthorized(auth => auth.token)`:

```
Authorization: Bearer <auth.token>
```

The EBS verifies it (HS256, base64-decoded extension secret, `exp` not passed) and reads
`channel_id`, `role` (`broadcaster` | `moderator` | `viewer` | `external`), `opaque_user_id`, `user_id` (optional).
Always use the **latest** token from `onAuthorized` (it is refreshed periodically).

| Endpoint group | Required role |
|---|---|
| `GET /api/now-playing` | any valid extension JWT |
| `/api/config/*` | `broadcaster` |

## 3. Endpoints

### `GET /healthz` (no auth)
`200 {"ok": true}`

### `GET /api/now-playing`
Returns the cached current state for the channel in the JWT (`channel_id`). Call it on load, after every
`onAuthorized`, and **every ~5 min while visible** (keep-alive, see changelog). Between calls, keep the UI up to date from PubSub.

`200` → a **NowPlaying** object (see §4). If the channel never linked Spotify: `state: "not_linked"`.

### `GET /api/config/status`  (broadcaster)
```json
{
  "version": 1,
  "linked": true,
  "spotify": { "userId": "abc123", "displayName": "Streamer" },
  "linkedAt": "2026-09-26T23:00:00.000Z",
  "scopes": ["user-read-currently-playing", "user-read-playback-state"],
  "lastError": null
}
```
(plus `"requiredConfigSet": true|false|null`, v1.2).
When not linked: `{"version":1,"linked":false,"spotify":null,"linkedAt":null,"scopes":[],"lastError":null|"revoked","requiredConfigSet":false|null}`.

`requiredConfigSet` (v1.2): `null` means the EBS doesn't manage Twitch Required Configuration. `true` means the
string is set for this channel and extension version, so the broadcaster can activate the extension. `false` means
it isn't set yet or the last attempt failed; each status call retries. Suggested UI while `linked && requiredConfigSet === false`:
"Finishing setup with Twitch…".
`lastError` values:
| value | meaning / suggested UI |
|---|---|
| `null` | all good |
| `revoked` | (with `linked:false`) Spotify access was revoked or the refresh token is invalid → show "Reconnect Spotify" |
| `spotify_forbidden` | Spotify returned 403. Most likely the Spotify account is **not on the app's dev-mode allowlist** (max 5 users) or the app owner's Premium lapsed → "Ask the extension developer to add your Spotify account" |
| `rate_limited` / `quota_exceeded` | Temporarily throttled by Spotify; updates resume automatically |
| `token_refresh_failed` / `network_error` / `spotify_<status>` | Transient upstream problem; retrying automatically |

### `POST /api/config/link/start`  (broadcaster)
Body: none (or `{}`). Returns the Spotify authorize URL; the config page opens it in a **new window/tab**
(`window.open(url)`; Spotify's login page cannot be framed). The `state` inside it is signed, bound to the
channel, and expires after 10 minutes.
```json
{ "version": 1, "authorizeUrl": "https://accounts.spotify.com/authorize?...", "expiresIn": 600 }
```
After the user approves, Spotify redirects to `GET /auth/spotify/callback` (EBS), which shows a small HTML
page ("Spotify linked"). **v1.2:** the page closes itself, after 1.5 s on success and 10 s on failure, and shows a
"you can close this window" fallback plus a Close button if the browser refuses. If `window.opener` is still set,
it also calls `opener.postMessage({type:"spotify_link_result", version:1, ok:true|false, reason:null|"access_denied"|"invalid_state"|"expired_state"|"missing_code"|"exchange_failed"|"spotify_error"}, <origin>)`
for each allowed CORS origin. Verify `event.origin` equals the EBS origin before trusting it. The message is only a
hint: status polling remains the source of truth. The current frontend sets `popup.opener = null`, so it won't
receive this message; that is fine. The config page should then poll
`GET /api/config/status` (e.g. every 2 s for up to 2 min, or on window focus) until `linked: true`.

### `GET /auth/spotify/callback?code=…&state=…`  (no JWT; called by Spotify redirect)
Returns HTML (not JSON). Success → 200 page. Failure (denied, bad/expired state, exchange error) → 400 page
with a short reason. Not called by the frontend directly.

### `POST /api/config/unlink`  (broadcaster)  – alias: `DELETE /api/config/link`
Deletes stored Spotify tokens for the channel, stops polling, and broadcasts a `not_linked` state.
`200 {"version":1,"linked":false}`

## 4. NowPlaying object (HTTP response AND PubSub payload)
```json
{
  "version": 1,
  "type": "now_playing",
  "channelId": "123456",
  "state": "playing",
  "item": {
    "kind": "track",
    "id": "1AbCdEfGhIjKlMnOpQrStU",
    "name": "Song Title",
    "artists": ["Artist A", "Artist B"],
    "album": "Album Name",
    "show": null,
    "imageUrl": "https://i.scdn.co/image/....",
    "durationMs": 215000,
    "url": "https://open.spotify.com/track/1AbCdEfGhIjKlMnOpQrStU",
    "explicit": false
  },
  "progressMs": 42000,
  "isPlaying": true,
  "sampledAt": 1790000000000,
  "updatedAt": 1790000000000,
  "serverTime": 1790000000350
}
```
Field notes:
- `state` – one of:
  | state | meaning | `item` |
  |---|---|---|
  | `playing` | a track or podcast episode is playing | object (`item.kind` = `track` or `episode`) |
  | `paused` | playback paused on a track/episode | object |
  | `nothing_playing` | no active device / nothing playing (Spotify 204) | `null` |
  | `ad` | an advertisement is playing | `null` |
  | `not_linked` | broadcaster has not linked Spotify (or link was revoked) | `null` |
  | `unknown` | Spotify returned an unrecognised type, or a transient state with no item | `null` |
- **Podcast episode** = `state` `playing`/`paused` with `item.kind: "episode"`; then `artists: []`,
  `album: null`, `show: "Show Name"`.
- `artists` is an array of names (strings). `imageUrl` may be `null`.
- `progressMs` is the playback position at `sampledAt` (EBS epoch ms). Frontend can extrapolate while `isPlaying`:
  `pos = progressMs + (Date.now() - sampledAt)` clamped to `durationMs` (clock skew: treat as approximate).
- `updatedAt` – epoch ms when the state last *changed*.
- `serverTime` (v1.2) – EBS clock (epoch ms) when this payload was sent. All three timestamps come from the same
  EBS clock, so progress can be computed without trusting the viewer's clock. On receipt, record
  `receivedAt = Date.now()` (local clock), then compute
  `pos = progressMs + (serverTime - sampledAt) + (Date.now() - receivedAt)` while `isPlaying`, clamped to
  `[0, durationMs]`. Treat a missing `serverTime` (older EBS) as before.
- Unknown extra fields may be added later; ignore them. Breaking changes bump `version`.

## 5. Twitch Extension PubSub
- Target: **`broadcast`** (all viewers of the channel). Content type `application/json`.
- Message: the NowPlaying object above, JSON-stringified (same shape as `GET /api/now-playing`).
  Frontend:
  ```js
  Twitch.ext.listen('broadcast', (target, contentType, message) => {
    const msg = JSON.parse(message);
    if (msg.version !== 1) return;          // or handle migrations
    if (msg.type === 'now_playing') render(msg);
    if (msg.type === 'heartbeat') {/* optional: channel still alive, same shape as now_playing */}
  });
  ```
- Sent **only when the state changes** (track change, play/pause, state change, seek > ~10 s), plus a
  **heartbeat** at most every 60 s while `playing` with `type: "heartbeat"` and otherwise identical body
  (so late joiners / progress drift get corrected). Treat `heartbeat` exactly like `now_playing`.
- Message size stays well under Twitch's 5 KB limit (long names are truncated to 200 chars).
- PubSub delivery is best-effort: on load (and whenever `onAuthorized` fires again) always call
  `GET /api/now-playing`.

## 6. Errors
All errors: `{"version":1,"error":{"code":"<code>","message":"<human readable>"}}`

| HTTP | code | when |
|---|---|---|
| 400 | `bad_request` | malformed body / params |
| 401 | `missing_token` | no `Authorization: Bearer` header |
| 401 | `invalid_token` | bad signature, malformed, missing `channel_id` |
| 401 | `token_expired` | JWT `exp` passed → get fresh token from `onAuthorized` and retry |
| 403 | `forbidden_role` | e.g. viewer calling `/api/config/*` |
| 404 | `not_found` | unknown route |
| 405 | `bad_request` | wrong HTTP method for a known route |
| 409 | `not_linked` | action requires a linked Spotify account |
| 429 | `rate_limited` | too many requests; `Retry-After` header (seconds) |
| 500 | `internal_error` | unexpected |
| 502 | `upstream_error` | Spotify/Twitch failed |

## 7. Answers to the frontend's open questions (v1.2)
1. **Panel URL allowlist:** keep the "Open in Spotify" link. Add `https://open.spotify.com` to **Allowlist for Panel
   URLs** (and the Config URLs list if the live config view shows it). `item.url` is always an
   `https://open.spotify.com/...` URL or `null`. This is in the backend README console steps.
2. **Clock skew:** `serverTime` was added (see §4).
3. **CORS for Local Test:** done. `https://localhost:8080` is allowed by default; set `TWITCH_LOCAL_TEST_ORIGINS`
   for other ports. Note that the EBS also defaults to port 8080. If both run on one machine, start the EBS with
   `PORT=8787` (or similar) and point `EBS_BASE_URL` there.
4. **Callback page closes itself:** done (see §3).
5. **Required configuration:** supported, but optional and off unless configured.
   - Console: **Capabilities → Extension Configuration Service → "Custom/My Own Service"**, with Required
     Configurations string = the EBS's `TWITCH_REQUIRED_CONFIGURATION` (suggested `spotify-linked-v1`) for the
     version in `TWITCH_EXTENSION_VERSION`.
   - The EBS sets it after a successful link. It is left alone on unlink unless
     `TWITCH_REQUIRED_CONFIGURATION_ON_UNLINK` is set.
   - If the owner doesn't enable it, pick "None" (the default in your README) and `requiredConfigSet` is `null`.
   - The frontend doesn't need to call anything. Optionally, show "Finishing setup with Twitch…" when
     `requiredConfigSet === false` while linked.
6. **Production EBS URL:** not decided yet. It depends on where the owner deploys (it needs HTTPS and a persistent
   volume; see backend README "Deployment notes"). It is an owner decision and blocks `EBS_BASE_URL` at package time.
