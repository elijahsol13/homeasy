# Homeasy AI extraction — Stage 7 expanded Gemini evaluation (2026-10-23)

## Evaluation actually performed

- **20 distinct saved original ads**, selected from the Stage 4 manually reviewed, source-hashed cases: **10 Facebook + 10 Khmer24**. Each ad was sent independently to `gemini-3.5-flash-lite` **twice**, totaling **40 real model responses**. The evaluator checked that saved source SHA-256 hashes matched before calling the provider. Facebook author text and the available Khmer24 author text were used; historical Khmer24 platform-form provenance is insufficient to claim a full live metadata comparison.
- **40/40 responses (100%)** passed the typed extraction contract. **78/78 checked non-null manually annotated numeric facts (100%)** matched after deterministic sanitization. This represents **39 unique annotated values evaluated twice**, not 78 independent annotated facts. Unannotated/null gold values cannot be scored as correct.
- **254/260 (97.7%)** exact agreement across 13 selected structured fields for each two-run pair. **2/20 pairs (10%)** had byte-identical English descriptions. Editorial variation is expected; byte equality is not a quality score.
- Volume: **99,892 input tokens** and **16,382 output tokens** across these 40 calls. Source split: Facebook **20/20 typed-valid**, **48,634 input / 8,635 output**; Khmer24 **20/20 typed-valid**, **51,258 input / 7,747 output**.

## Material limitations and defects found

- Six differing field values all occurred in `discovered_amenities`: ID 3 (car parking in only one run, supported by its source); IDs 70 and 2653 (same amenity members but different order); ID 71 (one run incorrectly promoted a generic kitchen to `western_kitchen`, while the other extracted `private_terrace`); ID 2947 (one run invented `refrigerator` and `washing_machine` from *fully furnished*); ID 5714 (one run invented `refrigerator` from *fully furnished*).
- Some prose still contains unwarranted sales adjectives such as *affordable* (138) and *spacious* (155, 2067). Typed acceptance and numeric matches therefore **do not establish overall semantic correctness, a 100% extraction success rate or neutral editorial quality**.
- The sanitizer was subsequently strengthened to require explicit source evidence for `refrigerator`, `washing_machine`, and `western_kitchen`; regression checks cover absent and stated appliances in English/Khmer and generic versus Western-style kitchens. The extraction instructions now explicitly forbid inferring appliances from *fully furnished* and forbid subjective marketing adjectives. **These post-benchmark changes were validated locally; the 40-call metric is from the preceding prompt/sanitizer version.** A post-change real-model generalization score is not available.
- The deliberately selected 20 examples are a targeted quality/regression sample, **not** a random, representative set of live inventory. No source DB rows or existing property cards were rewritten as part of this benchmark. Shipping code changes affects subsequent extraction and user-facing formatting; repairing historical stored cards is a separate operation.

## Release interpretation

The sample supports deploying the bounded typed extractor and deterministic source guards with local tests and production smoke checks. It does **not** justify bulk historical reprocessing, automatic filling of absent fields, or a claim that the editorial text is fully reliable without human review. The contact-redacted per-response evidence is kept locally at `reports/homeasy-ai-extraction-stage7-expanded-20261023.json` rather than shipped with the application.
