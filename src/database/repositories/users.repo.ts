import type { DatabaseSync } from 'node:sqlite';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  role: 'user' | 'admin';
  is_active: 0 | 1;
  alerts_paused: 0 | 1;
  created_at: string;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class UsersRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Creates or updates a user record. Safe to call on every /start.
   * Only updates `username` on conflict (preserves role/is_active/alerts_paused).
   */
  upsertUser(telegramId: number, username: string | null): User {
    this.db.prepare(
      `INSERT INTO users (telegram_id, username)
       VALUES (?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET
         username = excluded.username`,
    ).run(telegramId, username);

    return this.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as unknown as User;
  }

  findByTelegramId(telegramId: number): User | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE telegram_id = ?')
      .get(telegramId) as unknown as User | undefined;
  }

  findById(id: number): User | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as User | undefined;
  }

  setActive(telegramId: number, active: boolean): void {
    this.db
      .prepare('UPDATE users SET is_active = ? WHERE telegram_id = ?')
      .run(active ? 1 : 0, telegramId);
  }

  setAlertsPaused(telegramId: number, paused: boolean): void {
    this.db
      .prepare('UPDATE users SET alerts_paused = ? WHERE telegram_id = ?')
      .run(paused ? 1 : 0, telegramId);
  }

  toggleAlertsPaused(telegramId: number): boolean {
    const user = this.findByTelegramId(telegramId);
    const newPaused = user?.alerts_paused === 1 ? false : true;
    this.setAlertsPaused(telegramId, newPaused);
    return newPaused;
  }

  isAlertsPaused(telegramId: number): boolean {
    const user = this.findByTelegramId(telegramId);
    return user?.alerts_paused === 1;
  }

  promoteToAdmin(telegramId: number): void {
    this.db
      .prepare("UPDATE users SET role = 'admin' WHERE telegram_id = ?")
      .run(telegramId);
  }

  getUserCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1')
      .get() as unknown as { count: number };
    return row.count;
  }

  getAllActiveUsers(): Pick<User, 'id' | 'telegram_id'>[] {
    return this.db
      .prepare('SELECT id, telegram_id FROM users WHERE is_active = 1 AND alerts_paused = 0')
      .all() as unknown as Pick<User, 'id' | 'telegram_id'>[];
  }
}
