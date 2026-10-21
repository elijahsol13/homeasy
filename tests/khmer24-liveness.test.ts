import { classifyKhmer24DetailLiveness } from '../src/modules/parser/khmer24-liveness';

const product = (id: string) => `<script type="application/ld+json">${JSON.stringify({
  '@type': 'Product', sku: id, name: 'House for rent', offers: { availability: 'https://schema.org/InStock' },
})}</script>`;

it('recognizes Khmer24 HTTP-200 sold-out/deleted document even with generic Nuxt shell', () => {
  const removed = '<html><p>The product you are looking for is sold out (or deleted).</p>' +
    '<script id="__NUXT_DATA__" type="application/json">[null]</script></html>';
  expect(classifyKhmer24DetailLiveness(removed, '13856614')).toBe('dead');
});

it('requires an actual matching Product or active Nuxt detail post before saying alive', () => {
  expect(classifyKhmer24DetailLiveness(`<html>${product('123')}</html>`, '123')).toBe('alive');
  expect(classifyKhmer24DetailLiveness(`<html>${product('456')}</html>`, '123')).toBe('unknown');
  expect(classifyKhmer24DetailLiveness('<script type="application/ld+json">{"@type":"Product","name":"Generic recommendation"}</script>', '123')).toBe('unknown');
  const nuxtPost = [{ id: 13600381, posted_date: 1, renew_date: 2, status: 3, available: 4 },
    '2026-06-03 09:19:42', '2026-10-10 09:58:30', 'active', true];
  const nuxt = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(nuxtPost)}</script>`;
  expect(classifyKhmer24DetailLiveness(nuxt, '13600381')).toBe('alive');
  expect(classifyKhmer24DetailLiveness(nuxt, '999')).toBe('unknown');
});

it('keeps ambiguous 200s, missing post data and challenges inconclusive', () => {
  for (const html of [
    '<html><title>Rental listing</title></html>',
    '<script id="__NUXT_DATA__" type="application/json">[null]</script>',
    'Just a moment...',
    '<script id="__NUXT_DATA__" type="application/json">broken</script>',
    '',
  ]) expect(classifyKhmer24DetailLiveness(html, '123')).toBe('unknown');
});
