import { getPhoneActionLink, getTelegramContactLink } from '../src/modules/api/contact-links';

describe('contact action links', () => {
  it('prefers an explicit Telegram username and canonicalizes its URL', () => {
    expect(getTelegramContactLink('@agent_sr', '012345678')).toBe('https://t.me/agent_sr');
    expect(getTelegramContactLink('http://telegram.me/agent_sr', null)).toBe('https://t.me/agent_sr');
  });

  it('resolves Cambodian national numbers of both lengths through Telegram', () => {
    expect(getTelegramContactLink(null, '012345678')).toBe('https://t.me/+85512345678');
    expect(getTelegramContactLink(null, '0969343456')).toBe('https://t.me/+855969343456');
  });

  it('preserves Cambodian and foreign international numbers', () => {
    expect(getTelegramContactLink('+855 12 345 678', null)).toBe('https://t.me/+85512345678');
    expect(getTelegramContactLink(null, '+66 81 234 5678')).toBe('https://t.me/+66812345678');
  });

  it('creates standard E.164 call links without forcing a number onto one length', () => {
    expect(getPhoneActionLink('012345678')).toBe('tel:+85512345678');
    expect(getPhoneActionLink('096 934 3456')).toBe('tel:+855969343456');
    expect(getPhoneActionLink('+66 81 234 5678')).toBe('tel:+66812345678');
    expect(getPhoneActionLink('not a phone number')).toBeNull();
  });
});
