import {
  KHMER24_NORMAL_RECHECK_MS,
  KHMER24_TERMINAL_CONFIRMATION_MS,
  transitionKhmer24Freshness,
} from '../src/modules/parser/canonical-khmer24-freshness-policy';

const checkedAt = new Date('2026-10-09T00:00:00.000Z');
const initial = {
  lastSeenAt: '2026-09-01T00:00:00.000Z',
  consecutiveTerminalChecks: 0,
  terminalCheckLastSeenAt: null,
  terminalCheckConfirmAfterAt: null,
  consecutiveCheckFailures: 0,
};

describe('canonical Khmer24 freshness policy', () => {
  it('sets the normal seven-day TTL after ALIVE and clears transient state', () => {
    expect(transitionKhmer24Freshness({ ...initial, consecutiveTerminalChecks: 1, consecutiveCheckFailures: 2 }, 'ALIVE', checkedAt))
      .toEqual(expect.objectContaining({
        nextCheckAt: new Date(checkedAt.getTime() + KHMER24_NORMAL_RECHECK_MS).toISOString(),
        consecutiveTerminalChecks: 0,
        consecutiveCheckFailures: 0,
        confirmsTerminalRemoval: false,
      }));
  });

  it('requires a second terminal observation after the six-hour confirmation window', () => {
    const first = transitionKhmer24Freshness(initial, 'REMOVED', checkedAt);
    expect(first).toEqual(expect.objectContaining({
      consecutiveTerminalChecks: 1,
      terminalCheckLastSeenAt: initial.lastSeenAt,
      terminalCheckConfirmAfterAt: new Date(checkedAt.getTime() + KHMER24_TERMINAL_CONFIRMATION_MS).toISOString(),
      confirmsTerminalRemoval: false,
    }));
    const tooSoon = transitionKhmer24Freshness({ ...initial, ...first }, 'REMOVED', new Date(checkedAt.getTime() + 60_000));
    expect(tooSoon.confirmsTerminalRemoval).toBe(false);
    const confirmed = transitionKhmer24Freshness({ ...initial, ...first }, 'REMOVED', new Date(checkedAt.getTime() + KHMER24_TERMINAL_CONFIRMATION_MS));
    expect(confirmed).toEqual(expect.objectContaining({ consecutiveTerminalChecks: 2, confirmsTerminalRemoval: true }));
  });

  it('treats rediscovery as a new terminal sequence', () => {
    const first = transitionKhmer24Freshness(initial, 'REMOVED', checkedAt);
    const afterRediscovery = transitionKhmer24Freshness({
      ...initial,
      ...first,
      lastSeenAt: '2026-10-09T01:00:00.000Z',
    }, 'REMOVED', new Date(checkedAt.getTime() + KHMER24_TERMINAL_CONFIRMATION_MS));
    expect(afterRediscovery).toEqual(expect.objectContaining({
      consecutiveTerminalChecks: 1,
      terminalCheckLastSeenAt: '2026-10-09T01:00:00.000Z',
      confirmsTerminalRemoval: false,
    }));
  });

  it('backs off UNKNOWN checks from one to six to twenty-four hours', () => {
    const first = transitionKhmer24Freshness(initial, 'UNKNOWN', checkedAt);
    const second = transitionKhmer24Freshness({ ...initial, ...first }, 'UNKNOWN', checkedAt);
    const third = transitionKhmer24Freshness({ ...initial, ...second }, 'UNKNOWN', checkedAt);
    expect(first.nextCheckAt).toBe('2026-10-09T01:00:00.000Z');
    expect(second.nextCheckAt).toBe('2026-10-09T06:00:00.000Z');
    expect(third.nextCheckAt).toBe('2026-10-10T00:00:00.000Z');
  });
});
