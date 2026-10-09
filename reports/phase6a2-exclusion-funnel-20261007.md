# Phase 6A.2 — Search policy, source-city audit, and parity

Date: 2026-10-07. All audit scripts opened the checkpoint read-only. No source, canonical, or legacy rows were changed. No AI/provider requests were made. Production reads remain on `legacy`.

## The original Siem Reap cohort

The starting cohort is 220 active listings whose `listing.city` is Siem Reap. Every row has a current source occurrence and source item; all are `HOUSING_SUPPLY` with availability `unknown`. Five have strong out-of-area evidence and one has conflicting geography, leaving 214 geographically eligible rows.

| Offer tier | Count | Search treatment |
|---|---:|---|
| Exact rent | 80 | Include at the top |
| Probable rent | 98 | Include below exact |
| Unknown offer | 8 | Include in the lowest offer-confidence tier |
| Explicit sale or sale-only contradiction | 28 | Exclude from rent search |

The updated rental signal requires wording such as “for rent”, “rental”, “rent”, “lease”, or Khmer `ជួល`. Monthly payments alone do not imply a rental; this avoids treating sale financing as rent. This changes the unknown-offer text split to 86 rental signals, 12 mixed, 3 sale-only, and 8 unclear.

Unknown price and bedroom values remain eligible, but rank below exact filter matches. No-budget search shows missing price as “Price on request”.

## Audit of the 27 source-registry-only rows

The previous query returned 27 rows that were absent from the original cohort because their `listing.city` was null and `source_registry.city` was Siem Reap. The row-by-row, redacted report records listing/property city, source/group, locations, address, title, raw-text geography signals, source registry city, offer tier, and proposed city tier.

| Proposed city tier | Count among 27 | Interpretation |
|---|---:|---|
| `EXACT_CITY` | 1 | Raw post explicitly places the property in central Siem Reap and references Pub Street |
| `PROBABLE_CITY` | 26 | Local-area evidence and/or Siem Reap acquisition prior, never promoted to exact by registry alone |
| `UNKNOWN_CITY` | 0 | — |
| `CONTRADICTION_CITY` | 0 | — |
| `GEOGRAPHY_CONFLICT` | 0 | — |

No Phnom Penh, Kandal, or other explicit conflicting geography appears among these 27. Source registry city is now used only to include a candidate at `PROBABLE_CITY` confidence; it no longer populates the projected listing/property city. Exact city requires listing/property city or direct Siem Reap text/location evidence. Other-city evidence remains excluded; title/body conflicts remain held out.

## Broad Siem Reap query topology

The query now returns 213 candidates with city and offer confidence preserved separately:

| City tier | Exact rent | Probable rent | Unknown offer | Total |
|---|---:|---:|---:|---:|
| `EXACT_CITY` | 80 | 99 | 8 | 187 |
| `PROBABLE_CITY` | 0 | 25 | 1 | 26 |
| `UNKNOWN_CITY` | 0 | 0 | 0 | 0 |
| **Total returned** | **80** | **124** | **9** | **213** |

The original cohort still has 28 rent-search contradictions (explicit sale/sale-only) plus 5 definite out-of-area rows and one held geography conflict. No explicit out-of-area listing was returned by the canonical Siem Reap query. The previous title/location conflict (listing 298 in the dry run) remains excluded without a city rewrite.

## Legacy parity and checkpoint

The broad query returns 69 legacy rows and 213 canonical rows; 63 overlap, 6 are legacy-only, and 156 are canonical-only. The six legacy-only reasons are five `NO_SOURCE_ITEM` cases and one `CORRECTLY_EXCLUDED` Phnom Penh listing. This semantic difference remains shadow-only; no compatibility IDs, favorites, map, or cutover work was started.

The checkpoint remains 462 canonical properties/listings, 460 active listings, 730 current occurrences, and 2 historical occurrences. Legacy `properties` remains 390 rows with digest `59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272`.

Reports:

- [27-row source-city audit](/Users/lacr0s/!Projects/homeasy/reports/phase6a2-source-city-prior-audit-20261007.json)
- [Offer exclusion funnel and samples](/Users/lacr0s/!Projects/homeasy/reports/phase6a2-exclusion-funnel-20261007.json)
- [Full query parity matrix](/Users/lacr0s/!Projects/homeasy/reports/phase6a-canonical-read-parity-20261007.json)
- [Geography dry run](/Users/lacr0s/!Projects/homeasy/reports/phase6a2-geography-dry-run-20261007.json)

## Verification

- Full Jest: 45 suites, 392 tests passed. The regular run printed a generic open-handle warning; a second full run with `--detectOpenHandles` passed without identifying a handle or stack.
- Root typecheck passed.
- Webapp production build passed; Vite retains its large-chunk warning.
- `git diff --check` passed.
- Read-only checkpoint check: `integrity_check=ok`, 0 foreign-key violations.
