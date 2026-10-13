import {
  buildThumbnailKey,
  buildVideoKey,
  calculatePartCount,
  extractExtension,
} from './storage.util';

describe('storage.util', () => {
  describe('extractExtension', () => {
    it('extracts a lowercase extension from the filename', () => {
      expect(extractExtension('holiday.MP4')).toBe('mp4');
      expect(extractExtension('clip.mov')).toBe('mov');
    });

    it('falls back to mp4 when there is no usable extension', () => {
      expect(extractExtension('noextension')).toBe('mp4');
      expect(extractExtension('trailing.')).toBe('mp4');
      expect(extractExtension('.hidden')).toBe('mp4');
    });

    it('falls back to mp4 when the extension is not a plain token', () => {
      expect(extractExtension('weird.a/b')).toBe('mp4');
      expect(extractExtension('long.extensionwaytoolong')).toBe('mp4');
    });
  });

  describe('key conventions', () => {
    it('places source and thumbnail under the same per-video prefix', () => {
      const id = '550e8400-e29b-41d4-a716-446655440000';
      expect(buildVideoKey(id, 'holiday.mp4')).toBe(`videos/${id}/source.mp4`);
      expect(buildThumbnailKey(id)).toBe(`videos/${id}/thumbnail.jpg`);
    });

    it('keeps the original extension in the source key', () => {
      const id = 'abc';
      expect(buildVideoKey(id, 'clip.webm')).toBe('videos/abc/source.webm');
    });
  });

  describe('calculatePartCount', () => {
    const partSize = 100 * 1024 * 1024; // 100 MiB

    it('returns at least one part for a file smaller than the part size', () => {
      expect(calculatePartCount(1, partSize)).toBe(1);
      expect(calculatePartCount(partSize - 1, partSize)).toBe(1);
    });

    it('returns an exact count when the size is a multiple of the part size', () => {
      expect(calculatePartCount(partSize * 3, partSize)).toBe(3);
    });

    it('rounds up a partial trailing part', () => {
      expect(calculatePartCount(partSize * 2 + 1, partSize)).toBe(3);
    });

    it('splits a 10 GiB file into the expected number of parts', () => {
      const tenGiB = 10 * 1024 * 1024 * 1024;
      expect(calculatePartCount(tenGiB, partSize)).toBe(103);
    });
  });
});
