/** Analytics loads alongside the UI, never on the critical rendering path. */
type PostHogClient = typeof import('posthog-js')['default'];

let clientPromise: Promise<PostHogClient | null> | undefined;

function getClient(): Promise<PostHogClient | null> {
  const key = import.meta.env.VITE_POSTHOG_API_KEY;
  if (!key) return Promise.resolve(null);

  clientPromise ??= import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com',
        autocapture: false,
        capture_pageview: true,
      });
      return posthog;
    })
    .catch((error: unknown) => {
      console.warn('[PostHog] Init error:', error);
      return null;
    });

  return clientPromise;
}

export function initializeAnalytics(): void {
  void getClient();
}

export function identifyTelegramUser(user: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}): void {
  void getClient().then((posthog) => {
    try {
      posthog?.identify(String(user.id), {
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        language_code: user.language_code,
      });
    } catch (error) {
      console.warn('[PostHog] Error identifying user:', error);
    }
  });
}

export function captureEvent(event: string, properties: Record<string, unknown>): void {
  void getClient().then((posthog) => {
    try {
      posthog?.capture(event, properties);
    } catch (error) {
      console.warn('[PostHog] Error capturing event:', error);
    }
  });
}
