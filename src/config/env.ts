import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),

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

  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  DATABASE_PATH: z.string().default('./data/homeasy.db'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:');
  console.error(JSON.stringify(result.error.format(), null, 2));
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
