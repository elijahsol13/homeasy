export type Khmer24FreshnessObservation = 'ALIVE' | 'REMOVED' | 'UNKNOWN';

export const KHMER24_NORMAL_RECHECK_MS = 7 * 24 * 60 * 60 * 1_000;
export const KHMER24_TERMINAL_CONFIRMATION_MS = 6 * 60 * 60 * 1_000;
const UNKNOWN_BACKOFF_MS = [60 * 60 * 1_000, 6 * 60 * 60 * 1_000, 24 * 60 * 60 * 1_000] as const;

export interface Khmer24OccurrenceFreshnessState {
  lastSeenAt: string;
  consecutiveTerminalChecks: number;
  terminalCheckLastSeenAt: string | null;
  terminalCheckConfirmAfterAt: string | null;
  consecutiveCheckFailures: number;
}

export interface Khmer24FreshnessTransition {
  nextCheckAt: string;
  consecutiveTerminalChecks: number;
  terminalCheckLastSeenAt: string | null;
  terminalCheckConfirmAfterAt: string | null;
  consecutiveCheckFailures: number;
  confirmsTerminalRemoval: boolean;
}

function at(date: Date, milliseconds: number): string {
  return new Date(date.getTime() + milliseconds).toISOString();
}

/**
 * Pure, source-occurrence level policy. A terminal page must be observed twice
 * from separate runs at least six hours apart, without natural rediscovery in
 * between, before it can end the occurrence.
 */
export function transitionKhmer24Freshness(
  state: Khmer24OccurrenceFreshnessState,
  observation: Khmer24FreshnessObservation,
  checkedAt: Date,
): Khmer24FreshnessTransition {
  if (observation === 'ALIVE') {
    return {
      nextCheckAt: at(checkedAt, KHMER24_NORMAL_RECHECK_MS),
      consecutiveTerminalChecks: 0,
      terminalCheckLastSeenAt: null,
      terminalCheckConfirmAfterAt: null,
      consecutiveCheckFailures: 0,
      confirmsTerminalRemoval: false,
    };
  }

  if (observation === 'UNKNOWN') {
    const consecutiveCheckFailures = state.consecutiveCheckFailures + 1;
    const delay = UNKNOWN_BACKOFF_MS[Math.min(consecutiveCheckFailures - 1, UNKNOWN_BACKOFF_MS.length - 1)]!;
    return {
      nextCheckAt: at(checkedAt, delay),
      consecutiveTerminalChecks: state.consecutiveTerminalChecks,
      terminalCheckLastSeenAt: state.terminalCheckLastSeenAt,
      terminalCheckConfirmAfterAt: state.terminalCheckConfirmAfterAt,
      consecutiveCheckFailures,
      confirmsTerminalRemoval: false,
    };
  }

  const sameNaturalObservation = state.terminalCheckLastSeenAt === state.lastSeenAt;
  const confirmationDueAt = state.terminalCheckConfirmAfterAt ? Date.parse(state.terminalCheckConfirmAfterAt) : Number.NaN;
  const confirmationWindowReached = Number.isFinite(confirmationDueAt) && checkedAt.getTime() >= confirmationDueAt;
  const confirmed = sameNaturalObservation && state.consecutiveTerminalChecks >= 1 && confirmationWindowReached;
  if (confirmed) {
    return {
      nextCheckAt: at(checkedAt, KHMER24_NORMAL_RECHECK_MS),
      consecutiveTerminalChecks: state.consecutiveTerminalChecks + 1,
      terminalCheckLastSeenAt: state.lastSeenAt,
      terminalCheckConfirmAfterAt: null,
      consecutiveCheckFailures: 0,
      confirmsTerminalRemoval: true,
    };
  }

  const startsNewTerminalSequence = !sameNaturalObservation;
  const confirmAfter = startsNewTerminalSequence || !state.terminalCheckConfirmAfterAt
    ? at(checkedAt, KHMER24_TERMINAL_CONFIRMATION_MS)
    : state.terminalCheckConfirmAfterAt;
  return {
    nextCheckAt: confirmAfter,
    consecutiveTerminalChecks: startsNewTerminalSequence ? 1 : Math.max(1, state.consecutiveTerminalChecks),
    terminalCheckLastSeenAt: state.lastSeenAt,
    terminalCheckConfirmAfterAt: confirmAfter,
    consecutiveCheckFailures: 0,
    confirmsTerminalRemoval: false,
  };
}
