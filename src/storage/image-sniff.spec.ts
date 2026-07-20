import { isAvatarImageType, sniffImageType } from './image-sniff';

/** Minimal byte-accurate headers, padded so the WEBP 12-byte read is always in range. */
const jpeg = (): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const png = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
const webp = (): Buffer =>
  Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]), // size field — arbitrary
    Buffer.from('WEBP', 'ascii'),
    Buffer.alloc(16),
  ]);

describe('image-sniff (AC-B13 — the magic-byte control)', () => {
  it.each([
    ['JPEG', jpeg(), 'image/jpeg'],
    ['PNG', png(), 'image/png'],
    ['WEBP', webp(), 'image/webp'],
  ])('identifies a real %s by its bytes', (_label, buffer, expected) => {
    expect(sniffImageType(buffer)).toBe(expected);
  });

  it('rejects an EXE — the exact payload a renamed .png / declared image/png would smuggle', () => {
    // "MZ" DOS header.
    const exe = Buffer.concat([
      Buffer.from('MZ', 'ascii'),
      Buffer.alloc(32, 0x90),
    ]);
    expect(sniffImageType(exe)).toBeNull();
  });

  it.each([
    [
      'a GIF (real image, but not allowed here)',
      Buffer.from('GIF89a-------------'),
    ],
    [
      'an SVG (XML — scriptable, never an allowed avatar)',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'),
    ],
    ['a PDF', Buffer.from('%PDF-1.7\n-----------')],
    ['a ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['plain text', Buffer.from('this is definitely not an image at all')],
    ['an empty buffer', Buffer.alloc(0)],
  ])('rejects %s', (_label, buffer) => {
    expect(sniffImageType(buffer)).toBeNull();
  });

  it('rejects a truncated header rather than reading out of bounds', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull(); // 2 of JPEG's 3 bytes
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
    expect(sniffImageType(Buffer.from('RIFF', 'ascii'))).toBeNull(); // RIFF but no room for WEBP
  });

  it('rejects RIFF that is not WEBP (e.g. a WAV) — the container is not the format', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
      Buffer.alloc(8),
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });

  describe('isAvatarImageType (the DECLARED-MIME first filter)', () => {
    it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s', (t) => {
      expect(isAvatarImageType(t)).toBe(true);
    });

    it.each([
      'image/gif',
      'image/svg+xml',
      'application/octet-stream',
      'text/html',
      'IMAGE/PNG', // case-sensitive on purpose — multer lowercases; a variant is not a known good
      '',
    ])('rejects %s', (t) => {
      expect(isAvatarImageType(t)).toBe(false);
    });
  });
});
