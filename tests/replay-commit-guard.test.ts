import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertReplayCommitSafe } from '../scripts/replay-commit-guard';

describe('host-side live replay protection', () => {
  let root: string;
  let liveDb: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-replay-guard-'));
    fs.mkdirSync(path.join(root, 'data'));
    liveDb = path.join(root, 'data/homeasy.db');
    fs.writeFileSync(liveDb, 'test fixture');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('rejects an unconfirmed live write before any Compose check', () => {
    const composePs = jest.fn(() => '[]');
    expect(() => assertReplayCommitSafe(liveDb, { projectRoot: root, allowLiveDb: false, composePs }))
      .toThrow('Refusing replay --commit');
    expect(composePs).not.toHaveBeenCalled();
  });

  test('rejects active database services even with explicit maintenance flag', () => {
    expect(() => assertReplayCommitSafe(liveDb, {
      projectRoot: root, allowLiveDb: true,
      composePs: () => '[{"Service":"api","State":"running"}]',
    })).toThrow('api container is running');
  });

  test('fails closed when Docker cannot be checked', () => {
    expect(() => assertReplayCommitSafe(liveDb, {
      projectRoot: root, allowLiveDb: true, composePs: () => { throw new Error('socket unavailable'); },
    })).toThrow('Cannot verify Docker Compose is stopped');
  });

  test('allows a live maintenance import only when all database services are stopped', () => {
    expect(() => assertReplayCommitSafe(liveDb, {
      projectRoot: root, allowLiveDb: true,
      composePs: () => [
        '{"Service":"api","State":"exited"}',
        '{"Service":"bot","State":"exited"}',
        '{"Service":"scraper","State":"created"}',
        '{"Service":"backup","State":"exited"}',
        '{"Service":"tunnel","State":"running"}',
      ].join('\n'),
    })).not.toThrow();
  });

  test('treats a symlink to the production DB as production', () => {
    const alias = path.join(root, 'alias.db');
    fs.symlinkSync(liveDb, alias);
    expect(() => assertReplayCommitSafe(alias, {
      projectRoot: root, allowLiveDb: false,
    })).toThrow('Refusing replay --commit');
  });

  test('allows isolated replay fixtures without Docker access', () => {
    const detached = path.join(root, 'fixture.db');
    const composePs = jest.fn(() => { throw new Error('Docker unavailable'); });
    expect(() => assertReplayCommitSafe(detached, {
      projectRoot: root, allowLiveDb: false, composePs,
    })).not.toThrow();
    expect(composePs).not.toHaveBeenCalled();
  });
});
