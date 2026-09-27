/**
 * EXTENSION POINT — Bits in Extensions (NOT IMPLEMENTED in v1).
 *
 * The panel has an empty, hidden layout slot: <section id="bits-slot" hidden>. A future feature can
 * render into it from here. Wiring is already in viewer.js: initBits() is called once after
 * onAuthorized with { slot, ext, auth, nowPlaying }.
 *
 * ⚠️ POLICY WARNING (verified 2026-09-26, https://dev.twitch.tv/docs/extensions/guidelines-and-policies/):
 *   6.2.2 "Bits may not be used within your Extension ... To allow an end user to use Bits to play a
 *   specific musical track or audio-visual work (e.g., jukebox-like functionality)."
 *   A literal "request a song for Bits" feature would fail review. Get product/legal sign-off on a
 *   compliant design (e.g. a non-music reward) before building anything here. See README.md.
 *
 * Sketch of a future implementation (do not enable without the review above):
 *   const ext = window.Twitch.ext;
 *   if (!ext.features.isBitsEnabled) return;            // also listen to ext.features.onChanged
 *   const products = await ext.bits.getProducts();       // SKUs configured in the dev console
 *   button.onclick = () => ext.bits.useBits(sku);
 *   ext.bits.onTransactionComplete(tx => POST tx.transactionReceipt to the EBS for verification);
 *   ext.bits.onTransactionCancelled(() => ...);
 */
export function initBits(/* { slot, ext, auth, getNowPlaying } */) {
  // Intentionally a no-op in v1. Keep the slot hidden.
}
