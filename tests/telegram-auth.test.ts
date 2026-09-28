import { createContainer } from '../src/container';

describe('Telegram authentication removal', () => {
  test('container exposes no Telegram credential service', () => {
    const container = createContainer({ dbPath: ':memory:' });
    expect('telegramAuthService' in container).toBe(false);
  });
});
