import type { DatabaseSync } from 'node:sqlite';

export type FunnelPeriod = '24h' | '3d' | '7d';

/** Admin/manual smoke account; pass --exclude-telegram-id for any other run-specific test account. */
export const DEFAULT_INTERNAL_TELEGRAM_IDS = [299321244] as const;

interface UsageEventRow {
  id: number;
  user_id: number | null;
  telegram_id: number | null;
  event_type: string;
  metadata: string;
  created_at: string;
}

interface InterestRow {
  id: string;
  user_id: number;
  telegram_id: number | null;
  public_ref: string;
  title: string | null;
  search_context_json: string;
  created_at: string;
}

type ContextKind = 'direct' | 'broad' | 'filtered' | 'invalid';

export interface Phase7AFunnelReport {
  generatedAt: string;
  period: FunnelPeriod;
  startAt: string;
  endAt: string;
  excludedTelegramIds: number[];
  scope: {
    eventRows: number;
    durableInterestRecords: number;
  };
  funnel: {
    uniqueListingViewUsers: number;
    uniqueListingsViewed: number;
    listingViewEvents: number;
    uniqueInterestUsers: number;
    uniqueInterestedListings: number;
    interestCreatedEvents: number;
    uniqueTelegramDispatchUsers: number;
    uniqueTelegramDispatchedListings: number;
    telegramContactDispatchedEvents: number;
    viewToInterestUserRate: number | null;
    viewedToInterestedListingRate: number | null;
    grantsPerInterestHealth: number | null;
  };
  dispatch: {
    uniqueUserListingPairs: number;
    repeatDispatchEvents: number;
    pairsWithRepeatDispatches: number;
    topRepeatedPairs: Array<{ telegramId: number | null; publicRef: string; dispatches: number }>;
  };
  interestsPerUser: {
    usersWithOneInterest: number;
    usersWithMultipleInterests: number;
    average: number | null;
    max: number;
  };
  context: {
    direct: number;
    broad: number;
    filtered: number;
    invalid: number;
    note: string;
  };
  topListingsByInterest: Array<{ publicRef: string; title: string | null; interests: number }>;
  viewToInterest: {
    matchedInterests: number;
    unmatchedInterests: number;
    medianSeconds: number | null;
  };
  dataQuality: {
    grantsPerInterest: number | null;
    interestEventMinusDurableRecordCount: number;
  };
}

function actorKey(row: Pick<UsageEventRow, 'id' | 'user_id' | 'telegram_id'>): string {
  if (row.telegram_id !== null) return `tg:${row.telegram_id}`;
  if (row.user_id !== null) return `user:${row.user_id}`;
  return `event:${row.id}`;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function publicRef(row: UsageEventRow): string | null {
  const value = parseMetadata(row.metadata).listing_public_ref;
  return typeof value === 'string' && value ? value : null;
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const value = ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
  return Number(value.toFixed(1));
}

function classifyContext(raw: string): ContextKind {
  let context: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
    context = parsed as Record<string, unknown>;
  } catch {
    return 'invalid';
  }

  const keys = Object.keys(context);
  if (keys.length === 0) return 'direct';
  const broadKeys = new Set(['city', 'type', 'sort']);
  const isBroad = keys.every((key) => broadKeys.has(key))
    && (context.city === undefined || context.city === 'siem_reap')
    && (context.type === undefined || context.type === 'rent')
    && (context.sort === undefined || context.sort === 'newest');
  return isBroad ? 'broad' : 'filtered';
}

function excludedClause(ids: readonly number[], column: string): { sql: string; values: number[] } {
  if (ids.length === 0) return { sql: '', values: [] };
  return { sql: ` AND (${column} IS NULL OR ${column} NOT IN (${ids.map(() => '?').join(',')}))`, values: [...ids] };
}

export function periodStart(period: FunnelPeriod, end = new Date()): Date {
  const hours: Record<FunnelPeriod, number> = { '24h': 24, '3d': 72, '7d': 168 };
  return new Date(end.getTime() - hours[period] * 60 * 60 * 1000);
}

/**
 * Builds a read-only Phase 7A baseline report from first-party SQLite events.
 * It intentionally does not run migrations or mutate analytics state.
 */
export function buildPhase7AFunnelReport(input: {
  db: DatabaseSync;
  period: FunnelPeriod;
  endAt?: Date;
  excludedTelegramIds?: readonly number[];
}): Phase7AFunnelReport {
  const endAt = input.endAt ?? new Date();
  const startAt = periodStart(input.period, endAt);
  const excludedTelegramIds = [...new Set(input.excludedTelegramIds ?? DEFAULT_INTERNAL_TELEGRAM_IDS)];
  const eventTypes = ['listing_view', 'interest_created', 'contact_granted', 'telegram_contact_dispatched'];
  const eventExclusions = excludedClause(excludedTelegramIds, 'telegram_id');
  const interestExclusions = excludedClause(excludedTelegramIds, 'u.telegram_id');
  const start = startAt.toISOString();
  const end = endAt.toISOString();

  const events = input.db.prepare(`
    SELECT id,user_id,telegram_id,event_type,metadata,created_at
    FROM usage_events
    WHERE created_at >= ? AND created_at < ?
      AND event_type IN (${eventTypes.map(() => '?').join(',')})${eventExclusions.sql}
    ORDER BY created_at ASC, id ASC
  `).all(start, end, ...eventTypes, ...eventExclusions.values) as unknown as UsageEventRow[];

  const interests = input.db.prepare(`
    SELECT li.id,li.user_id,u.telegram_id,cl.public_ref,cl.title,li.search_context_json,li.created_at
    FROM listing_interests li
    JOIN users u ON u.id=li.user_id
    JOIN canonical_listings cl ON cl.id=li.listing_id
    WHERE li.created_at >= ? AND li.created_at < ?${interestExclusions.sql}
    ORDER BY li.created_at ASC, li.id ASC
  `).all(start, end, ...interestExclusions.values) as unknown as InterestRow[];

  const views = events.filter((event) => event.event_type === 'listing_view');
  const interestEvents = events.filter((event) => event.event_type === 'interest_created');
  const grants = events.filter((event) => event.event_type === 'contact_granted');
  const dispatches = events.filter((event) => event.event_type === 'telegram_contact_dispatched');
  const refOf = (event: UsageEventRow) => publicRef(event);
  const users = (rows: UsageEventRow[]) => new Set(rows.map(actorKey));
  const refs = (rows: UsageEventRow[]) => new Set(rows.flatMap((event) => {
    const ref = refOf(event);
    return ref ? [ref] : [];
  }));

  const dispatchCounts = new Map<string, { count: number; telegramId: number | null; publicRef: string }>();
  for (const event of dispatches) {
    const ref = refOf(event);
    if (!ref) continue;
    const key = `${actorKey(event)}|${ref}`;
    const entry = dispatchCounts.get(key) ?? { count: 0, telegramId: event.telegram_id, publicRef: ref };
    entry.count += 1;
    dispatchCounts.set(key, entry);
  }

  const interestsByUser = new Map<number, number>();
  const interestsByListing = new Map<string, { count: number; title: string | null }>();
  const contextCounts: Record<ContextKind, number> = { direct: 0, broad: 0, filtered: 0, invalid: 0 };
  for (const interest of interests) {
    interestsByUser.set(interest.user_id, (interestsByUser.get(interest.user_id) ?? 0) + 1);
    const listing = interestsByListing.get(interest.public_ref) ?? { count: 0, title: interest.title };
    listing.count += 1;
    interestsByListing.set(interest.public_ref, listing);
    contextCounts[classifyContext(interest.search_context_json)] += 1;
  }

  const lastViewByPair = new Map<string, number>();
  const viewToInterestSeconds: number[] = [];
  const timeline = [...views, ...interestEvents].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  for (const event of timeline) {
    const ref = refOf(event);
    if (!ref) continue;
    const key = `${actorKey(event)}|${ref}`;
    const timestamp = Date.parse(event.created_at);
    if (event.event_type === 'listing_view') {
      lastViewByPair.set(key, timestamp);
    } else {
      const viewedAt = lastViewByPair.get(key);
      if (viewedAt !== undefined && timestamp >= viewedAt) viewToInterestSeconds.push((timestamp - viewedAt) / 1000);
    }
  }

  const uniqueViewUsers = users(views);
  const uniqueInterestUsers = users(interestEvents);
  const uniqueViewedRefs = refs(views);
  const uniqueInterestedRefs = refs(interestEvents);
  const repeated = [...dispatchCounts.values()].filter((entry) => entry.count > 1);
  const interestValues = [...interestsByUser.values()];

  return {
    generatedAt: new Date().toISOString(),
    period: input.period,
    startAt: start,
    endAt: end,
    excludedTelegramIds,
    scope: { eventRows: events.length, durableInterestRecords: interests.length },
    funnel: {
      uniqueListingViewUsers: uniqueViewUsers.size,
      uniqueListingsViewed: uniqueViewedRefs.size,
      listingViewEvents: views.length,
      uniqueInterestUsers: uniqueInterestUsers.size,
      uniqueInterestedListings: uniqueInterestedRefs.size,
      interestCreatedEvents: interestEvents.length,
      uniqueTelegramDispatchUsers: users(dispatches).size,
      uniqueTelegramDispatchedListings: refs(dispatches).size,
      telegramContactDispatchedEvents: dispatches.length,
      viewToInterestUserRate: percentage([...uniqueInterestUsers].filter((user) => uniqueViewUsers.has(user)).length, uniqueViewUsers.size),
      viewedToInterestedListingRate: percentage([...uniqueInterestedRefs].filter((ref) => uniqueViewedRefs.has(ref)).length, uniqueViewedRefs.size),
      grantsPerInterestHealth: percentage(grants.length, interestEvents.length),
    },
    dispatch: {
      uniqueUserListingPairs: dispatchCounts.size,
      repeatDispatchEvents: dispatches.length - dispatchCounts.size,
      pairsWithRepeatDispatches: repeated.length,
      topRepeatedPairs: repeated
        .sort((a, b) => b.count - a.count || a.publicRef.localeCompare(b.publicRef))
        .slice(0, 10)
        .map((entry) => ({ telegramId: entry.telegramId, publicRef: entry.publicRef, dispatches: entry.count })),
    },
    interestsPerUser: {
      usersWithOneInterest: interestValues.filter((count) => count === 1).length,
      usersWithMultipleInterests: interestValues.filter((count) => count > 1).length,
      average: interestValues.length === 0 ? null : Number((interests.length / interestValues.length).toFixed(2)),
      max: interestValues.length === 0 ? 0 : Math.max(...interestValues),
    },
    context: {
      ...contextCounts,
      note: 'Inferred from the immutable interest snapshot: {}=direct, initial Siem Reap rent/newest defaults=broad, otherwise=filtered. Phase 7A does not store route provenance, so a deep link that carries default filters is classified as broad.',
    },
    topListingsByInterest: [...interestsByListing.entries()]
      .sort(([, a], [, b]) => b.count - a.count || (a.title ?? '').localeCompare(b.title ?? ''))
      .slice(0, 10)
      .map(([publicRef, value]) => ({ publicRef, title: value.title, interests: value.count })),
    viewToInterest: {
      matchedInterests: viewToInterestSeconds.length,
      unmatchedInterests: Math.max(0, interestEvents.length - viewToInterestSeconds.length),
      medianSeconds: median(viewToInterestSeconds),
    },
    dataQuality: {
      grantsPerInterest: percentage(grants.length, interestEvents.length),
      interestEventMinusDurableRecordCount: interestEvents.length - interests.length,
    },
  };
}
