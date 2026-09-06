import { parseProxyConfig } from '../src/modules/parser/proxy';

describe('Proxy Configuration & Masking (parseProxyConfig)', () => {
  test('parses HTTP proxy with credentials and separates auth for Playwright', () => {
    const raw = 'http://residential_user:secret_pass_123@185.123.45.67:8080';
    const result = parseProxyConfig(raw);

    expect(result).toBeDefined();
    expect(result!.config.server).toBe('http://185.123.45.67:8080');
    expect(result!.config.username).toBe('residential_user');
    expect(result!.config.password).toBe('secret_pass_123');
    expect(result!.masked).toBe('http://***:***@185.123.45.67:8080');
    expect(result!.masked).not.toContain('secret_pass_123');
  });

  test('parses HTTP proxy without credentials', () => {
    const raw = 'http://185.123.45.67:8080';
    const result = parseProxyConfig(raw);

    expect(result).toBeDefined();
    expect(result!.config.server).toBe('http://185.123.45.67:8080');
    expect(result!.config.username).toBeUndefined();
    expect(result!.config.password).toBeUndefined();
    expect(result!.masked).toBe('http://185.123.45.67:8080');
  });

  test('parses SOCKS5 proxy with credentials', () => {
    const raw = 'socks5://proxyuser:proxypass@127.0.0.1:1080';
    const result = parseProxyConfig(raw);

    expect(result).toBeDefined();
    expect(result!.config.server).toBe('socks5://127.0.0.1:1080');
    expect(result!.config.username).toBe('proxyuser');
    expect(result!.config.password).toBe('proxypass');
    expect(result!.masked).toBe('socks5://***:***@127.0.0.1:1080');
  });

  test('handles proxy string without protocol by prepending http://', () => {
    const raw = 'admin:pwd456@10.0.0.1:9090';
    const result = parseProxyConfig(raw);

    expect(result).toBeDefined();
    expect(result!.config.server).toBe('http://10.0.0.1:9090');
    expect(result!.config.username).toBe('admin');
    expect(result!.config.password).toBe('pwd456');
    expect(result!.masked).toBe('http://***:***@10.0.0.1:9090');
  });

  test('returns undefined for empty or undefined input', () => {
    expect(parseProxyConfig(undefined)).toBeUndefined();
    expect(parseProxyConfig('')).toBeUndefined();
    expect(parseProxyConfig('   ')).toBeUndefined();
  });

  test('handles malformed proxy input gracefully without crashing', () => {
    expect(parseProxyConfig('http://')).toBeUndefined();
  });

  test('sanitizes common protocol typos such as hhttp://', () => {
    const raw = 'hhttp://user:pass@1.2.3.4:5678';
    const result = parseProxyConfig(raw);
    expect(result).toBeDefined();
    expect(result!.config.server).toBe('http://1.2.3.4:5678');
    expect(result!.config.username).toBe('user');
    expect(result!.config.password).toBe('pass');
  });
});

