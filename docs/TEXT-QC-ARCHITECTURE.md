# Text QC — Architecture, Goals & Source of Truth

**Read this document first** when working on text QC, reviewing audits, or changing
fact-check behaviour. It reflects product decisions agreed in May 2026 and the
current implementation. If code or older chat notes disagree with this file,
**this file wins** unless the code was intentionally updated afterward.

Last verified against code: 2026-05-29.

---

## 1. Product goals (why Text QC exists)

Text QC helps the supply/content team **catch factual and completeness problems
in listing copy before students do**, without asking humans to re-read every
paragraph on every property.

### Goal A — External fact-check (PMG vs Amber)

**What:** Compare factual claims on **our Amber listing** against the **operator
(PMG) property page** we already catalogue in the database.

**Why:** Wrong distances, policies, or offers erode trust, SEO, and support load.

**How (high level):**

1. Read listing text from Amber DB (`description`, FAQs, policies, etc.).
2. Extract structured **claims** (distances, policies, offers, …).
3. Take the PMG URL from **`inventories.source_link`** (not web search).
4. **Download** that page (HTTP) and compare claim-by-claim with an LLM.

**What gets flagged for humans (low effort):**

| Severity | When | Tab |
|----------|------|-----|
| **Critical** | PMG text **clearly contradicts** our listing (`conflict`) | Text Action Items |
| **Warning** | Missing required claim types, internal inconsistency, structured diff (when checks enabled) | Text Action Items |
| **Not action items** | “Could not verify”, unverified distance, amenities | Text Details only (info) |

**Precision-first rule:** We do **not** flood Action Items with “unverified” rows.
Only **proven conflicts** are critical fix-now items. “Missing evidence” is not
proof the listing is wrong.

**What is NOT PMG fact-checked:** Amenities, rent, deposit, room size — see
`claimPolicy.ts` (operator-asserted or dynamic; PMG pages rarely help).

### Goal B — Structured sections vs long description (partial today)

**What (product intent):** Students read **Amenities**, **FAQs**, **Policies**,
not only the description paragraph. If something **substantial** appears only in
the description (named amenity, policy, distance, university, deposit, …), it
should also live in the right **structured** Amber field.

**Status:** **Partial.** `missing_info` + `TextDiffEngine` compare extracted
claims to structured DB lists — not a dedicated “description → copy to Amenities”
pass. Noisy cases exist (e.g. amenity value `Available` vs label “Fitness studio”).
**Future work** — see §6.

### Non-goals (do not expect Text QC to do these)

- Rewrite marketing copy or SEO prose.
- Legal/compliance sign-off.
- PMG fact-check every amenity line.
- Use **OpenAI web search** to discover URLs (we have `source_link` in DB).
- Use **OpenAI web search** to read PMG pages (we **HTTP-fetch** the known URL).
- Treat DuckDuckGo or search snippets as primary evidence (**removed**).

---

## 2. End-to-end pipeline (current implementation)

```
inventories (DB)
    │
    ├─► PropertyTextReader
    │       • Amber sections: description, faqs, house_rules, cancellation_policy,
    │         amenities_blurbs, other
    │       • pmgSourceUrl ← inventories.source_link (allowed PMG domain)
    │       • referenceUrls, structuredBaseline (amenities/policies/faqs lists)
    │
    ├─► TextExtractor  (TEXT_QC_EXTRACTION_MODEL, Chat Completions + JSON)
    │       • claims[] + missingInformation[]
    │
    └─► when textChecks includes fact_check:
            │
            ├─► PmgSourceResolver
            │       pmgSourceUrl → else allowed referenceUrls → else none
            │       (NO web search)
            │
            ├─► PmgPageFetcher  (HTTP GET via axios)
            │       HTML → plain text, up to TEXT_QC_PMG_PAGE_MAX_CHARS
            │
            └─► PmgFactChecker  (TEXT_QC_FACTCHECK_MODEL, Chat Completions + JSON)
                    Input: Amber claims + fetched PMG page text
                    Output: verified | conflict | missing_evidence | …
    │
    ├─► optional: missing_info → TextDiffEngine + required claim types
    ├─► optional: cross_field_consistency → PlausibilityValidator + ListingConsistencyChecker
    ├─► optional: duplicate_property
    │
    └─► TextQcScorer → issues + score → Google Sheets / JSON
```

**Orchestrator:** `api/src/services/text/TextQcService.ts`

**Default API `textChecks`:** `extraction`, `fact_check`  
**Full editorial pass:** add `missing_info`, `cross_field_consistency`, `duplicate_property`

---

## 3. Two OpenAI roles (do not confuse them)

| Step | API | Model env var | Purpose |
|------|-----|---------------|---------|
| Extract claims from **our** listing | Chat Completions + `json_schema` | `TEXT_QC_EXTRACTION_MODEL` | Structure Amber prose into claims |
| Compare listing vs **fetched PMG text** | Chat Completions + `json_schema` | `TEXT_QC_FACTCHECK_MODEL` | verified / conflict / missing_evidence |
| Internal consistency (optional) | Chat Completions + `json_schema` | `TEXT_QC_CONSISTENCY_MODEL` | Contradictions within our listing only |

**Not used:** OpenAI Responses API `web_search`, DuckDuckGo, gpt-4o-search-preview,
or “search to read the property website.”

**Recommended models:** `gpt-4o-mini` for extraction; `gpt-4o` (or stronger) for
fact-check if conflicts/verified quality is weak. Same model for both steps is
allowed but not required.

---

## 4. Data sources (whose website is whose)

| Data | Source | Used for |
|------|--------|----------|
| Listing claims, Source Section, Source Text | **Amber DB** (`inventories` text fields) | Extraction + sheet “our website” columns |
| PMG URL | **Amber DB** `source_link` → `pmgSourceUrl` | Fetch target only |
| PMG page text | **HTTP fetch** of that URL | Fact-check evidence |
| Evidence URL / Snippet in sheet | PMG page (via LLM citation) | Human review of conflicts |

**Property Summary `Property URL`** and text QC PMG fetch use the same
`source_link` field. See [QC-REFERENCE.md §0](./QC-REFERENCE.md#0-property-url-vs-amber-url).

---

## 5. Claim policy (what goes to PMG fact-check)

Defined in `api/src/services/text/claimPolicy.ts`:

| Bucket | Claim types | Fact-check? |
|--------|-------------|-------------|
| Externally verifiable | `distance`, `offer`, `policy_term`, `cancellation_term`, `house_rule`, `faq`, `other` | Yes |
| Operator-asserted | `amenity` | No (assume OK unless internal consistency fires) |
| Dynamic | `rent`, `deposit`, `room_size` | No (stale PMG risk; plausibility only) |

---

## 6. Google Sheets — how the team should use them

**5-minute workflow:** Text Summary → Text Action Items → fix → re-run.  
**Do not** line-review all of Text Details unless disputing a row.

| Tab | Purpose |
|-----|---------|
| **Text Summary** | One row per property: score, conflict count, missing fields |
| **Text Action Items** | **Only** critical + warning — the fix queue |
| **Text Details** | Per-claim audit trail (Amber source + PMG verification) |
| **Text Missing Info** | Editorial gaps (whole listing), not “copy to Amenities” yet |

Column-level reference: [QC-REFERENCE.md §5](./QC-REFERENCE.md#5-text-qc).

---

## 7. Verification modes & sheet columns

| Verification Mode | Meaning |
|-------------------|---------|
| `pmg_db` | PMG URL from DB, page fetched, fact-check ran |
| `no_url` | No allowed PMG URL on listing (`source_link` empty / wrong domain) |
| `fetch_failed` | URL present but HTTP download failed |

| Fact Check Source | Meaning |
|-------------------|---------|
| `pmg` | Judgment used fetched PMG page text |
| `none` | No PMG evidence used (unverified / fetch failed) |

| Evidence Type | Meaning |
|---------------|---------|
| `pmg_db_url` | Evidence from DB-linked PMG page |
| `none` | No evidence |

**Legacy values** (`pmg_primary`, `fallback_search`, `no_evidence`, `web_search`,
`web_search_url`) may appear in **old audit rows** only — new runs use the table above.

---

## 8. Scoring (Text QC Score)

Weighted components in `TextQcScorer.buildSummary`:

- Extraction completeness (claims cap)
- Required types present: `rent`, `deposit`, `amenity`
- Fact coverage (verified / checked) when fact-check ran
- Penalties: −8 per critical, −2 per warning

Combined **Property Summary** score when `auditType=both`: **65% media + 35% text**.

---

## 9. Environment variables

| Variable | Default | Role |
|----------|---------|------|
| `TEXT_QC_EXTRACTION_MODEL` | gpt-4o-mini | Extract claims from Amber text |
| `TEXT_QC_FACTCHECK_MODEL` | gpt-4o-mini | Compare claims vs PMG page text |
| `TEXT_QC_CONSISTENCY_MODEL` | same as extraction | Internal consistency LLM |
| `TEXT_QC_PMG_ALLOWED_DOMAINS` | wearehomesforstudents.com | Allowed `source_link` hostnames |
| `TEXT_QC_PMG_PAGE_MAX_CHARS` | 12000 | Max PMG plain text in fact-check prompt |
| `TEXT_QC_PMG_FETCH_TIMEOUT_MS` | 15000 | HTTP timeout for PMG page |
| `TEXT_QC_FACTCHECK_CLAIM_BATCH_SIZE` | 12 | Claims per fact-check LLM call |
| `TEXT_QC_MAX_MISSING_INFO` | 8 | Cap on missing-info rows from extraction |

**Removed (do not re-add without product review):** `TEXT_QC_OPENAI_WEB_SEARCH_*`,
DuckDuckGo scraping, OpenAI web search for URL discovery.

---

## 10. Module map

| File | Responsibility |
|------|----------------|
| `PropertyTextReader.ts` | Load Amber sections + `pmgSourceUrl` from `source_link` |
| `TextExtractor.ts` | LLM: claims + missingInformation |
| `pmg/PmgSourceResolver.ts` | Resolve single PMG URL from DB fields |
| `pmg/PmgPageFetcher.ts` | HTTP download PMG HTML → text |
| `PmgFactChecker.ts` | LLM: compare claims vs PMG text |
| `TextQcScorer.ts` | Issues, severities, score |
| `TextDiffEngine.ts` | Prose claims vs structured baseline (`missing_info`) |
| `claimPolicy.ts` | Which claim types go to PMG |
| `TextQcService.ts` | Pipeline orchestration |

---

## 11. Future work (Goal B — not done yet)

Dedicated **description → structured sections** QC:

- Extract substantial facts **from description only**
- Map to target section (Amenities / FAQs / Policies / …)
- Action item: “Add **{amenity}** to structured Amenities — quoted from description”
- Use **Claim Label** (not generic `Available`) in diffs

Until then, treat **Text Missing Info** as editorial backlog and **Text Action Items**
`missing_in_structured` (with `missing_info` check) as best-effort only.

---

## 12. Deprecated approaches (historical — do not reintroduce)

| Old approach | Why removed |
|--------------|-------------|
| DuckDuckGo HTML scrape for PMG URL | Unreliable; replaced by DB `source_link` |
| OpenAI Responses `web_search` for URL discovery | Redundant when all properties have `source_link` |
| Web search snippets in fact-check prompt | Secondary noise; primary evidence is fetched page |
| Fact-check amenities on PMG | Always `missing_evidence`; wasted cost |
| Critical severity for unverified claims | Flooded Action Items; only `conflict` is critical |

---

## Related docs

- [USER-GUIDE.md](./USER-GUIDE.md) — supply workflow for text tabs  
- [QC-REFERENCE.md](./QC-REFERENCE.md) — column definitions §5  
- [README.md](../README.md) — quick start and API examples
