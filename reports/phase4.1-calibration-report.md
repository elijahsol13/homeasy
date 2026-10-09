# Phase 4.1 — offline cross-source calibration

## Scope and safety

Used only records already present in local BrightData snapshots and the existing local database. No new dataset records were requested. Image URLs were fetched directly from their existing CDN URLs with bounded concurrency; no browser or residential proxy was used. This phase does not change legacy `properties`, Mini App behavior, freshness checks, or live cutover.

## Recover media into raw ingestion

- Read 16 existing snapshots (1,315 records); 819 records matched existing Facebook source items. The other 53 of 872 Facebook source items were not present in those snapshots.
- Among matched records: 361 were housing supply, 456 irrelevant, and 2 housing adjacent. Only the 361 existing supply items were backfilled; no SourceItems were created.
- Recovered 1,786 attachment URLs from supply records; 1,783 were images after excluding three videos. Created 361 new source versions.
- Hashed up to five photos for each of 103 Facebook representatives: 503 photos hashed, zero failures. Existing Khmer24 hashes were reused. Signed CDN query parameters are removed from hash error logs.

## Exhaustive retrieval audit

- Candidate universe: 103 Facebook × 321 Khmer24 = 33,063 cross-source pairs.
- Production retrieval selected 14,008 and excluded 19,055; 2.36× pair reduction, with 42.4% selected.
- Full Cartesian pHash work: 334,998 image comparisons, 2 matching image pairs. Both matches are on the same confirmed DV018 listing pair, at Hamming distances 0 and 1.
- Excluded pairs with property score ≥0.60: 0; ≥0.70: 0; excluded pHash-match pairs: 0.
- The sole photo-supported cross-source match is FB source item 7 ↔ Khmer24 source item 2764: 2BR private villa, Sala Kamreuk, USD 1,250 rent, shared DV018 code and contacts, matching text, and two matching photos. This validates one real same-listing pair. It does not validate photo-only matching across unrelated agents; none was found.

## Human review of production POSSIBLE pairs

All five retrieved POSSIBLE pairs were manually reviewed against explicit Daka Kun property codes and available photos. Each pair has different explicit property codes and no matching photos; all five are `DIFFERENT_PROPERTY` for this labeled sample. Shared agent contacts account for the similarity. The classifier correctly abstains pending review rather than merging them.

| Facebook source item | Khmer24 source item | Facebook code | Khmer24 code | Review |
|---:|---:|---|---|---|
| 815 | 2890 | DV2316 | DV2299 | Different property; no photo match |
| 815 | 2936 | DV2316 | DV2033 | Different property; no photo match |
| 219 | 2821 | DV2313 | DV2298 | Different property; no photo match |
| 67 | 2890 | DV649 | DV2299 | Different property; no photo match |
| 67 | 2934 | DV649 | DV574 | Different property; no photo match |

No `SAME_PROPERTY_DIFFERENT_LISTING` example was observed; the fixture does not fabricate one. One additional generic pair (FB 400 ↔ Khmer24 2809) remains `UNKNOWN` because it lacks a decisive identity, contact, or photo signal.

## Candidate retrieval: top 50 excluded pairs

Rows are ranked by property score among pairs excluded by production retrieval. Signal names are grouped by family; contact values and message text are omitted.

| Rank | FB item | K24 item | Property score | Listing score | Decision | Retrieval signal families |
|---:|---:|---:|---:|---:|---|---|
| 1 | 67 | 2740 | 0.52 | 0.50 | DIFFERENT_PROPERTY | identifier, location, text token |
| 2 | 815 | 2740 | 0.52 | 0.50 | DIFFERENT_PROPERTY | identifier, location, text token |
| 3 | 46 | 2806 | 0.45 | 0.23 | DIFFERENT_PROPERTY | location, price/area/type, text token |
| 4 | 46 | 2895 | 0.45 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 5 | 833 | 2934 | 0.43 | 0.50 | DIFFERENT_PROPERTY | identifier, text token |
| 6 | 332 | 2807 | 0.40 | 0.43 | DIFFERENT_PROPERTY | location, price/area/type, text token |
| 7 | 84 | 2915 | 0.40 | 0.43 | DIFFERENT_PROPERTY | location, price/area/type, text token |
| 8 | 400 | 2913 | 0.40 | 0.38 | DIFFERENT_PROPERTY | location, text token |
| 9 | 801 | 2913 | 0.40 | 0.38 | DIFFERENT_PROPERTY | location, text token |
| 10 | 803 | 2913 | 0.40 | 0.38 | DIFFERENT_PROPERTY | location, text token |
| 11 | 400 | 2634 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 12 | 46 | 2857 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 13 | 49 | 2634 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 14 | 49 | 2913 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 15 | 720 | 2630 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 16 | 801 | 2634 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 17 | 803 | 2634 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 18 | 804 | 2630 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 19 | 819 | 2630 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 20 | 819 | 2749 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 21 | 819 | 2809 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 22 | 819 | 2894 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 23 | 869 | 2630 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 24 | 869 | 2634 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 25 | 91 | 2743 | 0.40 | 0.23 | DIFFERENT_PROPERTY | location, text token |
| 26 | 380 | 2644 | 0.40 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 27 | 380 | 2932 | 0.40 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 28 | 46 | 2891 | 0.39 | 0.22 | DIFFERENT_PROPERTY | location, text token |
| 29 | 79 | 2747 | 0.39 | 0.22 | DIFFERENT_PROPERTY | location, text token |
| 30 | 819 | 2914 | 0.39 | 0.22 | DIFFERENT_PROPERTY | location, text token |
| 31 | 380 | 2805 | 0.37 | 0.35 | DIFFERENT_PROPERTY | location, price/area/type, text token |
| 32 | 332 | 2663 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 33 | 400 | 2656 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 34 | 46 | 2805 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 35 | 48 | 2807 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 36 | 53 | 2630 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 37 | 53 | 2634 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 38 | 7 | 2883 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 39 | 7 | 2915 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 40 | 720 | 2656 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 41 | 79 | 2663 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 42 | 79 | 2729 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 43 | 79 | 2764 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 44 | 79 | 2910 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 45 | 803 | 2656 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location |
| 46 | 804 | 2656 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location |
| 47 | 84 | 2729 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 48 | 84 | 2764 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 49 | 84 | 2932 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |
| 50 | 91 | 2742 | 0.35 | 0.18 | DIFFERENT_PROPERTY | location, text token |

## Golden fixture and evaluator

Fixture: `reports/canonical-cross-source-golden-v1.json`, 30 independently labeled pairs: 1 `SAME_LISTING`, 28 `DIFFERENT_PROPERTY`, and 1 `UNKNOWN`.
The fixture stores the human label separately from algorithm output and redacts phone, email, and URL values from text. It contains 23 hard negatives selected from the highest scoring distinct-code pairs, plus the five POSSIBLE reviews, one positive, and one unknown.

Golden evaluator result:

- Confirmed positive retrieval recall: 1/1 (100%).
- False merges among labeled different-property pairs: 0.
- Correct DIFFERENT decisions: 23/28; 5/28 are conservative `POSSIBLE_SAME_PROPERTY` abstentions.
- UNKNOWN pair is retained as unknown in the fixture; the current evaluator’s algorithm output is `DIFFERENT_PROPERTY`, which should not be counted as a labeled negative.

## Shadow materialization and regression

After recovered media, canonical shadow contains 423 properties, 423 listings, 686 occurrences, 4253 media assets, and 14,008 pair decisions (1 SAME_LISTING, 5 POSSIBLE). Repeated commit produced the same counts.
Legacy `properties` has 390 rows in both the pre-media backup and current database; normalized table-content digests match. `PRAGMA foreign_key_check` returns zero violations.

Validation: TypeScript typecheck passed. Jest: 40 suites, 351 tests passed (the runner needed interruption after completion because an existing telemetry/network client kept the process alive). `git diff --check` passed.

## Phase 4.1 conclusion

Offline retrieval audit and evidence-backed golden fixture are complete. The positive sample is small (one confirmed cross-source listing), the different-agent photo-only case is absent, and there is no same-property/different-listing example. This is enough to record a successful calibration pass with explicit coverage limits; it is not evidence for automatic cutover. A live shadow period and freshness/budget validation remain later phases.
