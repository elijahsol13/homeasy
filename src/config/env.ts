import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  // Telegram is optional for offline ingestion and read-only audit tools. The
  // bot entrypoints call requireBotToken() before creating a Telegram client.
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN must not be empty').optional(),

  /**
   * Comma-separated list of Telegram user IDs that receive admin privileges.
   * Example: "123456789,987654321"
   */
  ADMIN_IDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .map(Number),
    ),

  GEMINI_API_KEY: z.string().optional(),
  DATABASE_PATH: z.string().default('./data/homeasy.db'),
  SHADOW_INGESTION: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  LISTING_READ_PATH: z.enum(['legacy', 'canonical']).default('legacy'),
  LISTING_READ_SHADOW: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  /** Comma-separated Telegram IDs served canonical reads while global path remains legacy. */
  CANONICAL_READ_CANARY_TELEGRAM_IDS: z.string().default('').transform((value) =>
    value.split(',').map((id) => id.trim()).filter(Boolean),
  ).pipe(z.array(z.coerce.number().int().positive().safe())),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  API_PORT: z.coerce.number().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().optional(),
  /** Public base URL used when minting /r/<slug> tracking links. Falls back to API_PUBLIC_URL. */
  TRACKING_PUBLIC_URL: z.string().optional(),
  WEBAPP_URL: z.string().optional(),
  /** Full Telegram deep-link base, e.g. "https://t.me/<bot>/<app>". Used by the /r/ tracking gateway. */
  TELEGRAM_MINIAPP_URL: z.string().optional(),
  /** Bot username without @, used as a fallback deep-link base if TELEGRAM_MINIAPP_URL is not set. */
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  FB_PROXY: z.string().optional(),
  FB_PROXY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().default('https://eu.i.posthog.com'),
  BRIGHTDATA_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  CLOUDFLARE_API_KEY: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_ACC_ID: z.string().optional(),
  /**
   * Telegram update delivery mode. 'polling' is the default and recommended for
   * home/mini-PC deployments because it depends only on outbound connectivity.
   * 'webhook' lets the API receive updates at TELEGRAM_WEBHOOK_URL.
   */
  BOT_DELIVERY_MODE: z.enum(['polling', 'webhook']).default('polling'),
  TELEGRAM_WEBHOOK_URL: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  SCRAPER_CYCLE_PAUSE_MINUTES: z.coerce.number().default(110),
  FB_GROUPS_PER_CYCLE: z.coerce.number().default(5),
  FB_EARLY_EXIT_THRESHOLD: z.coerce.number().default(3),
  FB_MAX_SCROLLS_PER_GROUP: z.coerce.number().default(1),
});

const DiscoveryEnvSchema = EnvSchema.pick({
  DATABASE_PATH: true,
  SHADOW_INGESTION: true,
});

function parseEnvironment(): z.infer<typeof EnvSchema> {
  if (process.env.HOMEASY_CONFIG_PROFILE === 'discovery') {
    const defaults = EnvSchema.parse({});
    const discovery = DiscoveryEnvSchema.safeParse(process.env);
    if (!discovery.success) {
      throw new Error(`Invalid discovery environment: ${JSON.stringify(discovery.error.format())}`);
    }
    return { ...defaults, ...discovery.data };
  }
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
  }
  if (!result.data.BOT_TOKEN) {
    console.error('❌ Invalid environment variables:');
    console.error(JSON.stringify({ BOT_TOKEN: { _errors: ['BOT_TOKEN is required'] } }, null, 2));
    process.exit(1);
  }
  return result.data;
}

export const env = parseEnvironment();
export type Env = typeof env;

export function requireBotToken(): string {
  const token = env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is required for Telegram bot operations');
  return token;
}
