import { expect, test } from 'bun:test';
import { posterUrl } from '../apps/web/src/views/components.jsx';

test('posterUrl swaps purged TVmaze originals for the medium poster', () => {
  expect(
    posterUrl('https://static.tvmaze.com/uploads/images/original_untouched/115/288699.jpg'),
  ).toBe('https://static.tvmaze.com/uploads/images/medium_portrait/115/288699.jpg');
  expect(posterUrl('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  expect(posterUrl(null)).toBe(null);
});
