/**
 * Proxy configuration parser for Playwright browser contexts and Chromium launch.
 */

export interface PlaywrightProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface ParsedProxyResult {
  config: PlaywrightProxyConfig;
  masked: string;
}

/**
 * Parses a raw proxy string (e.g. "http://user:pass@1.2.3.4:5678" or "socks5://127.0.0.1:1080")
 * into Playwright's `proxy` launch option format: `{ server, username, password }`.
 * Also provides a safe masked representation (e.g. "http://***:***@1.2.3.4:5678") for logging.
 */
export function parseProxyConfig(rawProxy?: string): ParsedProxyResult | undefined {
  if (!rawProxy || !rawProxy.trim()) {
    return undefined;
  }

  const trimmed = rawProxy.trim();

  try {
    const urlStr = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
    const parsed = new URL(urlStr);

    const server = `${parsed.protocol}//${parsed.host}`;
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;

    const config: PlaywrightProxyConfig = { server };
    if (username) config.username = username;
    if (password) config.password = password;

    const authMask = username || password ? '***:***@' : '';
    const masked = `${parsed.protocol}//${authMask}${parsed.host}`;

    return { config, masked };
  } catch (err: unknown) {
    console.warn(
      `⚠️ [Proxy] Failed to parse proxy URL "${rawProxy}":`,
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}
