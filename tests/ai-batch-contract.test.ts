import { validateCompleteBatchItems } from '../src/modules/ai/batch-contract';

describe('validateCompleteBatchItems', () => {
  const ids = ['first', 'second'];

  test('accepts a complete batch in a different order', () => {
    expect(validateCompleteBatchItems({ items: [{ id: 'second' }, { id: 'first' }] }, ids)).toBe(true);
  });

  test.each([
    ['missing item', { items: [{ id: 'first' }] }],
    ['duplicate item', { items: [{ id: 'first' }, { id: 'first' }] }],
    ['unknown item', { items: [{ id: 'first' }, { id: 'third' }] }],
    ['invalid id', { items: [{ id: 'first' }, { id: 2 }] }],
    ['wrong envelope', [{ id: 'first' }, { id: 'second' }]],
  ])('rejects %s', (_label, payload) => {
    expect(validateCompleteBatchItems(payload, ids)).not.toBe(true);
  });
});
