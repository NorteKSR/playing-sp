#!/usr/bin/env bash
# End-to-end smoke test: real EBS + local mock Spotify/Twitch upstreams + curl. Uses throwaway secrets.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; EBS_PORT="${EBS_PORT:-8787}"; MOCK_PORT="${MOCK_PORT:-9090}"
cleanup() { kill "${EBS_PID:-}" "${MOCK_PID:-}" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
export TOKEN_ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
export TWITCH_EXTENSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
export PORT=$EBS_PORT HOST=127.0.0.1 DATA_DIR="$WORK/data" LOG_LEVEL=warn ALLOWED_CHANNEL_IDS=12345 \
  SPOTIFY_CLIENT_ID=smoke SPOTIFY_CLIENT_SECRET=smoke SPOTIFY_REDIRECT_URI="http://127.0.0.1:$EBS_PORT/auth/spotify/callback" \
  TWITCH_EXTENSION_CLIENT_ID=smokeext TWITCH_EXTENSION_OWNER_ID=1000 TWITCH_EXTENSION_VERSION=0.0.1 TWITCH_REQUIRED_CONFIGURATION=spotify-linked-v1 POLL_INTERVAL_PLAYING_MS=1000 POLL_INTERVAL_IDLE_MS=1000 POLL_INTERVAL_PAUSED_MS=1000 \
  SPOTIFY_ACCOUNTS_BASE="http://127.0.0.1:$MOCK_PORT" SPOTIFY_API_BASE="http://127.0.0.1:$MOCK_PORT/v1" TWITCH_API_BASE="http://127.0.0.1:$MOCK_PORT/helix"
cd "$WORK"
node "$HERE/scripts/mock-upstreams.js" "$MOCK_PORT" >"$WORK/mock.log" 2>&1 & MOCK_PID=$!
node "$HERE/src/server.js" >"$WORK/ebs.log" 2>&1 & EBS_PID=$!
sleep 1
E="http://127.0.0.1:$EBS_PORT"; MK="http://127.0.0.1:$MOCK_PORT"
B=$(node "$HERE/scripts/mint-jwt.js" broadcaster 12345); V=$(node "$HERE/scripts/mint-jwt.js" viewer 12345); X=$(node "$HERE/scripts/mint-jwt.js" viewer 12345 -60)
fail=0
check() { local name="$1" want="$2" got="$3"; if [[ "$got" == *"$want"* ]]; then echo "PASS $name"; else echo "FAIL $name: wanted '$want' got '$got'"; fail=1; fi; }
check healthz '"ok":true' "$(curl -s $E/healthz)"
check no-token missing_token "$(curl -s $E/api/now-playing)"
check expired token_expired "$(curl -s $E/api/now-playing -H "Authorization: Bearer $X")"
check not-linked '"state":"not_linked"' "$(curl -s $E/api/now-playing -H "Authorization: Bearer $V")"
O=$(node "$HERE/scripts/mint-jwt.js" viewer 99999)
check channel-not-allowed '"code":"channel_not_allowed"' "$(curl -s $E/api/now-playing -H "Authorization: Bearer $O")"
check viewer-config-403 forbidden_role "$(curl -s $E/api/config/status -H "Authorization: Bearer $V")"
check cors-local-test 'access-control-allow-origin: https://localhost:8080' "$(curl -s -i -X OPTIONS $E/api/now-playing -H 'Origin: https://localhost:8080' | tr 'A-Z' 'a-z')"
check server-time '"serverTime":' "$(curl -s $E/api/now-playing -H "Authorization: Bearer $V")"
check cors 'access-control-allow-origin: https://smokeext.ext-twitch.tv' "$(curl -s -i -X OPTIONS $E/api/now-playing -H 'Origin: https://smokeext.ext-twitch.tv' | tr 'A-Z' 'a-z')"
URL=$(curl -s -X POST $E/api/config/link/start -H "Authorization: Bearer $B")
check link-start 'code_challenge_method=S256' "$URL"
S=$(echo "$URL" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(new URL(JSON.parse(d).authorizeUrl).searchParams.get("state")))')
CB=$(curl -s "$E/auth/spotify/callback?code=smokecode&state=$S")
check callback 'Spotify linked' "$CB"
check callback-closes 'window.close()' "$CB"
check required-config '"required_configuration":"spotify-linked-v1"' "$(curl -s $MK/mock/required-configuration)"
check status-required-config '"requiredConfigSet":true' "$(curl -s $E/api/config/status -H "Authorization: Bearer $B")"
check replay-400 400 "$(curl -s -o /dev/null -w '%{http_code}' "$E/auth/spotify/callback?code=smokecode&state=$S")"
check status-linked '"linked":true' "$(curl -s $E/api/config/status -H "Authorization: Bearer $B")"
check playing '"state":"playing"' "$(curl -s $E/api/now-playing -H "Authorization: Bearer $V")"
curl -s -X POST $MK/mock/playing -d '{"status":200,"body":{"is_playing":true,"currently_playing_type":"ad","item":null}}' >/dev/null; sleep 2.5
check ad '"state":"ad"' "$(curl -s $E/api/now-playing -H "Authorization: Bearer $V")"
curl -s -X POST $MK/mock/playing -d '{"status":204}' >/dev/null; sleep 2.5
check nothing '"state":"nothing_playing"' "$(curl -s $E/api/now-playing -H "Authorization: Bearer $V")"
check encrypted-at-rest 'enc:v1:' "$(cat "$WORK/data/tokens.json")"
check unlink '"linked":false' "$(curl -s -X POST $E/api/config/unlink -H "Authorization: Bearer $B")"
sleep 1.2
PS=$(curl -s $MK/mock/pubsub)
check pubsub-playing '\"state\":\"playing\"' "$PS"
check pubsub-ad '\"state\":\"ad\"' "$PS"
check pubsub-not-linked '\"state\":\"not_linked\"' "$PS"
check pubsub-jwt-role '"role":"external"' "$PS"
check pubsub-server-time '\"serverTime\":' "$PS"
echo "pubsub messages sent: $(echo "$PS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).length))')"
[[ $fail == 0 ]] && echo "SMOKE OK" || { echo "SMOKE FAILED"; cat "$WORK/ebs.log"; exit 1; }
