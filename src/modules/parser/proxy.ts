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
    // Sanitize common typos like 'hhttp://' and prepend default http:// if protocol is omitted
    let urlStr = trimmed.replace(/^h+ttp:\/\//i, 'http://');
    if (!urlStr.includes('://')) {
      urlStr = `http://${urlStr}`;
    }
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

export class ProxyConnectionError extends Error {
  constructor(message = 'Proxy connection or tunnel failed') {
    super(message);
    this.name = 'ProxyConnectionError';
  }
}

/**
 * Checks if an error corresponds to proxy failure, tunnel breakdown, or proxy auth rejection.
 */
export function isProxyError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof ProxyConnectionError) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('err_proxy_connection_failed') ||
    msg.includes('err_tunnel_connection_failed') ||
    msg.includes('err_proxy_auth_failed') ||
    msg.includes('err_proxy_auth_requested') ||
    msg.includes('err_proxy_certificate_invalid') ||
    msg.includes('err_socks_connection_failed') ||
    msg.includes('err_socks_connection_host_unreachable') ||
    msg.includes('err_mandatory_proxy_configuration_failed') ||
    msg.includes('proxy tunnel failed') ||
    msg.includes('proxy connection failed')
  );
}

