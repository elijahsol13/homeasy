import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync, linkSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export interface StoredPhoto {
  hash: string;
  relativePath: string;
  byteLength: number;
}

export function storeEncodedPhotoSync(root: string, input: Buffer): StoredPhoto {
  if (!input.length) throw new Error('Empty media file');
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Invalid media root');

  const hash = createHash('sha256').update(input).digest('hex');
  const prefix = hash.slice(0, 2);
  const relativePath = path.posix.join(prefix, hash + '.webp');
  const directory = path.join(root, prefix);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = lstatSync(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error('Invalid media directory');

  const target = path.join(directory, hash + '.webp');
  const temporary = path.join(directory, '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, input, { flag: 'wx', mode: 0o600 });
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readFileSync(target);
      if (createHash('sha256').update(existing).digest('hex') !== hash) {
        throw new Error('Existing media hash mismatch');
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return { hash, relativePath, byteLength: input.length };
}

export async function storeEncodedPhoto(root: string, input: Buffer): Promise<StoredPhoto> {
  return storeEncodedPhotoSync(root, input);
}
