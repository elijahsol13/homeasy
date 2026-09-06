import { Api } from 'grammy';
import { env } from '../config/env';

/**
 * Standardized In-App Alerting Service for HomEasy.
 * Logs events to console and asynchronously delivers alerts to Telegram administrators (ADMIN_IDS).
 */
export class AlertService {
  private api: Api | null;
  private readonly adminIds: number[];

  constructor(api?: Api, adminIds?: number[]) {
    this.api = api ?? (env.BOT_TOKEN ? new Api(env.BOT_TOKEN) : null);
    this.adminIds = adminIds ?? env.ADMIN_IDS;
  }

  /**
   * Updates or registers the active grammY Bot API instance.
   */
  setApi(api: Api): void {
    this.api = api;
  }

  /**
   * Internal broadcaster: sends formatted HTML message to all configured administrators.
   */
  private async broadcast(prefix: string, message: string): Promise<void> {
    const formatted = `${prefix} ${message}`;

    if (!this.api && env.BOT_TOKEN) {
      try {
        this.api = new Api(env.BOT_TOKEN);
      } catch (err) {
        console.warn('[AlertService] Failed to initialize fallback Api client:', err);
      }
    }

    if (!this.api || this.adminIds.length === 0) {
      return;
    }

    for (const adminId of this.adminIds) {
      try {
        await this.api.sendMessage(adminId, formatted, { parse_mode: 'HTML' });
      } catch (err) {
        console.warn(`[AlertService] Failed to deliver alert to admin ${adminId}:`, err);
      }
    }
  }

  /**
   * Informational alert: duplicates to console.info and broadcasts to admins.
   */
  async info(msg: string): Promise<void> {
    console.info(`ℹ️ [INFO] ${msg}`);
    await this.broadcast('ℹ️ [INFO]', msg);
  }

  /**
   * Warning alert: duplicates to console.warn and broadcasts to admins.
   */
  async warn(msg: string): Promise<void> {
    console.warn(`⚠️ [WARN] ${msg}`);
    await this.broadcast('⚠️ [WARN]', msg);
  }

  /**
   * Critical operational alert: duplicates to console.error and broadcasts to admins.
   */
  async critical(msg: string): Promise<void> {
    console.error(`🚨 [CRITICAL] ${msg}`);
    await this.broadcast('🚨 [CRITICAL]', msg);
  }
}
