import type { DatabaseSync } from 'node:sqlite';
import type { CityKey } from '../../config/settings';
import { canonicalizeLocation, extractCoordinatesFromMapsUrl } from '../../config/locations';
import type { Property, PropertyFilterOptions } from './properties.repo';

type CanonicalRow = Record<string, unknown>;
type ReadStats = { queryCount: number; candidateCount: number; sqlMs: number; mappingMs: number; totalMs: number };

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}
function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function stringList(value: unknown): string[] { return jsonArray(value).filter((entry): entry is string => typeof entry === 'string'); }
function nonEmpty(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }

const OUT_OF_AREA_TERMS = [
  'phnom penh','phnompenh','ភ្នំពេញ','kandal','kandal province','kandal district','kandal, cambodia','ខេត្តកណ្ដាល','kampot','kep',
  'sihanoukville','preah sihanouk','battambang','poipet','kampong cham','kampong thom','kampong speu',
  'kampong chhnang','koh kong','kratie','mondulkiri','ratanakiri','pursat','takeo','svay rieng','bavet',
  'stung treng','pailin','banteay meanchey','prey veng','tbong khmum','តាកែវ','បាត់ដំបង','ព្រះសីហនុ',
];
const EXPLICIT_TEXT_CITY_TERMS = ['phnom penh','phnompenh','ភ្នំពេញ','kandal','kandal province','kandal district','kandal, cambodia','ខេត្តកណ្ដាល','sihanoukville','preah sihanouk','takeo','តាកែវ','បាត់ដំបង','ព្រះសីហនុ'];
const SIEM_REAP_LOCAL_TERMS = ['wat bo','sala kamreuk','sala kamraeuk','svay dangkum','sla kram','chreav','chong kaosou','wat damnak','wat polanka','bakong','pradak','kandaek','phare circus','pub street','old market'];
const LIKE_ESCAPE = (value: string) => `%${value.toLowerCase().replace(/[!%_]/g,'!$&')}%`;

/** Read-only canonical projection. Filtering, ordering, counting and pagination are executed in SQLite. */
export class CanonicalListingRepository {
  lastDiagnostics: ReadStats = { queryCount: 2, candidateCount: 0, sqlMs: 0, mappingMs: 0, totalMs: 0 };
  constructor(private readonly db: DatabaseSync) {}

  searchProperties(options: PropertyFilterOptions = {}): { items: Property[]; total: number } {
    const started = performance.now();
    const { whereSql, params } = this.buildWhere(options);
    const from = this.fromSql();
    const sqlStarted = performance.now();
    const countRow = this.db.prepare(`SELECT COUNT(*) AS total ${from} ${whereSql}`).get(...params) as { total: number };
    const total = Number(countRow.total);
    const orderBy = options.sort === 'price_asc'
      ? 'ORDER BY l.price ASC, COALESCE(o.posted_at,o.last_seen_at,l.last_seen_at) DESC,l.id DESC'
      : options.sort === 'price_desc'
        ? 'ORDER BY l.price DESC, COALESCE(o.posted_at,o.last_seen_at,l.last_seen_at) DESC,l.id DESC'
        : 'ORDER BY COALESCE(o.posted_at,o.last_seen_at,l.last_seen_at) DESC,l.id DESC';
    const rentTier=this.rentTierSql(options);
    const cityTier=this.cityTierSql(options.city);
    const tierOrder = `${cityTier}='EXACT_CITY' DESC,${cityTier}='PROBABLE_CITY' DESC,CASE WHEN ${rentTier}='EXACT' THEN 0 WHEN ${rentTier}='PROBABLE' THEN 1 ELSE 2 END,`;
    const limit = Math.max(1, Math.min(options.limit ?? 20, 500));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = this.db.prepare(`SELECT ${this.projectionSql(false,options)} ${from} ${whereSql} ORDER BY ${tierOrder} ${orderBy.replace(/^ORDER BY /,'')} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as CanonicalRow[];
    const sqlMs = performance.now() - sqlStarted;
    const mappingStarted = performance.now();
    const items = rows.map((row) => this.toProperty(row, false));
    const mappingMs = performance.now() - mappingStarted;
    this.lastDiagnostics = { queryCount: 2, candidateCount: rows.length, sqlMs: +sqlMs.toFixed(2), mappingMs: +mappingMs.toFixed(2), totalMs: +(performance.now()-started).toFixed(2) };
    return { items, total };
  }

  explainSearch(options: PropertyFilterOptions = {}): Array<Record<string, unknown>> {
    const { whereSql, params } = this.buildWhere(options);
    return this.db.prepare(`EXPLAIN QUERY PLAN SELECT l.id ${this.fromSql()} ${whereSql}`).all(...params) as Array<Record<string, unknown>>;
  }

  getPropertyById(id: number, includeModerated = false): Property | undefined {
    const row = this.db.prepare(`SELECT ${this.projectionSql(true)} ${this.fromSql()}
      WHERE l.id=? AND l.status='active' AND COALESCE(l.availability_status,'unknown') NOT IN ('rented','removed')
        ${includeModerated ? '' : "AND EXISTS(SELECT 1 FROM canonical_listing_moderation m WHERE m.listing_id=l.id AND m.review_status='approved')"}
        AND s.classification='HOUSING_SUPPLY'
        AND lower(COALESCE(json_extract(l.listing_facts_json,'$.offer_type'),''))<>'sale'
        AND NOT (lower(COALESCE(json_extract(l.listing_facts_json,'$.offer_type'),'')) NOT IN ('rent','rent_or_sale','mixed','rent_and_sale','sale') AND ${this.saleLanguageSql()} AND NOT ${this.rentalLanguageSql()})
    `).get(id) as CanonicalRow | undefined;
    return row ? this.toProperty(row, true) : undefined;
  }

  private fromSql(): string {
    return `FROM canonical_listings l
      LEFT JOIN canonical_properties p ON p.id=l.property_id
      JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id AND o.is_current=1
      JOIN source_items s ON s.id=o.source_item_id
      LEFT JOIN source_registry sr ON sr.id=o.source_registry_id`;
  }

  private projectionSql(detail: boolean, options: PropertyFilterOptions = {}): string {
    const photoProjection = `(SELECT group_concat(photo_url,char(10)) FROM (
        SELECT photo_url FROM (
          SELECT ma.source_url AS photo_url, 0 AS source_order, ma.id AS item_order
          FROM media_asset_source_occurrences maso
          JOIN media_assets ma ON ma.id=maso.media_asset_id
          WHERE maso.listing_id=l.id AND maso.source_occurrence_id=o.id
          UNION ALL
          SELECT CASE WHEN raw_photo.type='text' THEN raw_photo.value
            ELSE COALESCE(json_extract(raw_photo.value,'$.url'),json_extract(raw_photo.value,'$.uri'),json_extract(raw_photo.value,'$.src')) END AS photo_url,
            1 AS source_order, CAST(raw_photo.key AS INTEGER) AS item_order
          FROM json_each(COALESCE(json_extract(s.raw_payload_json,'$.photos'),json_extract(s.raw_payload_json,'$.listing.photos'),
            json_extract(s.raw_payload_json,'$.image_urls'),json_extract(s.raw_payload_json,'$.images'),'[]')) raw_photo
        ) WHERE photo_url IS NOT NULL AND photo_url<>''
        GROUP BY photo_url ORDER BY MIN(source_order),MIN(item_order)
      ))`;
    return `l.*, p.latitude,p.longitude,p.property_type AS physical_property_type,p.canonical_address,
      p.explicit_location AS property_explicit_location,p.sangkat AS property_sangkat,
      COALESCE(NULLIF(l.city,''),NULLIF(p.city,'')) AS projection_city,
      o.id AS occurrence_id,o.source_item_id,o.source_registry_id,o.external_id,o.group_id,o.group_name,
      o.source_url AS occurrence_source_url,o.posted_at,o.last_seen_at AS occurrence_last_seen_at,o.last_checked_at,
      (SELECT review_status FROM canonical_listing_moderation m WHERE m.listing_id=l.id) AS review_status,
      s.source_type,s.classification,s.raw_text,s.canonical_url,s.source_url AS item_source_url,s.published_at,
      json_extract(l.listing_facts_json,'$.offer_type') AS offer_type,
      (${this.rentTierSql(options)}) AS match_tier,
      (${this.cityTierSql(options.city)}) AS city_tier,
      (${this.cityEvidenceSql(options.city)}) AS city_evidence,
      json_extract(l.listing_facts_json,'$.maps_urls[0]') AS facts_maps_url,
      json_extract(l.listing_facts_json,'$.electricity_rate') AS electricity_rate,
      json_extract(l.listing_facts_json,'$.water_rate') AS water_rate,
      json_extract(l.listing_facts_json,'$.landmarks') AS facts_landmarks,
      json_extract(l.listing_facts_json,'$.marketing_landmarks') AS facts_marketing_landmarks,
      COALESCE((SELECT group_concat(normalized_value,' / ') FROM source_item_identifiers si
        WHERE si.source_item_id=s.id AND si.type IN ('PHONE','WHATSAPP')),json_extract(s.raw_payload_json,'$.direct_contact.phone'),
        json_extract(s.raw_payload_json,'$.listing.phone')) AS contact_phone,
      (SELECT group_concat(normalized_value,' / ') FROM source_item_identifiers si
        WHERE si.source_item_id=s.id AND si.type='TELEGRAM') AS contact_telegram,
      ${photoProjection} AS occurrence_media
      ${detail ? ',s.raw_payload_json' : ''}`;
  }

  private buildWhere(options: PropertyFilterOptions): { whereSql: string; params: Array<string | number> } {
    const clauses = [
      "l.status='active'",
      "COALESCE(l.availability_status,'unknown') NOT IN ('rented','removed')",
      "s.classification='HOUSING_SUPPLY'",
    ];
    const params: Array<string | number> = [];
    if(options.reviewStatus==='all'&&options.includeInactive){}else if(options.reviewStatus){clauses.push('EXISTS(SELECT 1 FROM canonical_listing_moderation m WHERE m.listing_id=l.id AND m.review_status=?)');params.push(options.reviewStatus);}
    else clauses.push("EXISTS(SELECT 1 FROM canonical_listing_moderation m WHERE m.listing_id=l.id AND m.review_status='approved')");
    if (options.type !== 'sale') {
      const offer="lower(COALESCE(json_extract(l.listing_facts_json,'$.offer_type'),''))";
      clauses.push(`${offer}<>'sale'`);
      clauses.push(`NOT (${offer} NOT IN ('rent','rent_or_sale','mixed','rent_and_sale','sale') AND ${this.saleLanguageSql()} AND NOT ${this.rentalLanguageSql()})`);
    }
    if (options.city) {
      if (options.city === 'siem_reap') {
        const text="lower(COALESCE(l.title,'')||' '||COALESCE(l.description,'')||' '||COALESCE(s.raw_text,'')||' '||COALESCE(l.explicit_location,'')||' '||COALESCE(l.sangkat,'')||' '||COALESCE(p.explicit_location,'')||' '||COALESCE(p.sangkat,'')||' '||COALESCE(p.canonical_address,''))";
        const local=SIEM_REAP_LOCAL_TERMS.map((term)=>`${text} LIKE '%${term}%'`).join(' OR ');
        const explicitText=`(${text} LIKE '%siem reap%' OR ${text} LIKE '%siemreap%' OR ${text} LIKE '%សៀមរាប%')`;
        clauses.push(`(l.city='siem_reap' OR p.city='siem_reap' OR sr.city=? OR (${local}) OR ${explicitText})`); params.push(options.city);
        clauses.push(this.notOutOfAreaSql(params));
      }
      else if (options.city === 'phnom_penh') clauses.push(this.containsCitySql('phnom penh', params));
      else { clauses.push('(l.city=? OR p.city=? OR sr.city=?)'); params.push(options.city,options.city,options.city); }
    }
    // The Mini App currently asks only for rent. Unknown/zero prices cannot be represented by its DTO yet.
    if (options.type) {
      if (options.type !== 'rent') { clauses.push("json_extract(l.listing_facts_json,'$.offer_type')=?"); params.push(options.type); }
    }
    if (options.category) { clauses.push('l.category=?'); params.push(options.category); }
    if (options.minPrice !== undefined && options.minPrice >= 0) { clauses.push('(l.price IS NULL OR l.price<=0 OR l.price>=?)'); params.push(options.minPrice); }
    if (options.maxPrice !== undefined && options.maxPrice > 0) { clauses.push('(l.price IS NULL OR l.price<=0 OR l.price<=?)'); params.push(options.maxPrice); }
    if (options.bedrooms?.length) { clauses.push(`(l.bedrooms IN (${options.bedrooms.map(()=>'?').join(',')}) OR l.bedrooms IS NULL)`); params.push(...options.bedrooms); }
    if (options.bathrooms?.length) { clauses.push(`l.bathrooms IN (${options.bathrooms.map(()=>'?').join(',')})`); params.push(...options.bathrooms); }
    if (options.hasPool) clauses.push("json_extract(l.listing_facts_json,'$.has_pool')=1");
    if (options.petFriendly) clauses.push('l.pet_friendly=1');
    if (options.primaryLandmark) { clauses.push("EXISTS(SELECT 1 FROM json_each(l.listing_facts_json,'$.landmarks') WHERE lower(value)=lower(?))"); params.push(options.primaryLandmark); }
    if (options.minLeaseMax && options.minLeaseMax > 0) { clauses.push('l.min_lease_months IS NOT NULL AND l.min_lease_months<=?'); params.push(options.minLeaseMax); }
    if (options.locations?.length) {
      const or = options.locations.map(() => `(l.sangkat LIKE ? OR l.explicit_location LIKE ? OR p.sangkat LIKE ? OR p.explicit_location LIKE ? OR p.canonical_address LIKE ?)`);
      clauses.push(`(${or.join(' OR ')})`);
      for (const location of options.locations) { const pattern=LIKE_ESCAPE(location); params.push(pattern,pattern,pattern,pattern,pattern); }
    }
    if (options.query?.trim()) {
      const pattern=LIKE_ESCAPE(options.query.trim());
      clauses.push("(lower(l.title) LIKE ? ESCAPE '!' OR lower(l.description) LIKE ? ESCAPE '!' OR lower(COALESCE(l.explicit_location,l.sangkat,p.canonical_address,'')) LIKE ? ESCAPE '!')");
      params.push(pattern,pattern,pattern);
    }
    return { whereSql:`WHERE ${clauses.join(' AND ')}`, params };
  }

  private notOutOfAreaSql(params: Array<string | number>): string {
    const locationText = "lower(COALESCE(l.city,'')||' '||COALESCE(p.city,'')||' '||COALESCE(l.explicit_location,'')||' '||COALESCE(p.explicit_location,'')||' '||COALESCE(l.sangkat,'')||' '||COALESCE(p.sangkat,'')||' '||COALESCE(p.canonical_address,' ' )||' '||COALESCE(json_extract(l.listing_facts_json,'$.explicit_location'),''))";
    const factCity = "lower(replace(COALESCE(json_extract(l.listing_facts_json,'$.city'),''),'_',' '))";
    const title = "lower(COALESCE(l.title,''))";
    const rawText = "lower(COALESCE(s.raw_text,''))";
    const text = `(${title}||' '||${rawText})`;
    const explicitOutside = this.anyCityLike(locationText,params);
    const extractedOutside = this.anyCityLike(factCity,params);
    const textualOutside = EXPLICIT_TEXT_CITY_TERMS.map((city)=>{
      const p=city.replace(/'/g,"''");
      if (city.includes('province')||city.includes('district')||city.includes(',')||/[^\x00-\x7F]/.test(city)) return `${text} LIKE '%${p}%'`;
      return `(${text} LIKE '%located in ${p}%' OR ${text} LIKE '%location: ${p}%' OR ${text} LIKE '%in ${p}%' OR ${text} LIKE '%${p}, cambodia%')`;
    }).join(' OR ');
    const titleOutside=EXPLICIT_TEXT_CITY_TERMS.map((city)=>{
      const p=city.replace(/'/g,"''");
      if (city.includes('province')||city.includes('district')||city.includes(',')||/[^\x00-\x7F]/.test(city)) return `${title} LIKE '%${p}%'`;
      return `(${title} LIKE '%located in ${p}%' OR ${title} LIKE '%location: ${p}%' OR ${title} LIKE '%in ${p}%' OR ${title} LIKE '%${p}, cambodia%')`;
    }).join(' OR ');
    return `NOT (${explicitOutside} OR (${extractedOutside} AND lower(COALESCE(json_extract(l.listing_facts_json,'$.explicit_location'),'')) NOT LIKE '%siem reap%')
      OR (${titleOutside}) OR ((${textualOutside}) AND lower(COALESCE(l.explicit_location,p.explicit_location,l.sangkat,p.sangkat,'')) NOT LIKE '%siem reap%'
        AND lower(COALESCE(json_extract(l.listing_facts_json,'$.city'),'')) NOT LIKE '%siem reap%'))`;
  }

  private containsCitySql(city: string, params: Array<string | number>): string {
    const fields=["lower(COALESCE(l.explicit_location,''))","lower(COALESCE(l.sangkat,''))","lower(COALESCE(json_extract(l.listing_facts_json,'$.city'),''))"];
    return `(${fields.map((field)=>{params.push(`%${city}%`);return `${field} LIKE ?`;}).join(' OR ')})`;
  }

  private rentTextSql(): string {
    return "lower(COALESCE(l.title,'')||' '||COALESCE(l.description,'')||' '||COALESCE(s.raw_text,''))";
  }

  private rentalLanguageSql(): string {
    const text=this.rentTextSql();
    // Monthly installments can describe a sale. Require rental intent, not merely a recurring payment.
    return `(${text} LIKE '%for rent%' OR ${text} LIKE '%rental%' OR ${text} LIKE '% rent%' OR ${text} LIKE '%lease%' OR ${text} LIKE '%ជួល%')`;
  }

  private saleLanguageSql(): string {
    const text=this.rentTextSql();
    return `(${text} LIKE '%for sale%' OR ${text} LIKE '%selling%' OR ${text} LIKE '% sale%' OR ${text} LIKE '% sell%' OR ${text} LIKE '%លក់%')`;
  }

  private rentTierSql(options: PropertyFilterOptions = {}): string {
    const offer="lower(COALESCE(json_extract(l.listing_facts_json,'$.offer_type'),''))";
    const offerTier=`CASE WHEN ${offer}='rent' THEN 'EXACT' WHEN ${offer} IN ('rent_or_sale','mixed','rent_and_sale') OR ${this.rentalLanguageSql()} THEN 'PROBABLE' ELSE 'UNKNOWN' END`;
    const filterUnknown=(options.minPrice!==undefined||options.maxPrice!==undefined?' OR l.price IS NULL OR l.price<=0':'')+(options.bedrooms?.length?' OR l.bedrooms IS NULL':'');
    return filterUnknown?`CASE WHEN (${offerTier})='UNKNOWN' THEN 'UNKNOWN' WHEN (${offerTier})='PROBABLE'${filterUnknown} THEN 'PROBABLE' WHEN (${filterUnknown.replace(/^ OR /,'')}) THEN 'PROBABLE' ELSE 'EXACT' END`:offerTier;
  }

  private cityTierSql(city?: CityKey): string {
    if(!city)return 'NULL';
    const key=city.replace(/'/g,"''");
    const text="lower(COALESCE(l.title,'')||' '||COALESCE(l.description,'')||' '||COALESCE(s.raw_text,'')||' '||COALESCE(l.explicit_location,'')||' '||COALESCE(l.sangkat,'')||' '||COALESCE(p.explicit_location,'')||' '||COALESCE(p.sangkat,'')||' '||COALESCE(p.canonical_address,''))";
    if(city==='siem_reap'){
      const structured="lower(COALESCE(l.explicit_location,'')||' '||COALESCE(l.sangkat,'')||' '||COALESCE(p.explicit_location,'')||' '||COALESCE(p.sangkat,'')||' '||COALESCE(p.canonical_address,'')||' '||COALESCE(json_extract(l.listing_facts_json,'$.explicit_location'),''))";
      const body="lower(COALESCE(l.title,'')||' '||COALESCE(l.description,'')||' '||COALESCE(s.raw_text,''))";
      const exactText=`(${structured} LIKE '%siem reap%' OR ${structured} LIKE '%siemreap%' OR ${body} LIKE '%in siem reap%' OR ${body} LIKE '%located in siem reap%' OR ${body} LIKE '%location: siem reap%' OR ${body} LIKE '%សៀមរាប%')`;
      const local=SIEM_REAP_LOCAL_TERMS.map((term)=>`${text} LIKE '%${term}%'`).join(' OR ');
      return `CASE WHEN l.city='${key}' OR p.city='${key}' OR ${exactText} THEN 'EXACT_CITY' WHEN sr.city='${key}' OR (${local}) THEN 'PROBABLE_CITY' ELSE 'UNKNOWN_CITY' END`;
    }
    const human=key.replace(/_/g,' ');
    return `CASE WHEN l.city='${key}' OR p.city='${key}' OR ${text} LIKE '%${human}%' THEN 'EXACT_CITY' WHEN sr.city='${key}' THEN 'PROBABLE_CITY' ELSE 'UNKNOWN_CITY' END`;
  }

  private cityEvidenceSql(city?: CityKey): string {
    if (city !== 'siem_reap') return 'NULL';
    const text="lower(COALESCE(l.title,'')||' '||COALESCE(l.description,'')||' '||COALESCE(s.raw_text,'')||' '||COALESCE(l.explicit_location,'')||' '||COALESCE(l.sangkat,'')||' '||COALESCE(p.explicit_location,'')||' '||COALESCE(p.sangkat,'')||' '||COALESCE(p.canonical_address,''))";
    const local=SIEM_REAP_LOCAL_TERMS.map((term)=>`${text} LIKE '%${term}%'`).join(' OR ');
    return `CASE WHEN sr.city='siem_reap' AND NOT (${local}) AND COALESCE(l.city,'')<>'siem_reap' AND COALESCE(p.city,'')<>'siem_reap' THEN 'SOURCE_PRIOR_ONLY' ELSE 'LOCAL_EVIDENCE' END`;
  }

  private anyCityLike(field: string, params: Array<string | number>): string {
    return `(${OUT_OF_AREA_TERMS.map((city)=>{params.push(`%${city.toLowerCase()}%`);return `${field} LIKE ?`;}).join(' OR ')})`;
  }

  private toProperty(row: CanonicalRow, detail: boolean): Property {
    const facts=jsonObject(row.listing_facts_json); const raw=detail?jsonObject(row.raw_payload_json):{};
    const payloadListing=jsonObject(raw.listing); const payloadContacts=jsonObject(raw.direct_contact ?? payloadListing.direct_contact ?? raw.contact);
    const city=(nonEmpty(row.projection_city)??'siem_reap') as CityKey;
    const location=nonEmpty(row.explicit_location)??nonEmpty(row.sangkat)??nonEmpty(row.property_explicit_location)??nonEmpty(row.property_sangkat)??nonEmpty(row.canonical_address)??city;
    const media=typeof row.occurrence_media==='string'?row.occurrence_media.split('\n').filter(Boolean):[];
    const photos=media.length?media:detail
      ? stringList(raw.photos??payloadListing.photos??raw.image_urls??raw.images).length?stringList(raw.photos??payloadListing.photos??raw.image_urls??raw.images)
        :jsonArray(raw.photoAssets).map((p)=>typeof p==='string'?p:nonEmpty((p as Record<string,unknown>)?.url)).filter((p):p is string=>Boolean(p))
      :[];
    const phones=nonEmpty(row.contact_phone)??nonEmpty(payloadContacts.phone);
    const telegram=nonEmpty(row.contact_telegram)??nonEmpty(payloadContacts.telegram);
    const whatsapp=nonEmpty(payloadContacts.whatsapp);
    const contact={...(phones?{phone:phones}:{}),...(telegram?{telegram}:{}),...(whatsapp?{whatsapp}:{})};
    const mapsUrl=nonEmpty(row.facts_maps_url)??nonEmpty(facts.maps_url)??nonEmpty(raw.maps_url)??nonEmpty(payloadListing.maps_url);
    let latitude=row.latitude===null||row.latitude===undefined?null:Number(row.latitude);
    let longitude=row.longitude===null||row.longitude===undefined?null:Number(row.longitude);
    if((latitude===null||longitude===null)&&mapsUrl){const coords=extractCoordinatesFromMapsUrl(mapsUrl);if(coords){latitude=coords.latitude;longitude=coords.longitude;}}
    const title=nonEmpty(row.title)??'Property'; const description=nonEmpty(row.description)??'';
    const sourceUrl=nonEmpty(row.occurrence_source_url)??nonEmpty(row.item_source_url)??nonEmpty(row.canonical_url);
    const postedAt=nonEmpty(row.posted_at)??nonEmpty(row.published_at);
    const updatedAt=nonEmpty(row.occurrence_last_seen_at)??nonEmpty(row.last_seen_at)??'';
    const amenities=stringList(row.amenities).length?stringList(row.amenities):stringList(facts.discovered_amenities??facts.amenities);
    const restrictions=stringList(row.restrictions);
    const factsLandmarks=stringList(row.facts_landmarks??facts.landmarks);
    const marketing=stringList(row.facts_marketing_landmarks??facts.marketing_landmarks);
    const electricity=this.utilityFact(facts.electricity_type,facts.electricity_rate??row.electricity_rate);
    const water=this.utilityFact(facts.water_type,facts.water_rate??row.water_rate);
    const category=nonEmpty(row.category) as Property['category'];
    const offerType=nonEmpty(row.offer_type)??nonEmpty(facts.offer_type);
    const matchTier=row.match_tier==='EXACT'||row.match_tier==='PROBABLE'||row.match_tier==='UNKNOWN'?row.match_tier:undefined;
    const cityTier=row.city_tier==='EXACT_CITY'||row.city_tier==='PROBABLE_CITY'||row.city_tier==='UNKNOWN_CITY'?row.city_tier:undefined;
    return {
      id:Number(row.id),hash:nonEmpty(row.content_hash)??`canonical:${String(row.id)}`,title,description,price:Number(row.price),...(nonEmpty(row.public_ref)?{public_listing_ref:String(row.public_ref)}:{}),...(matchTier?{match_tier:matchTier}:{}),...(cityTier?{city_tier:cityTier}:{}),...(row.city_evidence==='LOCAL_EVIDENCE'||row.city_evidence==='SOURCE_PRIOR_ONLY'?{city_evidence:row.city_evidence}:{}),
      currency:row.currency==='KHR'?'KHR':'USD',type:offerType==='sale'?'sale':'rent',category,
      bedrooms:row.bedrooms===null?null:Number(row.bedrooms),bathrooms:row.bathrooms===null?null:Number(row.bathrooms),
      deposit:row.deposit_amount===null?null:Number(row.deposit_amount),min_lease:row.min_lease_months===null?null:Number(row.min_lease_months),
      has_pool:typeof facts.has_pool==='boolean'?facts.has_pool:null,location,location_key:canonicalizeLocation(location,city)?.key??null,raw_location:null,
      city,coordinate_precision:latitude!==null&&longitude!==null?'exact':location!==city?'district':'city',maps_url:mapsUrl,
      source_url:sourceUrl,photos,image_phash:null,image_phashes:[],direct_contact:contact,original_url:sourceUrl??'',reports_count:0,is_active:1,
      parsed_at:postedAt??updatedAt,posted_at:postedAt,updated_at:updatedAt,created_at:nonEmpty(row.created_at)??updatedAt,
      electricity,water,cleaning:nonEmpty(facts.cleaning),restrictions,pet_friendly:typeof facts.pet_friendly==='boolean'?facts.pet_friendly:null,
      landmarks:factsLandmarks,marketing_landmarks:marketing,raw_text:nonEmpty(row.raw_text),listing_facts_json:nonEmpty(row.listing_facts_json),
      parse_warnings:[],last_verified_at:nonEmpty(row.last_checked_at),latitude,longitude,
      property_type:nonEmpty(row.property_type)??nonEmpty(row.physical_property_type),amenities,
      ...(row.review_status==='approved'||row.review_status==='pending'||row.review_status==='rejected'?{review_status:row.review_status}:{}),
      // Canonical source listings do not have a legacy moderation state; leave it unknown.
    };
  }

  private utilityFact(kind: unknown, rate: unknown): string | null {
    if(kind==='included')return 'Included'; if(kind==='not_included')return 'Not included';
    if(kind==='state_rate')return 'EDC (State Rate)';
    if(kind==='fixed')return rate?`Fixed Rate (${String(rate)})`:'Fixed Rate';
    return null;
  }
}
