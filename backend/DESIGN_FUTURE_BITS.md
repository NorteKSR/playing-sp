# Design: Viewers spend Bits to add a song to the queue (future phase, NOT implemented)

Status: design only. Verify the **policy gate** in §0 before writing code.

## 0. Gate: policy and platform feasibility (blocking)
- **Twitch Extension Guidelines 6.2.2 prohibit this feature as specified.** Bits may not be used "to allow an end
  user to use Bits to play a specific musical track or audio-visual work (e.g., jukebox-like functionality)"
  ([guidelines](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/); flagged by the frontend and
  verified 2026-09-26). An extension that sells song requests for Bits would fail review.
  - Compliant alternatives to evaluate with product/legal: free song requests, with broadcaster approval.
  - A 6.1.4-style **vote** (Bits to support an outcome in a broadcaster-defined poll) is a grey area if the options
    are specific tracks.
  - Bits for non-music perks.
  The rest of this document stays as a technical design in case the policy changes or a compliant variant reuses
  the plumbing (receipt verification, idempotency, moderation).
- **Spotify Developer Policy §IV** bars commercial use of apps except narrow cases for "Non-Streaming SDAs".
  Endpoint notes also state "streaming applications may not be commercial" and "Spotify content may not be broadcasted".
  Selling queue slots for Bits is e-commerce tied to controlling Spotify playback, and the audio is played on a live
  broadcast. **This needs written confirmation from Spotify and/or legal review.**
- **Dev-mode Spotify apps** are meant for "non-commercial use by individual developers" (Feb 2026) and are capped
  at 5 users. A monetized feature realistically needs Extended Quota (organization, 250k+ MAU).
- `POST /me/player/queue` needs **Premium** on the *broadcaster's* account, the extra scope
  `user-modify-playback-state` (existing links must re-consent), and an **active device**.
- Twitch side: Bits in Extensions needs monetization onboarding (or affiliate/partner status), and the channel must be
  Bits-eligible (`Twitch.ext.features.isBitsEnabled`). Extension review applies, and Twitch music/DMCA guidelines
  still apply to the broadcaster.
- Fallback if Spotify says no: a **free** "song request" queue (no Bits) that the broadcaster approves manually,
  or Bits spent on non-Spotify perks (for example, highlighting a request).

## 1. Products / SKUs
Defined in Twitch Developer Console → Monetization → Bits products (an "inDevelopment" flag exists for testing).

| SKU | Cost | Meaning |
|---|---|---|
| `queue_song_100` | 100 Bits | Add one track to the queue (standard) |
| `queue_song_priority_500` | 500 Bits | Optional later: request shown with a highlight; Spotify has no "priority" API, so only UI prominence |

Rules:
- Only tracks can be requested (no episodes).
- Price tiers are fixed per SKU; per-channel pricing is only possible by picking among predefined SKUs.
- The broadcaster enables the feature per channel in the config view (off by default) and chooses which SKU is active.

## 2. End-to-end flow ("reserve → pay → fulfill")
Bits cannot be refunded programmatically, so as much validation as possible happens **before** `useBits`.

1. **Search** (viewer): `GET /api/queue/search?q=` (auth: any role; rate-limited per `opaque_user_id`; anonymous
   `A…` users are rejected, since viewers must be logged in to use Bits anyway).
   - The EBS calls Spotify `GET /search?type=track&limit=10` (the dev-mode max is now 10) using the
     broadcaster's token and market.
   - It returns a trimmed list: id, name, artists, duration, explicit, image.
2. **Reserve** (viewer): `POST /api/queue/requests {trackId, sku}` checks, in order:
   - the feature is enabled and the channel is linked with the `user-modify-playback-state` scope;
   - moderation rules (§4) and track validity (`GET /tracks/{id}`: playable, not explicit if blocked, duration limit);
   - Spotify has an active device (`GET /me/player`, not 204);
   - the per-viewer limit is not exceeded.
   On success it creates `QueueRequest{id, channelId, userId, trackId, sku, status:"reserved", expiresAt: now+2min}`
   and returns `{requestId, sku}`.
3. **Pay** (frontend): `Twitch.ext.bits.useBits(sku)`, then `onTransactionComplete(tx)`.
4. **Confirm** (viewer): `POST /api/queue/requests/{requestId}/confirm {transactionReceipt}`:
   - Verify the receipt JWT (HS256, base64-decoded extension secret, reusing `verifyHS256`) and check:
     - `topic === "bits_transaction_receipt"`;
     - `exp` has not passed;
     - `data.userId === JWT user_id`;
     - `data.product.sku === request.sku`;
     - `data.product.cost.amount` matches the SKU price;
     - `data.product.inDevelopment` is false in production.
   - **Idempotency:** `data.transactionId` is a unique key. The same receipt twice is a no-op that returns the
     earlier result.
   - Optional hardening: cross-check the transaction via Helix `GET /extensions/transactions?id=` (app access token),
     or rely on the EventSub `extension.bits_transaction.create` webhook as the authoritative source. Reconcile
     transactions that arrive through EventSub without a matching confirm call, for example when the viewer closed
     the tab.
5. **Fulfill:** `POST /v1/me/player/queue?uri=spotify:track:{id}` with the broadcaster token. On 204, mark the request
   `fulfilled` and broadcast a PubSub message `{version:1, type:"queue_added", requestId, track, by: displayName}`.
   It shares the channel's PubSub budget with `now_playing` (1 msg/s, 100/min), so it goes through
   `RateLimitedPublisher`.

## 3. Failure handling and "refunds"
There is **no programmatic Bits refund**, so the design minimizes failures after payment and compensates when they happen:

| Failure after payment | Handling |
|---|---|
| Spotify 429 / 5xx | Retry with back-off (honor `Retry-After`) for up to ~10 min, persisted in a durable job table |
| No active device (404/403 "NO_ACTIVE_DEVICE") | Keep the request `pending_device`, show it to the broadcaster, and retry when playback resumes (the poller sees `playing`) for up to N hours |
| Premium lost / scope missing / unlinked | Mark `failed_compensate`; notify the broadcaster in the live config view |
| Anything unrecoverable | Grant a **credit** (`credits[userId][channelId] += 1`) usable for a free future request, show "Your request couldn't be queued; you have 1 free request credit", and let the broadcaster or support handle manual refunds per Twitch's support process |

Every state transition is audit-logged (requestId, transactionId, timestamps, Spotify status codes).

## 4. Moderation and limits
- Broadcaster settings: feature on/off; max track length (e.g. 8 min); block explicit; blocklist and allowlist of
  artists/tracks; auto-accept vs. manual approval (with manual approval, validation happens at reserve time and
  queueing happens only after approval; if the broadcaster rejects, the viewer gets a credit).
- Limits: cooldown per viewer (e.g. 1 request / 10 min); max pending requests per channel (e.g. 10); no duplicates
  of a track already in `GET /me/player/queue` or requested in the last 60 min; global per-channel requests/minute.
- Moderators (`role=moderator` JWT) can remove requests from the EBS list. Spotify has **no API to remove a queued
  item**, so removal is only possible before fulfillment. This is one more reason to support manual approval.
- Search input is sanitized and length-limited, with a per-user search rate limit (protects the shared dev-mode quota).

## 5. Data model additions (TokenStore → a broader Store)
- `channel_settings(channelId, enabled, sku, maxDurationMs, blockExplicit, approvalMode, lists…)`
- `queue_requests(id, channelId, userId, trackId, sku, status, transactionId UNIQUE, createdAt, updatedAt, error)`
- `credits(userId, channelId, count)`
- `bits_transactions(transactionId PK, payload, source: receipt|eventsub|helix, seenAt)`

Durable jobs and idempotency keys point to SQLite or Postgres rather than the JSON file.

## 6. Seams that already exist in the current code
- `auth/jwt.js` `verifyHS256` verifies Bits receipts (same secret and alg); only a `verifyBitsReceipt` wrapper is needed.
- `auth/twitchAuth.js` role checks work for broadcaster-only settings and moderator actions; `opaqueUserId` and
  `userId` are already exposed.
- `spotify/client.js` has an `_api` helper returning `{status, body, retryAfterSec, reason}`. Adding `search`,
  `getTrack`, `getQueue`, `getPlayer`, and `addToQueue` (POST) is small; `_api` needs a method parameter.
- `spotify/tokenManager.js` refresh and revoke handling carries over unchanged. Scopes live in config and are stored
  per link (`link.scopes`), so the EBS can detect links missing `user-modify-playback-state` and prompt re-consent
  via the existing `/api/config/link/start`.
- `twitch/pubsub.js` `RateLimitedPublisher` accepts arbitrary message types (`queue_added`, `queue_failed`).
  The contract already requires the frontend to switch on `type` and ignore unknown types.
- `poller/poller.js` state (`playing`, device activity) can trigger retries of `pending_device` requests.
- `store/tokenStore.js` is the interface seam for moving to SQLite/Postgres.
- `http/util.js` `RateLimiter` handles per-user limits on search and reserve.
