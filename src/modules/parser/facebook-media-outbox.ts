import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FacebookMediaBatch {
  groupId: string;
  postId: string;
  capturedAt: string;
  photos: Array<{ sourceUrl: string; anchorId: string | null; fullBase64: string; thumbBase64: string }>;
}

const pendingFlushes = new Map<string, Promise<void>>();

function secureEndpoint(url: string, token: string): void {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))) {
    throw new Error('Facebook media URL must use HTTPS');
  }
  if (token.length < 32) throw new Error('Facebook media token is too short');
}

/** The queue file is renamed into view only after a complete write. Same payload requeues idempotently. */
export function queueFacebookMedia(outboxDir: string, batch: FacebookMediaBatch): string {
  if (batch.photos.length < 1 || batch.photos.length > 50) throw new Error('Invalid photo count');
  const body = JSON.stringify(batch);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error('Media batch exceeds API limit');
  const name = createHash('sha256').update(body).digest('hex') + '.json';
  fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(outboxDir, '.' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(outboxDir, name));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return path.join(outboxDir, name);
}

/** ACK must cover every photo; failed or incomplete responses leave the durable file for replay. */
export async function flushFacebookMediaOutbox(
  outboxDir: string, url: string, token: string, transport: typeof fetch = fetch,
): Promise<number> {
  secureEndpoint(url, token);
  const previous = pendingFlushes.get(outboxDir);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  pendingFlushes.set(outboxDir, current);
  if (previous) await previous;
  try {
    if (!fs.existsSync(outboxDir)) return 0;
    let acknowledged = 0;
    for (const name of fs.readdirSync(outboxDir).filter((file) => file.endsWith('.json')).sort()) {
      const file = path.join(outboxDir, name);
      const batch = JSON.parse(fs.readFileSync(file, 'utf8')) as FacebookMediaBatch;
      const response = await transport(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(batch), signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Facebook media upload HTTP ${response.status}; batch retained`);
      const result = await response.json() as { galleryId?: unknown; photos?: Array<{ fullUrl?: unknown; thumbUrl?: unknown }> };
      if (!Number.isSafeInteger(result.galleryId) || !Array.isArray(result.photos)
        || result.photos.length !== batch.photos.length
        || !result.photos.every((photo) => typeof photo.fullUrl === 'string' && photo.fullUrl.startsWith('/api/v1/media/')
          && typeof photo.thumbUrl === 'string' && photo.thumbUrl.startsWith('/api/v1/media/'))) {
        throw new Error('Facebook media upload acknowledgment incomplete; batch retained');
      }
      fs.unlinkSync(file);
      acknowledged++;
    }
    return acknowledged;
  } finally {
    release();
    if (pendingFlushes.get(outboxDir) === current) pendingFlushes.delete(outboxDir);
  }
}
