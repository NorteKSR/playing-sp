// Decide whether a new NowPlaying sample differs meaningfully from the previous one.

/** Stable identity of an item (local files have id=null, so fall back to name). */
const itemKey = (s) => (s.item ? `${s.item.kind}:${s.item.id ?? `local:${s.item.name}|${s.item.artists.join(',')}`}` : null);

/**
 * @returns {null | 'initial'|'state'|'item'|'seek'}  reason for change, or null if unchanged
 */
export function detectChange(prev, next, { seekThresholdMs = 10_000 } = {}) {
  if (!prev) return 'initial';
  if (prev.state !== next.state) return 'state';
  if (itemKey(prev) !== itemKey(next)) return 'item';
  if (next.state === 'playing' && prev.progressMs != null && next.progressMs != null) {
    const expected = prev.progressMs + (next.sampledAt - prev.sampledAt);
    if (Math.abs(next.progressMs - expected) > seekThresholdMs) return 'seek';
  }
  if (next.state === 'paused' && prev.progressMs != null && next.progressMs != null) {
    if (Math.abs(next.progressMs - prev.progressMs) > seekThresholdMs) return 'seek';
  }
  return null;
}
