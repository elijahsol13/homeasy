import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface RepostClusterConfig {
  propertyCodeTextSimilarity: number;
  contactAuthorTextSimilarity: number;
  multipleIdentifierTextSimilarity: number;
  textOnlySimilarity: number;
  demandTextSimilarity: number;
  demandWindowHours: number;
  maxTextPostingFrequency: number;
}

export const DEFAULT_REPOST_CLUSTER_CONFIG: RepostClusterConfig = {
  propertyCodeTextSimilarity: 0.72,
  contactAuthorTextSimilarity: 0.86,
  multipleIdentifierTextSimilarity: 0.74,
  textOnlySimilarity: 0.95,
  demandTextSimilarity: 0.88,
  demandWindowHours: 72,
  maxTextPostingFrequency: 45,
};

type EntityType = 'SUPPLY_REPOST' | 'DEMAND_REPOST';
type IdentifierType = 'PHONE' | 'TELEGRAM' | 'WHATSAPP' | 'EMAIL' | 'PROPERTY_CODE' | 'AGENCY_CODE' | 'MAPS_URL' | 'MAPS_PLACE_ID';

interface ItemRow {
  id: number;
  source_registry_id: number;
  source_type: string;
  external_id: string;
  canonical_url: string | null;
  source_url: string | null;
  group_id: string | null;
  group_name: string | null;
  author_external_id: string | null;
  author_name: string | null;
  raw_text: string | null;
  raw_payload_json: string;
  content_hash: string | null;
  published_at: string | null;
  classification: string;
}

interface IdentifierRow {
  source_item_id: number;
  type: IdentifierType;
  normalized_value: string;
}

interface Item extends ItemRow {
  normalizedText: string;
  tokens: Set<string>;
  trigrams: Set<string>;
  textFingerprint: string;
  authorKey: string | null;
  identifiers: Map<IdentifierType, Set<string>>;
  mediaUrls: string[];
}

interface Candidate {
  left: Item;
  right: Item;
  retrievedBy: Set<string>;
}

interface PairEvaluation {
  accepted: boolean;
  confidence: number;
  similarity: number;
  tokenJaccard: number;
  trigramDice: number;
  reasons: string[];
  method: string;
  threshold?: number;
  timeDeltaHours?: number | null;
  sharedIdentifiers: string[];
}

interface ClusterResult {
  entityType: EntityType;
  key: string;
  members: Item[];
  representative: Item;
  confidence: number;
  method: string;
  reasons: string[];
}

export interface RepostClusterPairDiagnostic {
  leftId: number;
  rightId: number;
  leftGroup: string | null;
  rightGroup: string | null;
  leftAuthor: string | null;
  rightAuthor: string | null;
  leftSnippet: string;
  rightSnippet: string;
  score: number;
  confidence: number;
  method: string;
  reasons: string[];
  sharedPhones: string[];
  sharedCodes: string[];
  status: 'clustered' | 'near_threshold' | 'same_agent_different_text';
}

export interface RepostClusterReport {
  algorithmVersion: string;
  config: RepostClusterConfig;
  dryRun: boolean;
  sourceItemCount: number;
  candidatePairCount: number;
  indexedSignalCount: number;
  entities: Record<EntityType, {
    sourceItems: number;
    clusters: number;
    singletonClusters: number;
    multiMemberClusters: number;
    postsCollapsed: number;
    largestClusterSize: number;
    crossGroupClusters: number;
    crossSourceTypeClusters: number;
    clustersByMethod: Record<string, number>;
  }>;
  ambiguousNotClustered: number;
  nearThresholdPairCount: number;
  clusters: Array<{
    clusterId: number | string | null;
    clusterKey: string;
    entityType: EntityType;
    members: number;
    groups: string[];
    sourceTypes: string[];
    authors: string[];
    propertyCodes: string[];
    phones: string[];
    confidence: number;
    method: string;
    reasons: string[];
    representativeSourceItemId: number;
    representativeText: string;
    memberDetails: Array<{ sourceItemId: number; score: number; reason: string; details: Record<string, unknown> }>;
  }>;
  autoClusterPairs: RepostClusterPairDiagnostic[];
  nonExactHashPairs: RepostClusterPairDiagnostic[];
  nearThresholdPairs: RepostClusterPairDiagnostic[];
  sameAgentExamples: RepostClusterPairDiagnostic[];
  persistedClusterCount?: number;
}

const STOP_WORDS = new Set([
  'a','an','and','are','as','at','be','bed','beds','bedroom','bedrooms','bath','baths','bathroom','bathrooms',
  'by','for','from','has','have','in','is','it','of','on','or','our','the','to','with','rent','rental','rents',
  'available','please','contact','call','message','near','looking','house','apartment','room','flat',
]);
const PHONE_PATTERN = /(?:\+?855|0)[1-9]\d{1,2}(?:[\s().-]*\d){6,8}/g;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu;
const TELEGRAM_PATTERN = /@[p{L}][p{L}p{N}_]{4,31}/gu;
const IMAGE_URL_PATTERN = /(?:\.(?:jpe?g|png|webp|gif)(?:\?|$)|fbcdn|scontent|khmer24\.com\/photos)/i;

function stripUrlPunctuation(value: string): string { return value.replace(/[),.;]+$/g, ''); }

export function normalizeRepostText(rawText: string | null | undefined): string {
  return (rawText ?? '')
    .normalize('NFKC')
    .replace(URL_PATTERN, ' ')
    .replace(EMAIL_PATTERN, ' ')
    .replace(PHONE_PATTERN, ' ')
    .replace(TELEGRAM_PATTERN, ' ')
    .replace(/[\u200B-\u200D\uFEFF\uFE0E\uFE0F]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[-_=*•·]{3,}/g, ' ')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}$%#+_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): Set<string> {
  return new Set(value.split(' ').filter((token) => token && !STOP_WORDS.has(token) && (token.length >= 2 || /\d/.test(token))));
}

function trigrams(value: string): Set<string> {
  const compact = value.replace(/\s+/g, ' ');
  if (compact.length < 3) return new Set(compact ? [compact] : []);
  const result = new Set<string>();
  for (let i = 0; i <= compact.length - 3; i++) result.add(compact.slice(i, i + 3));
  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return (2 * intersection) / (a.size + b.size);
}

function pairKey(a: Item, b: Item): string { return a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`; }

function canonicalAuthor(item: ItemRow): string | null {
  const raw = item.author_external_id?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      const id = url.searchParams.get('id');
      if (id) return `fb:${id.toLowerCase()}`;
      return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '').toLowerCase()}`;
    } catch {
      return raw.toLowerCase().replace(/\s+/g, ' ');
    }
  }
  const name = item.author_name?.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ');
  return name ? `name:${name}` : null;
}

function canonicalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function collectMediaUrls(value: unknown, output = new Set<string>(), path = ''): string[] {
  if (typeof value === 'string') {
    if (/https?:\/\//i.test(value) && (IMAGE_URL_PATTERN.test(value) || /image|photo|media|attachment/i.test(path))) {
      output.add(stripUrlPunctuation(value));
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) collectMediaUrls(entry, output, path);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) collectMediaUrls(entry, output, `${path}.${key}`);
  }
  return [...output].sort();
}

class UnionFind {
  private readonly parent = new Map<number, number>();
  find(id: number): number {
    const current = this.parent.get(id);
    if (current === undefined) { this.parent.set(id, id); return id; }
    if (current === id) return id;
    const root = this.find(current);
    this.parent.set(id, root);
    return root;
  }
  union(a: number, b: number): void {
    const rootA = this.find(a); const rootB = this.find(b);
    if (rootA === rootB) return;
    this.parent.set(Math.max(rootA, rootB), Math.min(rootA, rootB));
  }
}

function shortText(item: Item): string { return (item.raw_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 170); }

export class RepostClusteringService {
  private readonly config: RepostClusterConfig;

  constructor(private readonly db: DatabaseSync, config: Partial<RepostClusterConfig> = {}) {
    this.config = { ...DEFAULT_REPOST_CLUSTER_CONFIG, ...config };
  }

  run(algorithmVersion: string, options: { dryRun: boolean; rebuild?: boolean } ): RepostClusterReport {
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(algorithmVersion)) throw new Error('Invalid algorithm version');
    const items = this.loadItems();
    const supply = items.filter((item) => item.classification === 'HOUSING_SUPPLY');
    const demand = items.filter((item) => item.classification === 'HOUSING_DEMAND');
    const supplyResult = this.clusterEntity('SUPPLY_REPOST', supply);
    const demandResult = this.clusterEntity('DEMAND_REPOST', demand);
    const clusters = [...supplyResult.clusters, ...demandResult.clusters];
    this.lastAcceptedPairs = [...supplyResult.accepted, ...demandResult.accepted];
    if (!options.dryRun) this.persist(clusters, algorithmVersion, options.rebuild === true);

    const idByKey = new Map<string, number>();
    if (!options.dryRun) {
      const query = this.db.prepare('SELECT id, cluster_key FROM dedupe_clusters WHERE algorithm_version=? AND entity_type IN (\'SUPPLY_REPOST\',\'DEMAND_REPOST\')');
      for (const row of query.all(algorithmVersion) as Array<{ id: number; cluster_key: string }>) idByKey.set(row.cluster_key, row.id);
    }
    return this.createReport(algorithmVersion, options.dryRun, items, supply, demand, supplyResult, demandResult, clusters, idByKey);
  }

  /** Reconciles only the changed items, their prior cluster members, and retrieved neighbors. */
  runIncremental(algorithmVersion: string, sourceItemIds: number[], options: { dryRun?: boolean } = {}): {
    algorithmVersion: string; sourceItemIds: number[]; affectedItemIds: number[];
    assignments: Array<{ sourceItemId: number; clusterId: number | null; clusterKey: string; representativeSourceItemId: number }>;
    clustersCreated: number; clustersUpdated: number; clustersRemoved: number;
  } {
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(algorithmVersion)) throw new Error('Invalid algorithm version');
    const changedIds = [...new Set(sourceItemIds)].filter((id) => Number.isInteger(id) && id > 0);
    if (!changedIds.length) return { algorithmVersion, sourceItemIds: [], affectedItemIds: [], assignments: [], clustersCreated: 0, clustersUpdated: 0, clustersRemoved: 0 };
    const all = this.loadItems();
    const byId = new Map(all.map((item) => [item.id, item]));
    const changed = changedIds.map((id) => byId.get(id)).filter((item): item is Item => Boolean(item));
    const changedSet = new Set(changedIds);
    const oldRows = this.db.prepare(`SELECT c.id,c.entity_type,c.cluster_key,c.representative_source_item_id,m.source_item_id
      FROM dedupe_clusters c LEFT JOIN dedupe_cluster_members m ON m.cluster_id=c.id
      WHERE c.algorithm_version=? AND c.entity_type IN ('SUPPLY_REPOST','DEMAND_REPOST')`).all(algorithmVersion) as Array<{
        id:number; entity_type:EntityType; cluster_key:string; representative_source_item_id:number|null; source_item_id:number|null;
      }>;
    const oldClusters = new Map<number,{entityType:EntityType;key:string;representative:number|null;members:Set<number>}>();
    for(const row of oldRows){const entry=oldClusters.get(row.id)??{entityType:row.entity_type,key:row.cluster_key,representative:row.representative_source_item_id,members:new Set<number>()};if(row.source_item_id!==null)entry.members.add(row.source_item_id);oldClusters.set(row.id,entry);}
    const affectedClusterIds = new Set<number>();
    for(const cluster of oldClusters.values()) if([...cluster.members].some((id)=>changedSet.has(id))) {
      const row=oldRows.find((entry)=>entry.cluster_key===cluster.key&&entry.entity_type===cluster.entityType);if(row)affectedClusterIds.add(row.id);
    }
    const scopeIds = new Set<number>(changedIds);
    for(const id of affectedClusterIds) for(const member of oldClusters.get(id)?.members??[]) scopeIds.add(member);

    // Expand through cheap shared-signal buckets; pair scoring remains local to the affected neighborhood.
    const signalKeys = (item:Item):string[] => {
      const keys:string[]=[];
      if(item.content_hash)keys.push(`hash:${item.content_hash}`);
      const url=canonicalUrl(item.canonical_url)??canonicalUrl(item.source_url);if(url)keys.push(`url:${url}`);
      if(item.authorKey)keys.push(`author:${item.authorKey}`);
      for(const [type,values] of item.identifiers)for(const value of values)keys.push(`identifier:${type}:${value}`);
      for(const token of item.tokens)if(!/^\d+$/.test(token)||token.length>=3)keys.push(`token:${token}`);
      return keys;
    };
    const reverse=new Map<string,number[]>();
    const allSignals=all.map((item)=>({item,keys:signalKeys(item)}));
    const frequencies=new Map<string,number>();for(const entry of allSignals)for(const key of entry.keys)frequencies.set(key,(frequencies.get(key)??0)+1);
    const tokenCap=Math.min(Math.max(8,Math.ceil(all.length*0.12)),this.config.maxTextPostingFrequency);
    for(const {item,keys} of allSignals)for(const key of keys){
      if(key.startsWith('token:')&&(frequencies.get(key)??0)>tokenCap)continue;
      if(key.startsWith('author:')&&(frequencies.get(key)??0)>80)continue;
      const ids=reverse.get(key)??[];ids.push(item.id);reverse.set(key,ids);
    }
    const queue=[...scopeIds];
    while(queue.length){const id=queue.shift()!;const item=byId.get(id);if(!item)continue;
      for(const key of signalKeys(item))for(const neighbor of reverse.get(key)??[]){
        if(scopeIds.has(neighbor))continue;scopeIds.add(neighbor);queue.push(neighbor);
        for(const [clusterId,cluster] of oldClusters)if(cluster.members.has(neighbor)){
          affectedClusterIds.add(clusterId);for(const member of cluster.members)if(!scopeIds.has(member)){scopeIds.add(member);queue.push(member);}
        }
      }
    }
    const affected = [...scopeIds].map((id)=>byId.get(id)).filter((item):item is Item=>Boolean(item));
    const supply=affected.filter((item)=>item.classification==='HOUSING_SUPPLY');
    const demand=affected.filter((item)=>item.classification==='HOUSING_DEMAND');
    const supplyResult=this.clusterEntity('SUPPLY_REPOST',supply);const demandResult=this.clusterEntity('DEMAND_REPOST',demand);
    const clusters=[...supplyResult.clusters,...demandResult.clusters];
    const accepted=[...supplyResult.accepted,...demandResult.accepted];this.lastAcceptedPairs=accepted;
    const oldByMember=new Map<number,number>();for(const [clusterId,cluster] of oldClusters)for(const id of cluster.members)oldByMember.set(id,clusterId);
    const assignments:Array<{sourceItemId:number;clusterId:number|null;clusterKey:string;representativeSourceItemId:number}> = [];
    let created=0,updated=0,removed=0;
    if(!options.dryRun){
      this.db.exec('SAVEPOINT repost_incremental');
      try{
        const updateCluster=this.db.prepare(`UPDATE dedupe_clusters SET cluster_key=?,confidence=?,representative_source_item_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`);
        const insertCluster=this.db.prepare(`INSERT INTO dedupe_clusters(entity_type,algorithm_version,cluster_key,confidence,representative_source_item_id) VALUES(?,?,?,?,?)`);
        const insertMember=this.db.prepare(`INSERT INTO dedupe_cluster_members(cluster_id,source_item_id,score,reason,details_json) VALUES(?,?,?,?,?)`);
        const deleteMembers=this.db.prepare('DELETE FROM dedupe_cluster_members WHERE cluster_id=?');
        const deleteCluster=this.db.prepare('DELETE FROM dedupe_clusters WHERE id=?');
        for(const id of affectedClusterIds){deleteMembers.run(id);}
        const claimed=new Set<number>();
        for(const cluster of clusters){
          const oldIds=[...new Set(cluster.members.map((member)=>oldByMember.get(member.id)).filter((id):id is number=>id!==undefined&&affectedClusterIds.has(id)))].sort((a,b)=>a-b);
          let clusterId:number;let key=cluster.key;
          const preserved=oldIds.map((id)=>({id,old:oldClusters.get(id)!})).find(({id,old})=>!claimed.has(id)&&old.representative!==null&&cluster.members.some((member)=>member.id===old.representative));
          const reusable=preserved??oldIds.map((id)=>({id,old:oldClusters.get(id)!})).find(({id})=>!claimed.has(id));
          if(reusable){clusterId=reusable.id;claimed.add(clusterId);key=reusable.old.key;updateCluster.run(key,cluster.confidence||null,cluster.representative.id,clusterId);updated++;}
          else{const result=insertCluster.run(cluster.entityType,algorithmVersion,key,cluster.confidence||null,cluster.representative.id);clusterId=Number(result.lastInsertRowid);created++;}
          const details=this.clusterMemberDetails(cluster);
          for(const member of cluster.members){const detail=details.get(member.id)!;insertMember.run(clusterId,member.id,detail.score,detail.reason,JSON.stringify(detail.details));assignments.push({sourceItemId:member.id,clusterId,clusterKey:key,representativeSourceItemId:cluster.representative.id});}
        }
        for(const id of affectedClusterIds)if(!claimed.has(id)){deleteCluster.run(id);removed++;}
        this.db.exec('RELEASE repost_incremental');
      }catch(error){this.db.exec('ROLLBACK TO repost_incremental');this.db.exec('RELEASE repost_incremental');throw error;}
    }else for(const cluster of clusters)for(const member of cluster.members)assignments.push({sourceItemId:member.id,clusterId:null,clusterKey:cluster.key,representativeSourceItemId:cluster.representative.id});
    return {algorithmVersion,sourceItemIds:changedIds,affectedItemIds:[...scopeIds].sort((a,b)=>a-b),assignments,clustersCreated:created,clustersUpdated:updated,clustersRemoved:removed};
  }

  private loadItems(): Item[] {
    const rows = this.db.prepare(`
      SELECT id, source_registry_id, source_type, external_id, canonical_url, source_url,
        group_id, group_name, author_external_id, author_name, raw_text, raw_payload_json,
        content_hash, published_at, classification
      FROM source_items WHERE classification IN ('HOUSING_SUPPLY','HOUSING_DEMAND')
      ORDER BY id
    `).all() as unknown as ItemRow[];
    const identifierRows = this.db.prepare(`
      SELECT source_item_id, type, normalized_value FROM source_item_identifiers
      WHERE type IN ('PHONE','TELEGRAM','WHATSAPP','EMAIL','PROPERTY_CODE','AGENCY_CODE','MAPS_URL','MAPS_PLACE_ID')
      ORDER BY source_item_id, type, normalized_value
    `).all() as unknown as IdentifierRow[];
    const identifiersByItem = new Map<number, Map<IdentifierType, Set<string>>>();
    for (const row of identifierRows) {
      const perItem = identifiersByItem.get(row.source_item_id) ?? new Map<IdentifierType, Set<string>>();
      const values = perItem.get(row.type) ?? new Set<string>();
      values.add(row.normalized_value);
      perItem.set(row.type, values);
      identifiersByItem.set(row.source_item_id, perItem);
    }
    return rows.map((row) => {
      const normalizedText = normalizeRepostText(row.raw_text);
      let payload: unknown = {};
      try { payload = JSON.parse(row.raw_payload_json || '{}'); } catch { /* raw payload remains available */ }
      return {
        ...row, normalizedText, tokens: tokenize(normalizedText), trigrams: trigrams(normalizedText),
        textFingerprint: crypto.createHash('sha256').update(normalizedText).digest('hex'),
        authorKey: canonicalAuthor(row), identifiers: identifiersByItem.get(row.id) ?? new Map(),
        mediaUrls: collectMediaUrls(payload),
      };
    });
  }

  private createReport(algorithmVersion:string,dryRun:boolean,items:Item[],supply:Item[],demand:Item[],supplyResult:ReturnType<RepostClusteringService['clusterEntity']>,demandResult:ReturnType<RepostClusteringService['clusterEntity']>,clusters:ClusterResult[],idByKey:Map<string,number>):RepostClusterReport{
    const summary = (entity: EntityType, entityItems: Item[], entityClusters: ClusterResult[], diagnostics: PairEvaluation[]): RepostClusterReport['entities'][EntityType] => {
      const multi = entityClusters.filter((cluster) => cluster.members.length > 1);
      const clustersByMethod: Record<string, number> = {};
      for (const cluster of multi) clustersByMethod[cluster.method] = (clustersByMethod[cluster.method] ?? 0) + 1;
      return {
        sourceItems: entityItems.length,
        clusters: entityClusters.length,
        singletonClusters: entityClusters.length - multi.length,
        multiMemberClusters: multi.length,
        postsCollapsed: entityItems.length - entityClusters.length,
        largestClusterSize: Math.max(0, ...entityClusters.map((cluster) => cluster.members.length)),
        crossGroupClusters: multi.filter((cluster) => new Set(cluster.members.map((member) => member.group_id ?? member.group_name ?? '')).size > 1).length,
        crossSourceTypeClusters: multi.filter((cluster) => new Set(cluster.members.map((member) => member.source_type)).size > 1).length,
        clustersByMethod,
      };
    };
    const supplyAccepted = supplyResult.accepted;
    const demandAccepted = demandResult.accepted;
    const nearThresholdPairs = [...supplyResult.nearThreshold, ...demandResult.nearThreshold]
      .sort((a, b) => b.score - a.score).slice(0, 20);
    const sameAgentExamples = supplyResult.sameAgent
      .sort((a, b) => b.score - a.score).slice(0, 12);
    const reportClusters = clusters
      .sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key))
      .map((cluster) => this.toReportCluster(cluster, idByKey.get(cluster.key) ?? null,
        [...supplyAccepted, ...demandAccepted]));
    const autoClusterPairs = [...supplyAccepted, ...demandAccepted]
      .sort((a, b) => b.confidence - a.confidence)
      .filter((pair, index, all) => all.findIndex((other) => pairKey(other.left, other.right) === pairKey(pair.left, pair.right)) === index)
      .slice(0, 40)
      .map((pair) => this.toPairDiagnostic(pair, 'clustered'));
    const nonExactHashPairs = [...supplyAccepted, ...demandAccepted]
      .filter((pair) => pair.left.content_hash !== pair.right.content_hash)
      .sort((a, b) => b.confidence - a.confidence || pairKey(a.left, a.right).localeCompare(pairKey(b.left, b.right)))
      .map((pair) => this.toPairDiagnostic(pair, 'clustered'));
    const indexedSignalCount = supplyResult.indexedSignalCount + demandResult.indexedSignalCount;
    return {
      algorithmVersion, config: this.config, dryRun, sourceItemCount: items.length,
      candidatePairCount: supplyResult.candidatePairCount + demandResult.candidatePairCount,
      indexedSignalCount,
      entities: {
        SUPPLY_REPOST: summary('SUPPLY_REPOST', supply, supplyResult.clusters, supplyAccepted),
        DEMAND_REPOST: summary('DEMAND_REPOST', demand, demandResult.clusters, demandAccepted),
      },
      ambiguousNotClustered: supplyResult.clusters.filter((cluster) => cluster.members.length === 1).length + supplyResult.nearThreshold.length,
      nearThresholdPairCount: supplyResult.nearThreshold.length + demandResult.nearThreshold.length,
      clusters: reportClusters.slice(0, 20),
      autoClusterPairs,
      nonExactHashPairs,
      nearThresholdPairs,
      sameAgentExamples,
      persistedClusterCount: dryRun ? undefined : clusters.length,
    };
  }

  private clusterEntity(entityType: EntityType, items: Item[]): {
    clusters: ClusterResult[]; accepted: Array<Candidate & PairEvaluation>;
    nearThreshold: RepostClusterPairDiagnostic[]; sameAgent: RepostClusterPairDiagnostic[];
    candidatePairCount: number; indexedSignalCount: number;
  } {
    const candidates = new Map<string, Candidate>();
    let indexedSignalCount = 0;
    const addBucket = (signal: string, values: Item[]) => {
      const unique = [...new Map(values.map((item) => [item.id, item])).values()].sort((a, b) => a.id - b.id);
      if (unique.length < 2) return;
      indexedSignalCount++;
      // A star retrieval is linear in bucket size and avoids quadratic scans on shared agent contacts.
      const pivot = unique[0]!;
      for (let i = 1; i < unique.length; i++) {
        const other = unique[i]!;
        const key = pairKey(pivot, other);
        const candidate = candidates.get(key) ?? { left: pivot, right: other, retrievedBy: new Set<string>() };
        candidate.retrievedBy.add(signal);
        candidates.set(key, candidate);
      }
    };
    const index = new Map<string, Item[]>();
    const put = (key: string, item: Item) => {
      const bucket = index.get(key) ?? [];
      bucket.push(item);
      index.set(key, bucket);
    };
    for (const item of items) {
      if (item.raw_text?.trim() && item.content_hash) put(`hash:${item.content_hash}`, item);
      if (item.normalizedText && item.tokens.size >= 3) put(`fingerprint:${item.textFingerprint}`, item);
      const sourceUrl = canonicalUrl(item.canonical_url) ?? canonicalUrl(item.source_url);
      if (sourceUrl) put(`url:${sourceUrl}`, item);
      if (item.authorKey) put(`author:${item.authorKey}`, item);
      for (const [type, values] of item.identifiers) {
        for (const value of values) put(`identifier:${type}:${value}`, item);
      }
      for (const token of item.tokens) {
        if (/^\d+$/.test(token) && token.length < 3) continue;
        put(`token:${token}`, item);
      }
    }
    const maxTokenFrequency = Math.max(8, Math.ceil(items.length * 0.12));
    for (const [key, bucket] of index) {
      if (key.startsWith('token:') && bucket.length > Math.min(maxTokenFrequency, this.config.maxTextPostingFrequency)) continue;
      if (key.startsWith('author:') && bucket.length > 80) {
        // Keep author as an indexable retrieval signal, but bound work for generic/high-volume identities.
        const slices: Item[][] = [];
        for (let i = 0; i < bucket.length; i += 80) slices.push(bucket.slice(i, i + 80));
        for (const slice of slices) addBucket(key, slice);
      } else addBucket(key, bucket);
    }

    const union = new UnionFind();
    for (const item of items) union.find(item.id);
    const accepted: Array<Candidate & PairEvaluation> = [];
    const nearThreshold: RepostClusterPairDiagnostic[] = [];
    const sameAgent: RepostClusterPairDiagnostic[] = [];
    for (const candidate of candidates.values()) {
      const evaluation = entityType === 'SUPPLY_REPOST'
        ? this.evaluateSupply(candidate.left, candidate.right, candidate.retrievedBy)
        : this.evaluateDemand(candidate.left, candidate.right, candidate.retrievedBy);
      if (evaluation.accepted) {
        union.union(candidate.left.id, candidate.right.id);
        accepted.push({ ...candidate, ...evaluation });
      } else if (evaluation.similarity >= 0.66) {
        nearThreshold.push(this.toPairDiagnostic({ ...candidate, ...evaluation }, 'near_threshold'));
      }
      if (entityType === 'SUPPLY_REPOST' && !evaluation.accepted && evaluation.sharedIdentifiers.some((id) => id.startsWith('PHONE:')) && evaluation.similarity < this.config.contactAuthorTextSimilarity) {
        sameAgent.push(this.toPairDiagnostic({ ...candidate, ...evaluation }, 'same_agent_different_text'));
      }
    }

    const membersByRoot = new Map<number, Item[]>();
    for (const item of items) {
      const root = union.find(item.id);
      const members = membersByRoot.get(root) ?? [];
      members.push(item);
      membersByRoot.set(root, members);
    }
    const clusters: ClusterResult[] = [];
    for (const members of membersByRoot.values()) {
      members.sort((a, b) => a.id - b.id);
      const representative = [...members].sort((a, b) => this.compareRepresentative(a, b))[0]!;
      const memberIds = members.map((item) => item.id);
      const key = crypto.createHash('sha256').update(`${entityType}|${memberIds.join(',')}`).digest('hex');
      const memberEdges = accepted.filter((edge) => memberIds.includes(edge.left.id) && memberIds.includes(edge.right.id));
      const reasons = [...new Set(memberEdges.flatMap((edge) => edge.reasons))].sort();
      const method = this.primaryMethod(memberEdges);
      const confidence = memberEdges.length ? memberEdges.reduce((sum, edge) => sum + edge.confidence, 0) / memberEdges.length : 0;
      clusters.push({ entityType, key, members, representative, confidence, method, reasons });
    }
    clusters.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
    return { clusters, accepted, nearThreshold, sameAgent, candidatePairCount: candidates.size, indexedSignalCount };
  }

  private compareRepresentative(a: Item, b: Item): number {
    const textLength = (b.raw_text ?? '').trim().length - (a.raw_text ?? '').trim().length;
    if (textLength) return textLength;
    const identifierCount = [...b.identifiers.values()].reduce((sum, values) => sum + values.size, 0)
      - [...a.identifiers.values()].reduce((sum, values) => sum + values.size, 0);
    if (identifierCount) return identifierCount;
    if (b.mediaUrls.length !== a.mediaUrls.length) return b.mediaUrls.length - a.mediaUrls.length;
    const aDate = a.published_at ? Date.parse(a.published_at) : Number.POSITIVE_INFINITY;
    const bDate = b.published_at ? Date.parse(b.published_at) : Number.POSITIVE_INFINITY;
    if (aDate !== bDate) return aDate - bDate;
    return a.id - b.id;
  }

  private evaluateSupply(a: Item, b: Item, retrievedBy: Set<string>): PairEvaluation {
    const tokenJaccard = jaccard(a.tokens, b.tokens);
    const trigramDice = dice(a.trigrams, b.trigrams);
    const similarity = 0.7 * tokenJaccard + 0.3 * trigramDice;
    const sharedIdentifiers: string[] = [];
    const sharedByType = new Map<IdentifierType, string[]>();
    for (const [type, values] of a.identifiers) {
      const other = b.identifiers.get(type);
      if (!other) continue;
      const shared = [...values].filter((value) => other.has(value));
      if (shared.length) {
        sharedByType.set(type, shared);
        for (const value of shared) sharedIdentifiers.push(`${type}:${value}`);
      }
    }
    const sameAuthor = Boolean(a.authorKey && a.authorKey === b.authorKey);
    const sameHash = Boolean(a.content_hash && a.content_hash === b.content_hash && a.normalizedText.length > 0);
    const sameFingerprint = a.textFingerprint === b.textFingerprint && a.tokens.size >= 3;
    const aUrl = canonicalUrl(a.canonical_url) ?? canonicalUrl(a.source_url);
    const bUrl = canonicalUrl(b.canonical_url) ?? canonicalUrl(b.source_url);
    const sameUrl = Boolean(aUrl && aUrl === bUrl);
    const codes = [...(sharedByType.get('PROPERTY_CODE') ?? [])];
    const contacts = ['PHONE','TELEGRAM','WHATSAPP','EMAIL'] as IdentifierType[];
    const sharedContactCount = contacts.reduce((count, type) => count + (sharedByType.get(type)?.length ?? 0), 0);
    const hasPropertyReference = (sharedByType.get('PROPERTY_CODE')?.length ?? 0) > 0;
    const hasMapsReference = (sharedByType.get('MAPS_URL')?.length ?? 0) > 0
      || (sharedByType.get('MAPS_PLACE_ID')?.length ?? 0) > 0;
    const hasIndependentSupportingSignal = sharedContactCount > 0 || (sharedByType.get('AGENCY_CODE')?.length ?? 0) > 0;
    // Multiple contact values, or author plus contact, can still describe one active agent.
    // Require a property/map reference before counting identifier families as repost evidence.
    const multipleIds = sharedIdentifiers.length >= 2
      && ((hasPropertyReference && (sharedContactCount > 0 || hasMapsReference))
        || (hasMapsReference && hasIndependentSupportingSignal));
    const reasons: string[] = [];
    let method = 'none';
    let confidence = similarity;
    let threshold: number | undefined;
    if (sameHash && a.tokens.size >= 2) {
      reasons.push('same content_hash'); method = 'content_hash'; confidence = 1;
    } else if (sameUrl && similarity >= 0.55 && a.tokens.size >= 3) {
      reasons.push('same canonical/source URL', `text_similarity=${similarity.toFixed(2)}`);
      method = 'source_url'; confidence = Math.max(0.97, similarity);
    } else if (sameFingerprint && a.normalizedText.length >= 25) {
      reasons.push('same normalized text fingerprint', `text_similarity=${similarity.toFixed(2)}`);
      method = 'text_fingerprint'; confidence = Math.max(0.97, similarity);
    } else if (codes.length && similarity >= this.config.propertyCodeTextSimilarity) {
      reasons.push(`same property code ${codes.join(', ')}`, `text_similarity=${similarity.toFixed(2)}`);
      method = 'property_code'; threshold = this.config.propertyCodeTextSimilarity; confidence = Math.min(0.99, 0.72 + 0.28 * similarity);
    } else if (multipleIds && similarity >= this.config.multipleIdentifierTextSimilarity) {
      reasons.push(`shared ${sharedIdentifiers.length} deterministic identifiers`, `text_similarity=${similarity.toFixed(2)}`);
      method = 'multiple_identifiers'; threshold = this.config.multipleIdentifierTextSimilarity; confidence = Math.min(0.98, 0.68 + 0.30 * similarity);
    } else if ((sameAuthor || sharedContactCount > 0) && similarity >= this.config.contactAuthorTextSimilarity && a.tokens.size >= 5) {
      if (sameAuthor) reasons.push('same author identity');
      if (sharedContactCount) reasons.push('same contact identifier');
      reasons.push(`text_similarity=${similarity.toFixed(2)}`);
      method = sameAuthor ? 'author_text' : 'contact_text';
      threshold = this.config.contactAuthorTextSimilarity; confidence = Math.min(0.97, 0.70 + 0.30 * similarity);
    } else if (similarity >= this.config.textOnlySimilarity && a.tokens.size >= 6) {
      reasons.push(`text_similarity=${similarity.toFixed(2)}`, 'high text-only similarity');
      method = 'text_only'; threshold = this.config.textOnlySimilarity; confidence = similarity;
    }
    // Agency code or one agent phone/Telegram is retrieval only; never enough by itself.
    if (method !== 'none' && sharedByType.has('AGENCY_CODE') && !codes.length && !sameHash && !sameFingerprint && !sameUrl) {
      if (sharedIdentifiers.length < 2 || similarity < this.config.multipleIdentifierTextSimilarity) {
        reasons.length = 0; method = 'none'; confidence = similarity; threshold = this.config.multipleIdentifierTextSimilarity;
      }
    }
    return { accepted: method !== 'none', confidence, similarity, tokenJaccard, trigramDice, reasons, method, threshold, sharedIdentifiers };
  }

  private evaluateDemand(a: Item, b: Item, _retrievedBy: Set<string>): PairEvaluation {
    const tokenJaccard = jaccard(a.tokens, b.tokens);
    const trigramDice = dice(a.trigrams, b.trigrams);
    const similarity = 0.7 * tokenJaccard + 0.3 * trigramDice;
    const sharedIdentifiers: string[] = [];
    for (const [type, values] of a.identifiers) {
      const other = b.identifiers.get(type);
      if (other) for (const value of values) if (other.has(value)) sharedIdentifiers.push(`${type}:${value}`);
    }
    const sameAuthor = Boolean(a.authorKey && a.authorKey === b.authorKey);
    const contactTypes: IdentifierType[] = ['PHONE','TELEGRAM','WHATSAPP','EMAIL'];
    const sameContact = sharedIdentifiers.some((value) => contactTypes.some((type) => value.startsWith(`${type}:`)));
    const urlA = canonicalUrl(a.canonical_url) ?? canonicalUrl(a.source_url);
    const urlB = canonicalUrl(b.canonical_url) ?? canonicalUrl(b.source_url);
    const sameUrl = Boolean(urlA && urlA === urlB);
    const dateA = a.published_at ? Date.parse(a.published_at) : Number.NaN;
    const dateB = b.published_at ? Date.parse(b.published_at) : Number.NaN;
    const timeDeltaHours = Number.isFinite(dateA) && Number.isFinite(dateB) ? Math.abs(dateA - dateB) / 3_600_000 : null;
    const closeInTime = timeDeltaHours !== null && timeDeltaHours <= this.config.demandWindowHours;
    const sameIdentity = sameAuthor || sameContact;
    const accepted = (sameUrl && similarity >= 0.55)
      || (sameIdentity && closeInTime && similarity >= this.config.demandTextSimilarity && a.tokens.size >= 5);
    const reasons: string[] = [];
    let method = 'none';
    if (sameUrl && similarity >= 0.55) { reasons.push('same canonical/source URL'); method = 'source_url'; }
    else if (accepted) {
      if (sameAuthor) reasons.push('same author identity');
      if (sameContact) reasons.push('same contact identifier');
      reasons.push(`text_similarity=${similarity.toFixed(2)}`, `published_within_${Math.round(timeDeltaHours!)}h`);
      method = 'identity_text_time';
    }
    if (accepted) reasons.push('demand identity safeguards passed');
    return { accepted, confidence: accepted ? Math.min(0.97, 0.72 + 0.28 * similarity) : similarity,
      similarity, tokenJaccard, trigramDice, reasons, method,
      threshold: method === 'identity_text_time' ? this.config.demandTextSimilarity : 0.55,
      timeDeltaHours, sharedIdentifiers };
  }

  private primaryMethod(edges: Array<PairEvaluation>): string {
    if (!edges.length) return 'singleton';
    const counts = new Map<string, number>();
    for (const edge of edges) counts.set(edge.method, (counts.get(edge.method) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  }

  private toPairDiagnostic(pair: Candidate & PairEvaluation, status: RepostClusterPairDiagnostic['status']): RepostClusterPairDiagnostic {
    const sharedPhones = pair.sharedIdentifiers.filter((value) => value.startsWith('PHONE:')).map((value) => value.slice('PHONE:'.length));
    const sharedCodes = pair.sharedIdentifiers.filter((value) => value.startsWith('PROPERTY_CODE:') || value.startsWith('AGENCY_CODE:'))
      .map((value) => value.slice(value.indexOf(':') + 1));
    return {
      leftId: pair.left.id, rightId: pair.right.id,
      leftGroup: pair.left.group_name ?? pair.left.group_id, rightGroup: pair.right.group_name ?? pair.right.group_id,
      leftAuthor: pair.left.author_name, rightAuthor: pair.right.author_name,
      leftSnippet: shortText(pair.left), rightSnippet: shortText(pair.right),
      score: Number(pair.similarity.toFixed(4)), reasons: pair.reasons,
      confidence: Number(pair.confidence.toFixed(4)), method: pair.method,
      sharedPhones, sharedCodes, status,
    };
  }

  private toReportCluster(cluster: ClusterResult, id: number | null, accepted: Array<Candidate & PairEvaluation>): RepostClusterReport['clusters'][number] {
    const memberDetails = cluster.members.map((member) => {
      if (member.id === cluster.representative.id) return { sourceItemId: member.id, score: 1, reason: 'representative selected by deterministic completeness order', details: { representative: true } };
      const edge = accepted.filter((pair) => (pair.left.id === member.id || pair.right.id === member.id)
        && cluster.members.some((entry) => entry.id === (pair.left.id === member.id ? pair.right.id : pair.left.id)))
        .sort((a, b) => b.confidence - a.confidence)[0];
      return {
        sourceItemId: member.id,
        score: edge?.confidence ?? cluster.confidence,
        reason: edge?.reasons.join('; ') || cluster.reasons.join('; ') || 'clustered by connected repost evidence',
        details: edge ? { method: edge.method, textSimilarity: edge.similarity, tokenJaccard: edge.tokenJaccard,
          trigramDice: edge.trigramDice, threshold: edge.threshold ?? null, sharedIdentifiers: edge.sharedIdentifiers,
          retrievedBy: [...edge.retrievedBy] } : { method: cluster.method },
      };
    });
    const identifiers = cluster.members.flatMap((member) => [...member.identifiers.entries()].flatMap(([type, values]) =>
      [...values].map((value) => ({ type, value }))));
    return {
      clusterId: id ?? `${cluster.entityType}:${cluster.key.slice(0, 12)}`,
      clusterKey: cluster.key,
      entityType: cluster.entityType,
      members: cluster.members.length,
      groups: [...new Set(cluster.members.map((item) => item.group_name ?? item.group_id ?? 'unknown'))].sort(),
      sourceTypes: [...new Set(cluster.members.map((item) => item.source_type))].sort(),
      authors: [...new Set(cluster.members.map((item) => item.author_name).filter((name): name is string => Boolean(name)))].sort(),
      propertyCodes: [...new Set(identifiers.filter((entry) => entry.type === 'PROPERTY_CODE').map((entry) => entry.value))].sort(),
      phones: [...new Set(identifiers.filter((entry) => entry.type === 'PHONE').map((entry) => entry.value))].sort(),
      confidence: Number(cluster.confidence.toFixed(4)), method: cluster.method, reasons: cluster.reasons,
      representativeSourceItemId: cluster.representative.id,
      representativeText: shortText(cluster.representative),
      memberDetails,
    };
  }

  private persist(clusters: ClusterResult[], algorithmVersion: string, rebuild: boolean): void {
    this.db.exec('SAVEPOINT repost_cluster_build');
    try {
      const existing = this.db.prepare(`SELECT id FROM dedupe_clusters WHERE algorithm_version=? AND entity_type IN ('SUPPLY_REPOST','DEMAND_REPOST')`).all(algorithmVersion) as Array<{ id: number }>;
      const deleteMembers = this.db.prepare('DELETE FROM dedupe_cluster_members WHERE cluster_id=?');
      for (const row of existing) deleteMembers.run(row.id);
      if (rebuild) {
        const deleteCluster = this.db.prepare('DELETE FROM dedupe_clusters WHERE id=?');
        for (const row of existing) deleteCluster.run(row.id);
      }
      const upsertCluster = this.db.prepare(`
        INSERT INTO dedupe_clusters (entity_type, algorithm_version, cluster_key, confidence, representative_source_item_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, algorithm_version, cluster_key) DO UPDATE SET
          confidence=excluded.confidence,
          representative_source_item_id=excluded.representative_source_item_id,
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      `);
      const selectCluster = this.db.prepare('SELECT id FROM dedupe_clusters WHERE entity_type=? AND algorithm_version=? AND cluster_key=?');
      const insertMember = this.db.prepare(`
        INSERT INTO dedupe_cluster_members (cluster_id, source_item_id, score, reason, details_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(cluster_id, source_item_id) DO UPDATE SET score=excluded.score, reason=excluded.reason, details_json=excluded.details_json
      `);
      const liveKeys = new Set<string>();
      for (const cluster of clusters) {
        liveKeys.add(`${cluster.entityType}:${cluster.key}`);
        upsertCluster.run(cluster.entityType, algorithmVersion, cluster.key, cluster.confidence || null, cluster.representative.id);
        const row = selectCluster.get(cluster.entityType, algorithmVersion, cluster.key) as { id: number };
        const memberDetails = this.clusterMemberDetails(cluster);
        for (const member of cluster.members) {
          const detail = memberDetails.get(member.id)!;
          insertMember.run(row.id, member.id, detail.score, detail.reason, JSON.stringify(detail.details));
        }
      }
      const stale = this.db.prepare(`SELECT id, entity_type, cluster_key FROM dedupe_clusters WHERE algorithm_version=? AND entity_type IN ('SUPPLY_REPOST','DEMAND_REPOST')`).all(algorithmVersion) as Array<{ id: number; entity_type: EntityType; cluster_key: string | null }>;
      const deleteCluster = this.db.prepare('DELETE FROM dedupe_clusters WHERE id=?');
      for (const row of stale) {
        if (!liveKeys.has(`${row.entity_type}:${row.cluster_key}`)) deleteCluster.run(row.id);
      }
      this.db.exec('RELEASE repost_cluster_build');
    } catch (error) {
      this.db.exec('ROLLBACK TO repost_cluster_build');
      this.db.exec('RELEASE repost_cluster_build');
      throw error;
    }
  }

  private clusterMemberDetails(cluster: ClusterResult): Map<number, { score: number; reason: string; details: Record<string, unknown> }> {
    const result = new Map<number, { score: number; reason: string; details: Record<string, unknown> }>();
    const ids = new Set(cluster.members.map((item) => item.id));
    const pairs = this.lastAcceptedPairs.filter((pair) => ids.has(pair.left.id) && ids.has(pair.right.id));
    for (const item of cluster.members) {
      if (item.id === cluster.representative.id) {
        result.set(item.id, { score: 1, reason: 'representative selected deterministically', details: { representative: true } });
        continue;
      }
      const edge = pairs.filter((pair) => pair.left.id === item.id || pair.right.id === item.id)
        .sort((a, b) => b.confidence - a.confidence)[0];
      result.set(item.id, {
        score: edge?.confidence ?? cluster.confidence,
        reason: edge?.reasons.join('; ') || cluster.reasons.join('; ') || 'same repost component',
        details: edge ? { method: edge.method, similarity: edge.similarity, tokenJaccard: edge.tokenJaccard,
          trigramDice: edge.trigramDice, threshold: edge.threshold ?? null, sharedIdentifiers: edge.sharedIdentifiers,
          retrievedBy: [...edge.retrievedBy] } : { method: cluster.method },
      });
    }
    return result;
  }

  private lastAcceptedPairs: Array<Candidate & PairEvaluation> = [];
}
