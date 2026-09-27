/**
 * Local progress interpolation between EBS updates. Pure functions (unit-tested).
 *
 * Anchor = "at local time anchorAt the position was positionMs".
 * API_CONTRACT §4: progressMs is the position at sampledAt (EBS clock).
 *  - v1.2, serverTime present (EBS clock when the payload was sent), receivedAt = local Date.now() on receipt:
 *      pos = progressMs + (serverTime - sampledAt) + (Date.now() - receivedAt)      — no client-clock trust needed
 *  - serverTime missing (older EBS): pos = progressMs + (Date.now() - sampledAt), with that age clamped to
 *      [0, maxSampleAgeMs] (2 min) to survive skewed viewer clocks.
 * delayMs (viewer stream latency) is subtracted so the position matches what the viewer currently hears.
 * Everything is clamped to [0, durationMs].
 */
export function makeAnchor(np, { now, receivedAt = now, maxSampleAgeMs = 120_000, delayMs = 0 } = {}) {
  const duration = np.item && np.item.durationMs != null ? np.item.durationMs : null;
  let age = 0;
  if (np.isPlaying && np.sampledAt != null) {
    if (np.serverTime != null) {
      age = Math.max(np.serverTime - np.sampledAt, 0) + Math.max(now - receivedAt, 0);
    } else {
      age = Math.min(Math.max(now - np.sampledAt, 0), maxSampleAgeMs);
    }
  }
  let pos = (np.progressMs || 0) + (np.isPlaying ? age - delayMs : 0);
  pos = clamp(pos, 0, duration);
  return { positionMs: pos, anchorAt: now, durationMs: duration, isPlaying: !!np.isPlaying };
}

export function positionAt(anchor, now) {
  if (!anchor) return 0;
  const p = anchor.isPlaying ? anchor.positionMs + (now - anchor.anchorAt) : anchor.positionMs;
  return clamp(p, 0, anchor.durationMs);
}

/** Milliseconds past the end of the track (>0 means the EBS should have sent a new track by now). */
export function overrunMs(anchor, now) {
  if (!anchor || !anchor.isPlaying || anchor.durationMs == null) return 0;
  return anchor.positionMs + (now - anchor.anchorAt) - anchor.durationMs;
}

export function fraction(anchor, now) {
  if (!anchor || !anchor.durationMs) return 0;
  return positionAt(anchor, now) / anchor.durationMs;
}

export function formatTime(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function clamp(v, lo, hi) {
  let x = Math.max(v, lo);
  if (hi != null) x = Math.min(x, hi);
  return x;
}
