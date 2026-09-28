import { createContainer } from '../src/container';

describe('Remote browser removal', () => {
  test('container exposes no remote browser service', () => {
    const container = createContainer({ dbPath: ':memory:' });
    expect('remoteBrowserService' in container).toBe(false);
  });
});
