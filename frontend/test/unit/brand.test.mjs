import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SPOTIFY_LOGO_SHA256 } from '../../scripts/package.mjs';

test('bundled Spotify logos are byte-identical to the official assets', async () => {
  for (const [f, sum] of Object.entries(SPOTIFY_LOGO_SHA256)) {
    const buf = await readFile(new URL('../../src/' + f, import.meta.url));
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), sum, f);
    assert.ok(!/<script/i.test(buf.toString()), 'no script in SVG');
  }
});
