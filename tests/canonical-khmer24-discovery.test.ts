import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { CanonicalKhmer24DiscoveryRunner } from '../src/modules/parser/canonical-khmer24-discovery';

describe('Canonical Khmer24 discovery runner', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); });
  afterEach(() => db.close());

  it('is disabled unless an explicit bounded item cap is supplied', async () => {
    const ingestBatch = jest.fn();
    const runner = new CanonicalKhmer24DiscoveryRunner(db, { ingestBatch } as never);
    await expect(runner.run()).resolves.toEqual({ disabled: true, requestedItemCap: 0, feedTargets: 0, fetched: 0 });
    expect(ingestBatch).not.toHaveBeenCalled();
  });

  it('rejects caps above the hard discovery maximum before browser acquisition', async () => {
    const runner = new CanonicalKhmer24DiscoveryRunner(db, { ingestBatch: jest.fn() } as never);
    await expect(runner.run({ maxItems: 11 })).rejects.toThrow('maxItems must be an integer from 0 through 10');
  });
});
