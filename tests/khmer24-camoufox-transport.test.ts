import { readFileSync } from 'node:fs';
import { Khmer24CamoufoxTransport } from '../src/modules/parser/khmer24-camoufox-transport';
import { classifyKhmer24PageLiveness } from '../src/modules/parser/khmer24-http';

describe('Khmer24 Camoufox transport', () => {
  it('uses one guarded browser with optional session state and closes each page/context', async () => {
    const calls: string[] = [];
    const page = {
      goto: async () => { calls.push('goto'); return null; },
      content: async () => '<script type="application/ld+json">{"@type":"Product"}</script>',
      title: async () => 'Listing',
      url: () => 'https://www.khmer24.com/en/post-adid-1',
      close: async () => { calls.push('page.close'); },
    };
    const context = {
      newPage: async () => { calls.push('newPage'); return page; },
      close: async () => { calls.push('context.close'); },
    };
    const handle = {
      browser: { newContext: async (options?: { storageState?: string }) => { calls.push(`newContext:${options?.storageState ?? 'none'}`); return context; } },
      close: async () => { calls.push('browser.close'); },
    };
    const transport = await Khmer24CamoufoxTransport.open({
      cwd: () => '/repo',
      fileExists: () => true,
      launch: async () => { calls.push('launch'); return handle; },
      attachGuard: async () => { calls.push('guard'); },
    });

    await expect(transport.fetchPage('https://www.khmer24.com/en/post-adid-1')).resolves.toMatchObject({
      navigationStatus: null, finalUrl: 'https://www.khmer24.com/en/post-adid-1',
      markers: { listing: true, removedOrNotFound: false, challengeOrBlock: false, unexpected: false },
    });
    await transport.close();

    expect(calls).toEqual([
      'launch', 'newContext:/repo/data/k24_session.json', 'newPage', 'guard', 'goto',
      'page.close', 'context.close', 'browser.close',
    ]);
  });

  it('closes the page/context and reports a challenge as non-terminal', async () => {
    const calls: string[] = [];
    const page = {
      goto: async () => null,
      content: async () => '<html>Just a moment</html>',
      title: async () => 'Attention Required',
      url: () => 'https://www.khmer24.com/en/post-adid-1',
      close: async () => { calls.push('page.close'); },
    };
    const context = { newPage: async () => page, close: async () => { calls.push('context.close'); } };
    const transport = await Khmer24CamoufoxTransport.open({
      cwd: () => '/repo', fileExists: (file) => file.endsWith('k24_device.json'),
      launch: async () => ({ browser: { newContext: async () => context }, close: async () => {} }),
      attachGuard: async () => {},
    });

    await expect(transport.fetchPage('https://www.khmer24.com/en/post-adid-1')).resolves.toMatchObject({
      markers: { challengeOrBlock: true, listing: false, removedOrNotFound: false, unexpected: false },
    });
    expect(calls).toEqual(['page.close', 'context.close']);
  });

  it('keeps a sanitized terminal-page fixture classified as removed', () => {
    const html = readFileSync(require.resolve('./fixtures/khmer24-terminal-page.html'), 'utf8');
    expect(classifyKhmer24PageLiveness(html)).toBe('dead');
  });
});
