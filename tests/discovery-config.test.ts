import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('discovery configuration profile', () => {
  it('does not require BOT_TOKEN or validate unrelated scraper settings', () => {
    const root = path.resolve(__dirname, '..');
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e',
      "const {env}=require('./src/config/env'); if(env.BOT_TOKEN!==undefined || env.DATABASE_PATH!==':memory:') process.exit(2);"], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOMEASY_CONFIG_PROFILE: 'discovery',
        DATABASE_PATH: ':memory:',
        BOT_TOKEN: '',
        FB_PROXY_ENABLED: 'not-a-boolean-for-this-profile',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('keeps the ordinary application profile fail-fast without BOT_TOKEN', () => {
    const root = path.resolve(__dirname, '..');
    const childEnv = { ...process.env, HOMEASY_CONFIG_PROFILE: '', BOT_TOKEN: '' };
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', "require('./src/config/env');"], {
      cwd: root, encoding: 'utf8', env: childEnv,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BOT_TOKEN');
  });

  it('boots the actual discovery CLI past config/container setup without BOT_TOKEN', () => {
    const root = path.resolve(__dirname, '..');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-discovery-config-'));
    try {
      const result = spawnSync(path.join(root, 'node_modules/.bin/ts-node'), [path.join(root, 'scripts/canonical-khmer24-discovery.ts'), '--max-items=1'], {
        cwd, encoding: 'utf8', env: { ...process.env, BOT_TOKEN: '', HOMEASY_CONFIG_PROFILE: '', DATABASE_PATH: ':memory:' },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Khmer24 pinned device is missing');
      expect(result.stderr).not.toContain('BOT_TOKEN');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
