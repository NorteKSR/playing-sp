# Deploying the Playing SP EBS (Fly.io)

This guide deploys the backend (`backend/`) to a permanent `https://<your-app>.fly.dev` URL on Fly.io.
Replace `<your-app>` everywhere with the app name you choose.

Why Fly.io (prices checked September 2026; verify current pricing before you deploy): it was the cheapest always-on
option with a persistent volume. One `shared-cpu-1x` 256 MB machine was about $2.19/mo and a 1 GB volume $0.15/GB/mo,
so **roughly $2.35/mo**. That includes free HTTPS on `<your-app>.fly.dev` and a shared IPv4. Sources: https://fly.io/pricing-update/ ,
https://fly.io/docs/about/pricing/ . See "Alternatives" at the bottom for Railway and Render.

Files used: `backend/Dockerfile`, `backend/docker-entrypoint.sh`, `backend/.dockerignore`, `backend/fly.toml`.
The image contains no secrets. The encrypted token store (`tokens.json`) lives in `DATA_DIR=/data`, and the
Fly volume is mounted there. The app runs as the unprivileged `node` user, listens on `0.0.0.0:8080`, and
Fly health-checks `GET /healthz`. `auto_stop_machines = "off"` + `min_machines_running = 1` keep the
Spotify poller running at all times.

> Never commit secret values or put them in `fly.toml`. Type them directly into the Fly CLI or dashboard.

---

## 1. Create a Fly.io account (a credit card is required)
1. Sign up at https://fly.io/app/sign-up .
2. Add a credit card (Dashboard → Billing). Fly says: "All organizations require a credit card on file"
   (https://fly.io/docs/about/pricing/). The free trial (https://fly.io/docs/about/free-trial/) auto-stops machines
   after a few minutes, which doesn't work for an always-on poller.

## 2. Install the CLI and log in
```bash
curl -L https://fly.io/install.sh | sh      # macOS alternative: brew install flyctl ; Windows: see https://fly.io/docs/flyctl/install/
fly auth login                              # opens the browser
```

## 3. Create the app (choose the permanent name)
The app name becomes your URL: `https://<your-app>.fly.dev`. The name must be globally unique.
```bash
cd backend
fly apps create <your-app>
```
Then set `app = "<your-app>"` in `backend/fly.toml` to the same name.

`primary_region` in `fly.toml` defaults to `sjc` (San Jose, California). Pick the region closest to you or your
streamers (`fly platform regions`) and use the same region for the volume below.

## 4. Create the persistent volume (same region as primary_region)
```bash
fly volumes create ebs_data --region sjc --size 1 --app <your-app>
```
Answer "yes" to the single-volume warning. One machine is intended: the token store is a single file.
Fly takes daily volume snapshots by default.

## 5. Set the configuration and secrets
Non-secret defaults are already in `fly.toml` `[env]`: `NODE_ENV`, `HOST=0.0.0.0`, `PORT=8080`, `DATA_DIR=/data`,
`LOG_LEVEL=info`, `TWITCH_LOCAL_TEST_ORIGINS=""` (disables the Local Test CORS origins), `SPOTIFY_USE_PKCE=true`,
`POLLER_ENABLED=true`.

Set the rest with `fly secrets set` or `fly secrets import`. Fly encrypts the values and never shows them again.
You can also use the dashboard: app → **Secrets**. Tip: `fly secrets import` reads `NAME=value` lines from stdin
(type them, then Ctrl-D), which keeps secrets out of your shell history.

| Variable | What it is | Secret? | Value |
|---|---|---|---|
| `SPOTIFY_CLIENT_ID` | Spotify app Client ID | no | `YOUR_SPOTIFY_CLIENT_ID` |
| `SPOTIFY_CLIENT_SECRET` | Spotify app Client Secret | **SECRET** | from the Spotify developer dashboard |
| `SPOTIFY_REDIRECT_URI` | OAuth callback; must exactly match one registered in Spotify | no | `https://<your-app>.fly.dev/auth/spotify/callback` |
| `PUBLIC_BASE_URL` | Public URL of this EBS | no | `https://<your-app>.fly.dev` |
| `TWITCH_EXTENSION_CLIENT_ID` | Extension Client ID | no | `YOUR_TWITCH_EXTENSION_CLIENT_ID` |
| `TWITCH_EXTENSION_SECRET` | Extension secret (base64, exactly as shown in the Twitch console) | **SECRET** | from the Twitch developer console |
| `TWITCH_EXTENSION_OWNER_ID` | Twitch user ID of the extension owner | no | `YOUR_TWITCH_USER_ID` |
| `TOKEN_ENCRYPTION_KEY` | 32-byte key encrypting `tokens.json` and signing OAuth state | **SECRET** | generate: `openssl rand -base64 32` |
| `CORS_ALLOWED_ORIGINS` | Allowed browser origins | no | `https://YOUR_TWITCH_EXTENSION_CLIENT_ID.ext-twitch.tv` (also the default) |
| `TWITCH_EXTENSION_VERSION` | Installed extension version (optional) | no | e.g. `0.0.1` |
| `TWITCH_REQUIRED_CONFIGURATION` | Required Configurations string (optional; only if set in the console) | no | leave unset unless you use it |
| `TWITCH_REQUIRED_CONFIGURATION_ON_UNLINK` | Optional value written on unlink | no | leave unset |
| `ALLOWED_CHANNEL_IDS` | Optional channel allowlist: comma-separated numeric Twitch channel IDs; others get 403 `channel_not_allowed`. Unset = all channels | no | e.g. `12345678` (only your channel), or leave unset |
| `TWITCH_LOCAL_TEST_ORIGINS` | Extra CORS origins for Twitch Local Test | no | already `""` in fly.toml |
| `API_RATE_LIMIT_PER_MINUTE`, `POLL_*`, `HEARTBEAT_INTERVAL_MS`, `SEEK_THRESHOLD_MS`, `POLL_ONLY_WHEN_VIEWED`, `VIEWER_ACTIVITY_WINDOW_MS`, `TWITCH_PUBSUB_DISABLED`, `TWITCH_JWT_CLOCK_TOLERANCE_SEC`, `LOG_LEVEL` | Tuning knobs (see `backend/.env.example`) | no | defaults are fine |
| `PORT`, `HOST`, `DATA_DIR` | Server/listen/data dir | no | already in fly.toml; don't change |

Example (non-secret values on the command line, secrets via stdin):
```bash
fly secrets set --app <your-app> --stage \
  SPOTIFY_CLIENT_ID=YOUR_SPOTIFY_CLIENT_ID \
  TWITCH_EXTENSION_CLIENT_ID=YOUR_TWITCH_EXTENSION_CLIENT_ID TWITCH_EXTENSION_OWNER_ID=YOUR_TWITCH_USER_ID \
  CORS_ALLOWED_ORIGINS=https://YOUR_TWITCH_EXTENSION_CLIENT_ID.ext-twitch.tv \
  PUBLIC_BASE_URL=https://<your-app>.fly.dev \
  SPOTIFY_REDIRECT_URI=https://<your-app>.fly.dev/auth/spotify/callback
fly secrets import --app <your-app> --stage
# now type (then Ctrl-D):
# SPOTIFY_CLIENT_SECRET=...
# TWITCH_EXTENSION_SECRET=...
# TOKEN_ENCRYPTION_KEY=...        (output of: openssl rand -base64 32)
```
(`--stage` stores them without deploying. The first deploy picks them up.)

**About `TOKEN_ENCRYPTION_KEY`:** changing it makes existing `tokens.json` unreadable, so streamers must relink Spotify.
If you move from another host, either generate a new key and relink (simplest) or reuse the old key **and** migrate
the store (optional section below).

## 6. Before deploying: register the Spotify redirect URI
Spotify developer dashboard → your app → Edit settings → Redirect URIs → add
`https://<your-app>.fly.dev/auth/spotify/callback` → Save.

## 7. Deploy
```bash
cd backend
fly deploy --ha=false --app <your-app>   # builds backend/Dockerfile remotely, attaches volume ebs_data at /data
fly status --app <your-app>              # expect 1 machine, state "started", checks passing
fly logs --app <your-app>                # expect "EBS listening on http://0.0.0.0:8080"
```

## 8. Verify
```bash
curl -i https://<your-app>.fly.dev/healthz               # expect HTTP 200 and {"ok":true}
curl -i https://<your-app>.fly.dev/api/now-playing       # expect HTTP 401 missing_token
```
Then open the extension config page (after the Twitch steps below), click Connect Spotify, and confirm the current
track shows. After linking, `fly ssh console -C "ls -la /data"` should show `tokens.json` owned by `node`.

---

## Twitch and frontend steps
1. **Twitch developer console** → your extension → version → Capabilities → **Allowlist for URL Fetching Domains**:
   add `https://<your-app>.fly.dev`.
2. **CORS:** the extension frontend runs on `https://YOUR_TWITCH_EXTENSION_CLIENT_ID.ext-twitch.tv`, which is the
   default `CORS_ALLOWED_ORIGINS`. Change it only if you serve the frontend from another origin.
3. **Build and upload the frontend** with the EBS URL (in `frontend/`):
   `EBS_BASE_URL=https://<your-app>.fly.dev npm run package`, then upload the zip in the Twitch console.
4. If you moved from a temporary URL (e.g. a dev tunnel), remove the old redirect URI and allowlist entries once the
   new host works, and have streamers relink Spotify unless you migrated the token store.

## Optional: migrate an existing token store instead of relinking
Set `TOKEN_ENCRYPTION_KEY` on Fly to the **same** value the old host used. After the first deploy:
```bash
fly ssh sftp shell --app <your-app>   # then:  put backend/data/tokens.json /data/tokens.json   (Ctrl-D to exit)
fly ssh console --app <your-app> -C "chown node:node /data/tokens.json"
fly apps restart <your-app>
```
Stop the old backend right after migrating, so two pollers don't refresh the same Spotify tokens.

## Optional: restrict the backend to specific channels
Set `ALLOWED_CHANNEL_IDS` to a comma-separated list of numeric Twitch channel IDs (see `backend/README.md` →
"Channel allowlist"). Every other channel gets `403 channel_not_allowed` ("This extension is private.") and is never
polled. It complements Twitch's Streamer Allowlist (Access tab of the extension version in the Twitch developer
console, see https://dev.twitch.tv/docs/extensions/life-cycle/), which controls which streamers can install the released extension.
```bash
fly secrets set ALLOWED_CHANNEL_IDS=12345678 --stage --app <your-app>
fly deploy --ha=false --app <your-app>
fly secrets unset ALLOWED_CHANNEL_IDS --app <your-app>   # remove the restriction again
```
The startup log shows only the list size ("Channel allowlist: 1 channel(s) allowed").

## Useful commands
`fly logs` · `fly status` · `fly secrets list` (names and digests only) · `fly deploy` (redeploy after code changes) ·
`fly volumes list` · `fly volumes snapshots list <vol-id>` · `fly scale show`

## Alternatives (not configured; the same Dockerfile works)
- **Railway**: Hobby plan $5/mo including $5 of usage; a small always-on Node service plus a volume ($0.15/GB/mo)
  should fit. Dashboard + GitHub deploys; set Root Directory `backend`, add a volume at `/data`, domain
  `*.up.railway.app`. Railway volumes mount as root; the entrypoint fixes ownership when the container starts as root.
  https://railway.com/pricing , https://docs.railway.com/volumes
- **Render**: the free tier spins down after 15 minutes idle and has no persistent disk, so it's unsuitable.
  Starter $7/mo + disk $0.25/GB/mo. https://render.com/docs/free , https://render.com/pricing , https://render.com/docs/disks
