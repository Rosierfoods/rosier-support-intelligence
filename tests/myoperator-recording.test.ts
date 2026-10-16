import { describe, expect, it } from 'vitest';
import { myOperatorFileName } from '@/lib/pipeline/transcribe';

describe('myOperatorFileName', () => {
  it('reads filename refs', () => expect(myOperatorFileName('myoperator-file:abc_123.mp3')).toBe('abc_123.mp3'));
  it('takes the last path segment of a panel URL', () =>
    expect(myOperatorFileName('https://app.myoperator.com/recordings/x/6f1b2c_v2.mp3')).toBe('6f1b2c_v2.mp3'));
  it('reads a file query param', () => expect(myOperatorFileName('https://app.myoperator.com/audio?file=a.mp3')).toBe('a.mp3'));
  it('ignores direct S3 links and non-audio URLs', () => {
    expect(myOperatorFileName('https://developers-sounds-v2.s3.ap-south-1.amazonaws.com/c/a.mp3')).toBeNull();
    expect(myOperatorFileName('https://app.myoperator.com/calls/123')).toBeNull();
  });
});
