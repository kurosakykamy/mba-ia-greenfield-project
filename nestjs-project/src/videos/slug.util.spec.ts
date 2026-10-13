import { generateVideoSlug } from './slug.util';
import { VIDEO_SLUG_LENGTH } from './videos.constants';

describe('generateVideoSlug', () => {
  it('generates a slug of the configured length', () => {
    expect(generateVideoSlug()).toHaveLength(VIDEO_SLUG_LENGTH);
  });

  it('generates URL-safe slugs without ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      // Sem 0/O/1/l/I: o slug aparece em links compartilhados e pode ser
      // transcrito à mão.
      expect(generateVideoSlug()).toMatch(/^[2-9a-km-zA-HJ-NP-Z]+$/);
    }
  });

  it('does not repeat across many generations', () => {
    const count = 5000;
    const slugs = new Set<string>();
    for (let i = 0; i < count; i++) slugs.add(generateVideoSlug());
    expect(slugs.size).toBe(count);
  });
});
