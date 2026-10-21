import type { IngestionMethod, SourceType } from '../../database/repositories/source-ingestion.repo';
import type { SourceIdentifierInput } from '../../database/repositories/source-ingestion.repo';
import type { ScopedMutationDiagnosticReport } from './canonical-dedupe';

export interface SourceIdentity {
  sourceType: SourceType;
  externalSourceId: string;
  name: string;
  url?: string;
  city?: 'siem_reap' | 'phnom_penh';
}

export interface NormalizedSourceItem<T = unknown> {
  sourceIdentity: SourceIdentity;
  externalId: string;
  raw: T;
  canonicalUrl?: string;
  sourceUrl?: string;
  groupId?: string;
  groupName?: string;
  authorExternalId?: string;
  authorName?: string;
  authorUrl?: string;
  rawText?: string;
  contentHash?: string;
  publishedAt?: string;
  classification?: 'HOUSING_SUPPLY' | 'HOUSING_DEMAND' | 'HOUSING_ADJACENT' | 'IRRELEVANT' | 'UNCLASSIFIED';
  mediaHash?: string;
  metadata?: Record<string, unknown>;
  aiResults?: Array<{
    stage: 'CLASSIFICATION' | 'SUPPLY_EXTRACTION' | 'DEMAND_EXTRACTION';
    provider?: string;
    model?: string;
    fallbackDepth?: number;
    callId?: string;
    attemptIndex?: number;
    promptVersion?: string;
    success?: boolean;
    errorCode?: string;
    latencyMs?: number;
  }>;
  deterministicIdentifiers?: SourceIdentifierInput[];
}

export interface SourceRunContext {
  runType: 'DISCOVERY' | 'REPLAY' | 'REPARSE' | 'FRESHNESS_CHECK' | 'MANUAL_IMPORT';
  ingestionMethod: IngestionMethod;
  dryRun?: boolean;
  observedAt?: string;
  parserVersion?: string;
  /** Internal mode for already-acquired bounded batches: buffer first, then transact DB writes. */
  atomicDbStage?: boolean;
  /** Internal recursion marker: this batch is already running inside its DB savepoint. */
  atomicDbStageActive?: boolean;
}

export interface SourceAdapter<T = unknown> {
  readonly sourceType: SourceType;
  fetchNewItems(context: SourceRunContext): AsyncIterable<T>;
  normalize(raw: T): NormalizedSourceItem<T>;
  /** Called only for a new/changed item, or an item left unclassified by an interrupted run. */
  processNewOrChanged?(raw: T, normalized: NormalizedSourceItem<T>, context: {
    status: 'new' | 'changed' | 'media-only' | 'retry';
    contentChanged: boolean;
    mediaChanged: boolean;
    run: SourceRunContext;
  }): Promise<NormalizedSourceItem<T>>;
}

export interface IngestionBatchResult {
  runId?: number;
  inputItems: number;
  processedItems: number;
  newSources: number;
  newSourceItems: number;
  updatedSourceItems: number;
  unchangedSourceItems: number;
  newVersions: number;
  errors: Array<{ externalId?: string; message: string }>;
  classificationCounts: Record<string, number>;
  identifierCounts: Record<string, number>;
  providerCounts: Record<string, number>;
  incrementalRepostItems: number;
  incrementalRepostClustersCreated: number;
  incrementalRepostClustersUpdated: number;
  incrementalCanonicalItems: number;
  occurrencesAttached: number;
  canonicalBindingsUpdated: number;
  repurposedBindingsClosed: number;
  needsGlobalCanonicalMatch: number;
  canonicalInconsistencies: number;
  globalCanonicalRuns: number;
  globalCanonicalProperties: number;
  globalCanonicalListings: number;
  scopedCanonicalRuns: number;
  mutationReport: {
    directWrites: {
      sourceItemsCreated: number;
      sourceItemsChanged: number;
      unchangedObservations: number;
      versionsCreated: number;
      identifierSetsReplaced: number;
    };
    reconciliationWrites: {
      globalCandidatesRead: number;
      candidatePairsScored: number;
      relatedCandidates: number;
      decisionsWritten: number;
      canonicalPropertiesCreated: number;
      canonicalListingsCreated: number;
      sourceOccurrencesCreated: number;
      aliasesCreated: number;
      mediaAssetsCreated: number;
      mediaAssociationsCreated: number;
    };
    existingCanonicalObjectsMutated: Array<{
      kind: 'canonical_property' | 'canonical_listing';
      id: number;
      sourceItemIds: number[];
      reason: string;
    }>;
    unexpectedGlobalWrites: number;
    diagnostics: ScopedMutationDiagnosticReport | null;
  };
  items: Array<{ externalId: string; sourceKey: string; status: 'new' | 'updated' | 'unchanged' | 'error' }>;
  dryRun: boolean;
}
