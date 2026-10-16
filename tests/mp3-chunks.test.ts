import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitMp3 } from '@/lib/providers/mp3-chunks';

describe('splitMp3', () => {
  const mp3 = readFileSync('tests/fixtures/tone-70s.mp3');
  it('splits a 70 s call into ≤25 s pieces that add up to the whole', () => {
    const p = splitMp3(mp3, 25)!;
    expect(p.length).toBe(3);
    for (const x of p) expect(x.seconds).toBeLessThanOrEqual(25);
    expect(p.reduce((a, x) => a + x.seconds, 0)).toBeGreaterThan(69);
    expect(p[1].offsetMs).toBeGreaterThan(24_000);
  });
  it('returns null for non-MP3 data', () => expect(splitMp3(Buffer.from('RIFF....WAVEfmt '.repeat(100)))).toBeNull());
});
