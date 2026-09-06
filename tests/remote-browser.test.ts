import { RemoteBrowserService } from '../src/services/remote-browser.service';
import type { AppContainer } from '../src/container';

describe('RemoteBrowserService', () => {
  let service: RemoteBrowserService;
  let mockContainer: Partial<AppContainer>;

  beforeEach(() => {
    mockContainer = {
      notifierService: {
        notifyAdmins: jest.fn().mockResolvedValue(undefined),
      } as any,
    };
    service = new RemoteBrowserService(mockContainer as AppContainer);
  });

  test('creates a valid session token for an admin', () => {
    const adminId = 12345;
    const token = service.createSessionToken(adminId, 'facebook');

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);

    const verified = service.verifySessionToken(token);
    expect(verified).toBeDefined();
    expect(verified?.adminTelegramId).toBe(adminId);
    expect(verified?.service).toBe('facebook');
  });

  test('returns null for non-existent token', () => {
    expect(service.verifySessionToken('non-existent-token')).toBeNull();
  });

  test('consumes token so it cannot be reused', () => {
    const token = service.createSessionToken(999, 'khmer24');
    expect(service.verifySessionToken(token)).toBeDefined();

    service.consumeSessionToken(token);
    expect(service.verifySessionToken(token)).toBeNull();
  });

  test('expires token after TTL', () => {
    // Create an expired token with -1000ms TTL
    const expiredToken = service.createSessionToken(999, 'facebook', -1000);
    expect(service.verifySessionToken(expiredToken)).toBeNull();
  });
});

