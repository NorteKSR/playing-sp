import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAnchor, positionAt, overrunMs, fraction, formatTime } from '../../src/js/progress.js';

const np = (o = {}) => ({ item: { durationMs: 200000 }, progressMs: 10000, isPlaying: true, sampledAt: 1000, ...o });

test('adds sample age while playing', () => {
  const a = makeAnchor(np(), { now: 4000 });
  assert.equal(a.positionMs, 13000);
  assert.equal(positionAt(a, 6000), 15000);
});

test('clamps sample age for clock skew', () => {
  assert.equal(makeAnchor(np(), { now: 1000 + 10 * 60_000, maxSampleAgeMs: 120_000 }).positionMs, 130000);
  assert.equal(makeAnchor(np(), { now: 0 }).positionMs, 10000); // client clock behind → age 0
});

test('paused does not advance', () => {
  const a = makeAnchor(np({ isPlaying: false }), { now: 50000 });
  assert.equal(a.positionMs, 10000);
  assert.equal(positionAt(a, 999999), 10000);
  assert.equal(overrunMs(a, 999999), 0);
});

test('stream delay subtracts, clamped at 0 and duration', () => {
  assert.equal(makeAnchor(np(), { now: 1000, delayMs: 4000 }).positionMs, 6000);
  assert.equal(makeAnchor(np({ progressMs: 1000 }), { now: 1000, delayMs: 4000 }).positionMs, 0);
  const a = makeAnchor(np({ progressMs: 199000 }), { now: 1000 });
  assert.equal(positionAt(a, 100000), 200000);
  assert.ok(overrunMs(a, 100000) > 0);
  assert.equal(fraction(a, 100000), 1);
});

test('unknown duration', () => {
  const a = makeAnchor(np({ item: { durationMs: null } }), { now: 1000 });
  assert.equal(fraction(a, 5000), 0);
  assert.equal(overrunMs(a, 5000), 0);
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(61_999), '1:01');
  assert.equal(formatTime(3_723_000), '1:02:03');
  assert.equal(formatTime(NaN), '0:00');
});

test('v1.2 serverTime present: progressMs + (serverTime - sampledAt) + (Date.now() - receivedAt), ignoring client clock', () => {
  // EBS clock is 1_000_000 ms ahead of the viewer clock: without serverTime this would hit the 2-min cap.
  const payload = np({ progressMs: 10_000, sampledAt: 2_000_000, serverTime: 2_000_350 });
  const a = makeAnchor(payload, { now: 1_000_500, receivedAt: 1_000_000 });
  assert.equal(a.positionMs, 10_000 + 350 + 500);
  assert.equal(positionAt(a, 1_002_500), 10_000 + 350 + 500 + 2000);
});

test('v1.2 serverTime: negative components clamp to 0, stream delay subtracted, clamped to duration', () => {
  assert.equal(makeAnchor(np({ progressMs: 10_000, sampledAt: 5000, serverTime: 4000 }), { now: 100, receivedAt: 200 }).positionMs, 10_000);
  assert.equal(makeAnchor(np({ progressMs: 10_000, sampledAt: 0, serverTime: 1000 }), { now: 3000, receivedAt: 1000, delayMs: 4000 }).positionMs, 9000);
  assert.equal(makeAnchor(np({ progressMs: 199_000, sampledAt: 0, serverTime: 5000 }), { now: 0 }).positionMs, 200_000);
});

test('v1.2 serverTime ignored while paused', () => {
  assert.equal(makeAnchor(np({ isPlaying: false, sampledAt: 0, serverTime: 9000 }), { now: 20_000, receivedAt: 0 }).positionMs, 10_000);
});

test('serverTime missing: falls back to Date.now() - sampledAt with 2-minute skew cap (receivedAt irrelevant)', () => {
  const p = np({ progressMs: 10_000, sampledAt: 1000 });
  assert.equal(makeAnchor(p, { now: 4000, receivedAt: 3999 }).positionMs, 13_000);
  assert.equal(makeAnchor(p, { now: 1000 + 60 * 60_000, receivedAt: 0, maxSampleAgeMs: 120_000 }).positionMs, 130_000);
});
