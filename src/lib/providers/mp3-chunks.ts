/**
 * Split an MP3 into pieces of at most `maxSeconds` at frame boundaries (no re-encoding, no ffmpeg).
 * MP3 is a stream of independent frames, so each piece is itself a valid MP3. Returns null if the data is not MP3.
 */
const BITRATES: Record<string, number[]> = {
  'v1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  'v2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Frame { len: number; seconds: number }
function frameAt(b: Buffer, i: number): Frame | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3;           // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b[i + 1] >> 1) & 3;         // 1 = Layer III
  if (ver === 1 || layer !== 1) return null;
  const kbps = BITRATES[ver === 3 ? 'v1' : 'v2'][(b[i + 2] >> 4) & 15];
  const rate = RATES[ver]?.[(b[i + 2] >> 2) & 3];
  if (!kbps || !rate) return null;
  const pad = (b[i + 2] >> 1) & 1;
  const samples = ver === 3 ? 1152 : 576;
  const len = Math.floor((samples / 8) * kbps * 1000 / rate) + pad;
  return len > 4 ? { len, seconds: samples / rate } : null;
}

function skipId3(b: Buffer): number {
  if (b.length > 10 && b.slice(0, 3).toString('ascii') === 'ID3') {
    return 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
  }
  return 0;
}

export function splitMp3(b: Buffer, maxSeconds = 25): { data: Buffer; offsetMs: number; seconds: number }[] | null {
  let i = skipId3(b);
  // find the first real frame (two consecutive valid headers)
  while (i < b.length - 4) {
    const f = frameAt(b, i);
    if (f && frameAt(b, i + f.len)) break;
    i++;
  }
  if (i >= b.length - 4) return null;
  // drop a leading Xing/Info/VBRI header frame: it states the WHOLE file's length, which would make piece 1 look too long
  const first = frameAt(b, i)!;
  if (/Xing|Info|VBRI/.test(b.subarray(i, i + first.len).toString('latin1'))) i += first.len;
  const pieces: { data: Buffer; offsetMs: number; seconds: number }[] = [];
  let start = i, secs = 0, total = 0;
  while (i < b.length) {
    const f = frameAt(b, i);
    if (!f) { i++; continue; }               // resync over junk
    if (secs + f.seconds > maxSeconds && i > start) {
      pieces.push({ data: b.subarray(start, i), offsetMs: Math.round(total * 1000), seconds: secs });
      total += secs; start = i; secs = 0;
    }
    secs += f.seconds;
    i += f.len;
  }
  if (i > start && secs > 0) pieces.push({ data: b.subarray(start, Math.min(i, b.length)), offsetMs: Math.round(total * 1000), seconds: secs });
  return pieces.length ? pieces : null;
}
