import fs from 'node:fs';
import {
  FB_RUNTIME_LOCK_PATH,
  FB_SAFETY_STATE_PATH,
  acquireFacebookRuntimeLock,
  blockFacebookAutomation,
  classifyFacebookChallengeUrl,
  loadFacebookSafetyState,
  markFacebookReady,
} from '../src/modules/parser/fb-runtime';

describe('Facebook runtime safety', () => {
  afterEach(() => {
    for (const file of [FB_RUNTIME_LOCK_PATH, FB_SAFETY_STATE_PATH]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  test.each([
    'https://www.facebook.com/login',
    'https://www.facebook.com/checkpoint/123',
    'https://www.facebook.com/auth_platform/',
    'https://www.facebook.com/two_step_verification/',
  ])('classifies challenge URL %s', (url) => {
    expect(classifyFacebookChallengeUrl(url)).not.toBeNull();
  });

  test('does not classify a group URL as a challenge', () => {
    expect(classifyFacebookChallengeUrl('https://www.facebook.com/groups/123')).toBeNull();
  });

  test('persists blocked and ready safety states', () => {
    blockFacebookAutomation({ reason: 'checkpoint', detectedUrl: 'https://www.facebook.com/checkpoint/' });
    expect(loadFacebookSafetyState()).toMatchObject({ status: 'blocked', reason: 'checkpoint' });

    markFacebookReady('123');
    expect(loadFacebookSafetyState()).toEqual({ status: 'ready', accountId: '123' });
  });

  test('fails closed for corrupt safety state', () => {
    fs.mkdirSync(require('node:path').dirname(FB_SAFETY_STATE_PATH), { recursive: true });
    fs.writeFileSync(FB_SAFETY_STATE_PATH, '{invalid', 'utf8');
    expect(loadFacebookSafetyState()).toMatchObject({ status: 'blocked' });
  });

  test('prevents concurrent Facebook operations', () => {
    const release = acquireFacebookRuntimeLock('scrape');
    expect(() => acquireFacebookRuntimeLock('login')).toThrow(/already locked/);
    release();
    expect(fs.existsSync(FB_RUNTIME_LOCK_PATH)).toBe(false);
  });
});
