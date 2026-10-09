import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDatabase, closeDatabase } from '../src/database/db';
import { runMigrations } from '../src/database/migrate';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';
import { ListingIdentityRepository } from '../src/database/repositories/listing-identity.repo';
import { FavoritesRepository } from '../src/database/repositories/favorites.repo';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';
import { toMapMarkerDTO } from '../src/modules/api/dto';

const sourcePath=process.env.PHASE6A_DB??'data/rebuild/phase6a-checkpoint-20261007.db';
const previewPath=path.join(tmpdir(),`homeasy-phase6a3-audit-${crypto.randomUUID()}.db`);
async function main():Promise<void>{
  if(!existsSync(sourcePath))throw new Error(`Checkpoint not found: ${sourcePath}`);
  copyFileSync(sourcePath,previewPath);const db=createDatabase(previewPath);
  try{
    runMigrations(db);const legacyBefore=snapshotLegacyProperties(db);
    const canonical=new CanonicalListingRepository(db);const identity=new ListingIdentityRepository(db);const favorites=new FavoritesRepository(db);
    const moderation=db.prepare('SELECT listing_id,review_status,review_reason,decision_origin FROM canonical_listing_moderation').all() as Array<{listing_id:number;review_status:string;review_reason:string|null;decision_origin:string}>;
    db.exec("UPDATE canonical_listing_moderation SET review_status='approved'");
    const candidateResult=canonical.searchProperties({city:'siem_reap',type:'rent',limit:500});
    const candidates=candidateResult.items;
    const candidateIds=candidates.map((x)=>x.id);
    const rows=candidateIds.length?db.prepare(`SELECT l.id,l.public_ref,m.review_status,m.decision_origin,
      EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=l.id AND a.namespace='legacy_property_id') AS legacy_mapped
      FROM canonical_listings l LEFT JOIN canonical_listing_moderation m ON m.listing_id=l.id WHERE l.id IN (${candidateIds.map(()=>'?').join(',')})`).all(...candidateIds) as Array<{id:number;public_ref:string;review_status:string|null;decision_origin:string|null;legacy_mapped:number}>:[];
    const planned=new Map(moderation.map((x)=>[x.listing_id,x]));
    const visibility={totalCandidates:candidateResult.total,approved:0,pending:0,rejectedBlocked:0,missingModeration:0,
      legacyMapped:{total:0,visible:0,approved:0,pending:0,rejectedBlocked:0},canonicalOnly:{total:0,visible:0,approved:0,pending:0,rejectedBlocked:0},origins:{MIGRATED_LEGACY:0,EXPLICIT_CANONICAL:0,DEFAULT_PENDING:0,INGESTION_VALIDATED_V1:0}};
    for(const row of rows){const state=planned.get(row.id);const status=state?.review_status??'missing';const cohort=row.legacy_mapped?'legacyMapped':'canonicalOnly';visibility[cohort].total++;
      if(status==='approved'){visibility.approved++;visibility[cohort].approved++;visibility[cohort].visible++;}
      else if(status==='pending'){visibility.pending++;visibility[cohort].pending++;}
      else if(status==='rejected'){visibility.rejectedBlocked++;visibility[cohort].rejectedBlocked++;}
      else visibility.missingModeration++;
      if(state)visibility.origins[state.decision_origin as keyof typeof visibility.origins]++;
    }
    // Restore migration-planned state in this disposable copy and verify the actual public read.
    for(const state of moderation)db.prepare('UPDATE canonical_listing_moderation SET review_status=?,review_reason=?,decision_origin=? WHERE listing_id=?').run(state.review_status,state.review_reason,state.decision_origin,state.listing_id);
    const visible=canonical.searchProperties({city:'siem_reap',type:'rent',limit:500});
    const mapMarkers=visible.items.map(toMapMarkerDTO);
    const identityParity=visible.items.every((listing,index)=>{
      const marker=mapMarkers[index];const detail=canonical.getPropertyById(listing.id);
      return Boolean(listing.public_listing_ref&&listing.public_listing_ref===marker?.publicRef&&listing.public_listing_ref===detail?.public_listing_ref);
    });
    const legacyFavoriteCount=Number((db.prepare('SELECT COUNT(*) n FROM user_favorites').get() as {n:number}).n);
    const favoriteMap=identity.favoriteMigrationPreview();
    const mappedFavoriteRows=favoriteMap.reduce((n,x)=>n+x.legacyPropertyIds.length,0);
    const duplicateCollapseCases=favoriteMap.filter((x)=>x.legacyPropertyIds.length>1).length;
    const unmappedLegacyFavorites=legacyFavoriteCount-mappedFavoriteRows;
    const ambiguousFavoriteMappings=db.prepare(`SELECT COUNT(*) n FROM (SELECT uf.user_id,uf.property_id FROM user_favorites uf
      JOIN properties p ON p.id=uf.property_id JOIN canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
      JOIN canonical_listings l ON l.id=o.listing_id WHERE o.is_current=1 AND (p.original_url=s.canonical_url OR p.source_url=s.source_url)
      GROUP BY uf.user_id,uf.property_id HAVING COUNT(DISTINCT l.id)>1)`).get() as {n:number};
    const integerCollisions=db.prepare(`SELECT COUNT(*) n FROM user_favorites uf JOIN canonical_listings l ON l.id=uf.property_id`).get() as {n:number};
    const tracked=db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN listing_public_ref IS NOT NULL THEN 1 ELSE 0 END) newRefLinks,
      SUM(CASE WHEN listing_id IS NOT NULL THEN 1 ELSE 0 END) oldNumericLinks FROM tracked_links`).get() as {total:number;newRefLinks:number;oldNumericLinks:number};
    const oldTrackedResolution=db.prepare(`SELECT COUNT(*) n FROM tracked_links t JOIN canonical_listing_aliases a
      ON a.namespace='legacy_property_id' AND a.alias=CAST(t.listing_id AS TEXT) WHERE t.listing_id IS NOT NULL`).get() as {n:number};
    const legacyAfter=snapshotLegacyProperties(db);
    const report={generatedAt:new Date().toISOString(),mode:'isolated migration dry-run',checkpoint:sourcePath,visibility:{...visibility,visibleNow:visible.total,
        candidateCountObserved:rows.length,universeUnderModerationOff:candidates.length},favorites:{legacyFavorites:legacyFavoriteCount,mappedLegacyFavoriteRows:mappedFavoriteRows,
      mappedCanonicalFavorites:favoriteMap.length,unmappedLegacyFavorites,duplicateCollapseCases,ambiguousMappings:ambiguousFavoriteMappings.n,
        rawIntegerOverlapsWithCanonicalPk:integerCollisions.n,collisionsOrErrors:ambiguousFavoriteMappings.n,preview:favoriteMap},tracking:{...tracked,
        legacyNumericLinksResolvable:oldTrackedResolution.n,historyRewritten:false},identity:{canonicalListCount:visible.total,mapMarkers:mapMarkers.length,listMapDetailPublicRefsAgree:identityParity},
      legacy:{countBefore:legacyBefore.count,countAfter:legacyAfter.count,digestBefore:legacyBefore.digest,digestAfter:legacyAfter.digest,unchanged:legacyBefore.digest===legacyAfter.digest},
      policy:{conflictingLegacyModeration:'rejected wins; otherwise pending wins; all approved only when every mapped legacy decision is approved',canonicalOnly:'pending unless explicitly moderated'}};
    const out='reports/phase6a3-visibility-audit-20261007.json';writeFileSync(out,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({out,visibility:report.visibility,favorites:report.favorites,tracking:report.tracking,identity:report.identity,legacy:report.legacy},null,2));
  }finally{closeDatabase(db);try{unlinkSync(previewPath)}catch{/* disposable */}}
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.stack:String(error));process.exitCode=1;});
