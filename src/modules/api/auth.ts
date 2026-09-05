import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface ValidatedInitData {
  user: TelegramUser;
  auth_date: number;
  query_id?: string;
  chat_type?: string;
  chat_instance?: string;
  start_param?: string;
}

/**
 * Validates Telegram WebApp initData string according to official Telegram specs:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateTelegramInitData(
  initDataRaw: string,
  botToken: string = env.BOT_TOKEN,
  maxAgeSeconds = 86400, // 24 hours
): { isValid: boolean; data?: ValidatedInitData; error?: string } {
  if (!initDataRaw || typeof initDataRaw !== 'string') {
    return { isValid: false, error: 'Empty initData provided' };
  }

  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');

    if (!hash) {
      return { isValid: false, error: 'Missing hash parameter' };
    }

    params.delete('hash');

    // Sort parameters alphabetically
    const keys = Array.from(params.keys()).sort();
    const dataCheckArr: string[] = [];

    for (const key of keys) {
      const val = params.get(key);
      if (val !== null) {
        dataCheckArr.push(`${key}=${val}`);
      }
    }

    const dataCheckString = dataCheckArr.join('\n');

    // secret_key = HMAC-SHA-256("WebAppData", bot_token)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // calculated_hash = HMAC-SHA-256(secret_key, data_check_string)
    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const calculatedBuffer = Buffer.from(calculatedHash, 'hex');
    const hashBuffer = Buffer.from(hash, 'hex');

    if (calculatedBuffer.length !== hashBuffer.length || !crypto.timingSafeEqual(calculatedBuffer, hashBuffer)) {
      return { isValid: false, error: 'Invalid HMAC signature' };
    }

    // Check expiration if maxAgeSeconds is set
    const authDateStr = params.get('auth_date');
    const authDate = authDateStr ? parseInt(authDateStr, 10) : 0;
    if (maxAgeSeconds > 0 && authDate > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (now - authDate > maxAgeSeconds) {
        return { isValid: false, error: 'initData has expired' };
      }
    }

    // Parse user object
    const userStr = params.get('user');
    if (!userStr) {
      return { isValid: false, error: 'Missing user object in initData' };
    }

    const user = JSON.parse(userStr) as TelegramUser;
    if (!user.id || typeof user.id !== 'number') {
      return { isValid: false, error: 'Invalid user ID in initData' };
    }

    return {
      isValid: true,
      data: {
        user,
        auth_date: authDate,
        query_id: params.get('query_id') ?? undefined,
        chat_type: params.get('chat_type') ?? undefined,
        chat_instance: params.get('chat_instance') ?? undefined,
        start_param: params.get('start_param') ?? undefined,
      },
    };
  } catch (err) {
    return {
      isValid: false,
      error: `Validation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    telegramUser?: TelegramUser;
  }
}

/**
 * Fastify preHandler hook to authenticate Telegram WebApp requests.
 * Accepts:
 *   Authorization: tma <initData>
 *   Authorization: Bearer <initData>
 *   X-Telegram-Init-Data: <initData>
 *
 * In non-production environments, accepts:
 *   X-Dev-Telegram-Id: 123456789
 */
export async function requireTelegramAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Development / Test bypass
  if (env.NODE_ENV !== 'production') {
    const devUserId = request.headers['x-dev-telegram-id'];
    if (devUserId) {
      const parsedId = Number(devUserId);
      if (!isNaN(parsedId) && parsedId > 0) {
        request.telegramUser = {
          id: parsedId,
          first_name: 'DevUser',
          username: 'dev_user',
        };
        return;
      }
    }
  }

  const authHeader = request.headers.authorization;
  let initDataRaw: string | undefined;

  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && (parts[0].toLowerCase() === 'tma' || parts[0].toLowerCase() === 'bearer')) {
      initDataRaw = parts[1];
    }
  }

  if (!initDataRaw) {
    const xInitData = request.headers['x-telegram-init-data'];
    if (typeof xInitData === 'string' && xInitData.length > 0) {
      initDataRaw = xInitData;
    }
  }

  if (!initDataRaw) {
    void reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Telegram initData authorization header required (Authorization: tma <initData>)',
    });
    return;
  }

  const result = validateTelegramInitData(initDataRaw, env.BOT_TOKEN);
  if (!result.isValid || !result.data) {
    void reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: result.error ?? 'Invalid Telegram initData signature',
    });
    return;
  }

  request.telegramUser = result.data.user;
}

/**
 * Optional Telegram auth: if header is present, parses user; otherwise continues as guest.
 */
export async function optionalTelegramAuth(request: FastifyRequest): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    const devUserId = request.headers['x-dev-telegram-id'];
    if (devUserId) {
      const parsedId = Number(devUserId);
      if (!isNaN(parsedId) && parsedId > 0) {
        request.telegramUser = {
          id: parsedId,
          first_name: 'DevUser',
          username: 'dev_user',
        };
        return;
      }
    }
  }

  const authHeader = request.headers.authorization;
  let initDataRaw: string | undefined;

  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && (parts[0].toLowerCase() === 'tma' || parts[0].toLowerCase() === 'bearer')) {
      initDataRaw = parts[1];
    }
  }

  if (!initDataRaw) {
    const xInitData = request.headers['x-telegram-init-data'];
    if (typeof xInitData === 'string') {
      initDataRaw = xInitData;
    }
  }

  if (initDataRaw) {
    const result = validateTelegramInitData(initDataRaw, env.BOT_TOKEN);
    if (result.isValid && result.data) {
      request.telegramUser = result.data.user;
    }
  }
}
