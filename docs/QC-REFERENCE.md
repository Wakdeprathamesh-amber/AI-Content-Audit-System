# Content QC — Field Reference & Verification Guide

A single source of truth for every column the QC pipeline writes to the Google
Sheet, how each value is calculated, and how to verify it independently. Every
section names the file the logic lives in, so when the code changes this doc
can be updated against ground truth.

Last verified against code: 2026-05-29.

---

## 0. Property URL vs Amber URL

The Property Summary and Property History tabs both surface **two** URLs for
the audited property:

| Column        | Source                                    | What it links to                                                                                          |
|---------------|-------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| `Property URL` | `inventories.source_link`                | The third-party reference page Amber catalogued the listing from (PMG for UK, syndicator elsewhere). May be empty. |
| `Amber URL`    | Built from `inventories.canonical_name`  | Amber's customer-facing page: `https://amberstudent.com/places/<canonical_name>`. Always populated when canonical_name exists. |

Implementation: `api/src/services/PropertyDataReaderDB.ts` (`buildAmberUrl` +
`mapRowToProperty`). The Amber URL pattern was verified against
`amberstudent.com` (HTTP 200) before being committed.

**Sanity check the Amber URL yourself:**
```bash
curl -sS -o /dev/null -w "%{http_code}\n" -L \
  "https://amberstudent.com/places/<canonical_name>"
# 200 = the URL resolves to the property page.
```

---

## 1. Eligibility

> **Content QC only audits properties whose `inventories.status = 'active'`.**

Soft-deleted / draft / inactive rows are kept in the DB but rejected by the
audit API with **HTTP 422** and code `PROPERTY_NOT_ACTIVE`. Enforcement lives
in `api/src/services/ExecutionEngine.executeSingleAudit` and is mapped to 422
in `api/src/routes/audit.ts`.

```bash
# 12430 is soft-deleted in the DB. This shows the guard:
curl -X POST http://localhost:3000/api/v1/audits/single \
  -H "Content-Type: application/json" \
  -d '{"propertyId":"12430","auditType":"media","checks":["quality"]}'
# → 422 { code: "PROPERTY_NOT_ACTIVE", propertyStatus: "deleted", ... }
```

---

## 2. Image Details — `Width`, `Height`, `Megapixels`, `Format`, `File Size`

These are **file-level facts about the downloaded image**, captured by the
Python image-module BEFORE any colour-mode conversion.

### How they're calculated

Source: `image-module/services/image_downloader.py` (download) and
`image-module/services/quality_analyzer.py` (analysis).

| Field           | Formula / source                                                                                                                       |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------------|
| **Width / Height** | `PIL.Image.open(bytes).size` after `ImageOps.exif_transpose(image)`. EXIF rotation is applied so a portrait shot is reported as portrait, not landscape. |
| **Megapixels**     | `round((width * height) / 1_000_000, 2)`                                                                                              |
| **Format**         | `image.format` captured **before** `image.convert('RGB')` runs (otherwise PIL drops `.format`). Reports the wire format the CDN served: `JPEG`/`PNG`/`WEBP`/`AVIF`/`GIF`. |
| **File Size (KB)** | `len(image_data) / 1024`, rounded — where `image_data = response.content` from the CDN download.                                       |

### How to verify

Pick any image URL from the `Image URL` column (H) and run any of these:

**ImageMagick (works on every image format):**
```bash
curl -sS -L "<IMAGE_URL>" -o /tmp/img && identify -format \
  "%w x %h | %m | %b\n" /tmp/img
# e.g. "1920 x 1080 | JPEG | 412KiB"
```

**`exiftool` (also shows EXIF orientation, useful when our W/H seems swapped):**
```bash
curl -sS -L "<IMAGE_URL>" -o /tmp/img && \
  exiftool -ImageWidth -ImageHeight -FileType -FileSize -Orientation /tmp/img
```

**Python (matches what our pipeline does, EXIF transpose included):**
```python
import requests, io
from PIL import Image, ImageOps
data = requests.get("<IMAGE_URL>", timeout=30).content
img  = Image.open(io.BytesIO(data))
fmt  = img.format            # BEFORE any conversion
img  = ImageOps.exif_transpose(img)
print(img.size, fmt, len(data), "bytes")
```

If the numbers don't match the sheet exactly: check whether the sheet shows
File Size in **KB** (it does — rounded). Width/Height should be bit-exact;
format is the wire format, not the CDN's `Content-Type` header.

---

## 3. Image Details — `Resolution OK`, `Not Blurry`, `Sharp Enough`, `Watermark` (+ Text + Confidence)

These are the **quality verdicts** — each one a YES/NO column derived from a
numeric measurement and a threshold from `.env`.

### Resolution OK

| | |
|-|-|
| **Code** | `api/src/services/GoogleSheetsWriter.ts` (`writeImageDetails`) — line that compares `img.quality.resolution.width / height` to thresholds. |
| **Formula** | `width >= MIN_RESOLUTION_WIDTH AND height >= MIN_RESOLUTION_HEIGHT` |
| **Default thresholds** | `MIN_RESOLUTION_WIDTH=800`, `MIN_RESOLUTION_HEIGHT=800` |
| **Failure severity** | `critical` — fails this and the Action Item says "Replace with higher resolution (current: WxH, min: 800x800)". |
| **How to verify** | Same as §2 — check the actual W and H, compare to the threshold. |

### Not Blurry & Sharp Enough

Both come from the same physical measurement (a "blur score"); the column
labels are different threshold readings of the same number.

**Code:** `image-module/services/quality_analyzer.py` (`_detect_blur` +
`_calculate_sharpness`).

**Method — normalized Laplacian variance:**

1. Convert image to grayscale.
2. **Resize to a fixed 1024-px long edge** (`BLUR_NORMALIZE_LONG_EDGE = 1024`).
   Without this, the same scene at different resolutions produces wildly
   different variances and the threshold becomes useless.
3. Compute `cv2.Laplacian(gray, CV_64F).var()`.
4. **Divide by mean luminance** (+ small epsilon) so dim photos aren't
   penalized and bright photos aren't rewarded.
5. Multiply by 128 to keep the magnitude in the legacy `0–500` band so the
   `BLUR_THRESHOLD=100` env value remains meaningful.

| Field            | Verdict                                              |
|------------------|------------------------------------------------------|
| **Not Blurry**   | `blur_score >= BLUR_THRESHOLD` (default 100). Failure → `warning`. |
| **Sharp Enough** | Sharpness = `min(100, blur_score / 500 * 100)`. `sharpness >= SHARPNESS_THRESHOLD` (default 50). Failure → `warning`. |

So `Not Blurry` is the raw-variance gate; `Sharp Enough` is the same number
re-scaled to a 0–100 score with a separate threshold. A photo can pass one and
fail the other if it sits near a boundary.

**How to verify** — reproduce locally with the same normalization:

```python
import cv2, numpy as np, requests
from PIL import Image, ImageOps
import io

def blur_score(image_url):
    img = Image.open(io.BytesIO(requests.get(image_url, timeout=30).content))
    img = ImageOps.exif_transpose(img).convert('RGB')
    a = np.array(img)
    gray = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY)
    h, w = gray.shape
    long_edge = max(h, w)
    if long_edge != 1024:
        scale = 1024 / long_edge
        gray = cv2.resize(gray, (int(round(w*scale)), int(round(h*scale))),
                          interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
    var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean_lum = float(gray.mean()) + 1e-3
    return (var / mean_lum) * 128.0

s = blur_score("<IMAGE_URL>")
print(f"blur_score={s:.2f}  sharpness={min(100, s/500*100):.2f}")
print(f"Not Blurry = {'YES' if s >= 100 else 'NO'}")
print(f"Sharp Enough = {'YES' if (s/500*100) >= 50 else 'NO'}")
```

If your number doesn't match the sheet: it's almost always EXIF rotation (the
sheet auto-rotates portraits) or the long-edge normalization step — apply both
exactly as above and you should match within ±1.

### Watermark (+ Watermark Text + Watermark Confidence)

| | |
|-|-|
| **Code** | `image-module/services/watermark_detector.py` |
| **Method** | OpenAI Vision (`IMAGE_WATERMARK_MODEL`, default `gpt-4o-mini`). Image sent as base64 (so auth-gated CDN URLs work). |
| **Prompt** | Conservative: only flag if confidence ≥ threshold AND the AI provides written reasoning ≥ 10 chars. Explicitly tells the model NOT to flag street signs / posters / floor-plan labels / appliance brands / TV screens / etc. |
| **Threshold** | `WATERMARK_CONFIDENCE_THRESHOLD=85`. If the model returns lower confidence, we force `detected=false`. |
| **Anti-false-positive guard** | If `detected=true` but reasoning < 10 chars, we drop the detection (treat as false positive). |
| **Circuit breaker** | After 5 consecutive failures, the detector serves a `degraded:true` fallback ("not detected") instead of hammering OpenAI. |

**The three sheet columns:**

- `❌ Watermark` (Q) — YES/NO from `watermark.detected` (already threshold-gated).
- `Watermark Text` (R) — the exact text the model extracted (if any). **Empty
  text + YES is the cheapest false-positive flag** — eyeball the image.
- `Watermark Confidence` (S) — `85%`-`100%` (anything below is filtered out).

**How to verify a single watermark detection:**

```bash
# Hit the image module directly with just the watermark check:
curl -sS -X POST http://localhost:8000/api/v1/image/analyze \
  -H "Content-Type: application/json" \
  -d '{"image_url":"<IMAGE_URL>","checks":["watermark"]}' | jq '.watermark'
# Returns { detected, confidence, text, reasoning, degraded }
```

Then open the image yourself and compare against `text` + `reasoning`. If
`reasoning` describes nothing visible → false positive — capture it as a tuning
example.

---

## 4. Image Details — `Category`, `Categorized`, `⭐ Featured (DB)`, `Upstream Tag`, `Upstream Blur`, `Upstream Watermark`, `Duplicate`

### Category (ours)

Column **T** — the canonical lowercase\_underscore tag our categorizer chose
for the image.

| | |
|-|-|
| **Code** | `image-module/services/image_categorizer.py` |
| **Method** | OpenAI Vision (`IMAGE_CATEGORY_MODEL`, default `gpt-4o-mini`), image as base64. The model returns `primary`, `confidence`, `alternatives`, `reasoning`, and (when an upstream tag was supplied) `is_correct` + `suggested_correction`. |
| **Allowed values** | The fixed taxonomy in §5 below. Anything else is normalized to `other`. |
| **Sheet display** | Title-Cased: `bedroom` → `Bedroom`, `floor_plan` → `Floor Plan`, `common_area` → `Common Area`. |

### Categorized (YES/NO)

Column **U** — whether the categorizer was **confident** in its choice, not
whether we have a category at all.

```
Categorized = category.confidence >= CATEGORY_CONFIDENCE_THRESHOLD  (default 70%)
```

A `NO` raises an `info` issue. The category itself is still filled in (column
T) regardless, so the supply team can sanity-check and override.

### ⭐ Featured (DB)

Column **V** — a **direct read of the upstream signal**
`inventories.images[].featured`. No model, no judgement.

| Value      | Meaning                                                                              |
|------------|--------------------------------------------------------------------------------------|
| `⭐ FEATURED` | The DB explicitly marked this image with `featured: true`. This is what the current website hero falls back to. |
| (empty)    | Not flagged in the DB.                                                               |

This column ties directly to the **hero audit** — see §6.

### Upstream Tag, Upstream Blur, Upstream Watermark

These three columns are **diagnostic-only comparisons** with the upstream
tagging pipeline. **Content QC never trusts them** — we re-run our own
detectors on every image, then surface the upstream value side-by-side so the
team can see where the two pipelines disagree.

Source: `inventories.images[].type`, `inventories.images[].blurred`, and
`inventories.images[].watermark_present` on the DB row. Read by
`api/src/services/PropertyDataReaderDB.ts` and formatted for display by
`api/src/services/GoogleSheetsWriter.ts` (`formatUpstreamTag`,
`formatUpstreamBlur`, `formatUpstreamWatermark`).

| Column                  | When upstream matches our verdict     | When upstream disagrees                              | When upstream didn't run |
|-------------------------|---------------------------------------|------------------------------------------------------|--------------------------|
| **Upstream Tag (W)**    | shows tag, no marker                  | `<tag> ⚠️ ours: <our-tag>`                            | empty                    |

Legacy upstream `room` and AI `bedroom` (or the reverse) are treated as a
**match** — no ⚠️ (`shared/imageCategories.ts` → `categoriesMatchForAudit`).
| **Upstream Blur (X)**   | `BLURRY` or `OK`, no marker           | `BLURRY ⚠️` or `OK ⚠️`                                | empty                    |
| **Upstream Watermark (Y)** | `WATERMARK` or `OK`, no marker     | `WATERMARK ⚠️` or `OK ⚠️`                             | empty                    |

The ⚠️ marker is your **investigate-this-row** signal. Per the audit's
charter, only ~5% of images in the DB carry blur/watermark labels from
upstream, so empty cells are normal and not actionable.

### Duplicate

Column **Z** — exact + near-duplicate detection across the property's full
image cluster (root row + every config child).

| | |
|-|-|
| **Code** | `api/src/services/hashSimilarity.ts` + `ExecutionEngine.detectDuplicates` |
| **Method** | Perceptual hash (`imagehash.phash`) computed in the Python image module during download, then **bit-level Hamming similarity** in Node (not hex-char distance — that earlier bug over-counted near-duplicates and missed real ones). |
| **Formula** | `similarity = (1 - hammingBits / totalBits) * 100`. Flag if `similarity ≥ DUPLICATE_SIMILARITY_THRESHOLD` (default 95%). |
| **Sheet output** | `YES` + `Action`/Action-Items row reading `Remove duplicate (same as <duplicateOf imageId>)`. |
| **Scoring impact** | Duplicate images are penalised ×0.9 in the per-image quality score. |

**How to verify a flagged duplicate:**

Open both images side-by-side from the `Image URL` column. If they're
*not* perceptually identical (or near-identical with the same composition),
capture the pair as a false-positive example. The threshold is conservative
(95%) but it's still a hash-based approximation, not pixel-exact.

---

## 5. Canonical category taxonomy

**Code:** `image-module/services/image_categorizer.py`, `shared/imageCategories.ts`.

### Tags in production DB

Verified by `scripts/inspect-all-image-tags.js` (sample of 137k+ image objects).
Upstream stores lowercase\_underscore on `inventories.images[].type`:

| Tag | In DB | AI may output | Notes |
|-----|-------|---------------|-------|
| `bedroom` | Yes | Yes | **All sleeping spaces with a bed** (studio, PBSA room, ensuite, apartment bedroom). |
| `kitchen` | Yes | Yes | |
| `bathroom` | Yes | Yes | |
| `common_area` | Yes | Yes | |
| `amenities` | Yes | Yes | |
| `floor_plan` | Yes | Yes | |
| `exterior` | Yes | Yes | |
| `room` | Yes (~3%) | **No** (coerced → `bedroom`) | Legacy upstream tag; treated as bedroom for hero checks and W-column match. |
| `other` | No | Yes (fallback only) | Internal low-confidence bucket; never written upstream. |

~23% of image objects have **no** `.type` in the DB (empty). Those still get an AI category in column T.

### Definitions (AI prompt = supply standard)

| Tag | Definition |
|-----|------------|
| **`bedroom`** | Any **interior** photo where a **bed is the main subject** — studio, ensuite, PBSA private room, apartment bedroom, shared-flat sleeping room. **Always use `bedroom` for lettable sleeping spaces.** |
| **`kitchen`** | Cooking area: hob/oven, counters, cabinets (including kitchenettes). |
| **`bathroom`** | Toilet, sink, shower, bath, ensuite wash area. |
| **`common_area`** | **Indoor** shared/living: lounge, dining, hallway, study desk area, internal corridor. **Not** gym/pool/lobby-as-facility. |
| **`amenities`** | **Facility** spaces: gym, pool, laundry, cinema, game room, parking, study hub. **Not** a flat's living room. |
| **`floor_plan`** | Plan/layout/blueprint only. |
| **`exterior`** | **Outdoor** or from outside: façade, entrance, courtyard, terrace with sky/outdoor context. **Not** indoor lobby or indoor pool. |
| **`other`** | Only when none of the above fit (QC fallback). |

### Matching rules

- Case/separator insensitive: `Bedroom`, `bedroom`, `floor plan` → canonical form.
- **W column:** no ⚠️ when upstream `room` vs AI `bedroom` (equivalent sleeping tags).
- **Hero Layer 1** uses **upstream** tag on the current featured/hero image (`bedroom` or legacy `room` = pass).
- **Hero Layer 2** picks the best candidate among images the AI tagged `bedroom` (watermark = disqualify; score = 50% resolution + 50% sharpness vs recommended size).

---

## 6. Hero / featured bedroom audit

**Code:** `api/src/services/ExecutionEngine.ts` (`computeHeroAudit`, `computeConfigHeroAudits`).

Two scopes use the **same three-layer logic**:

| Scope | Gallery | What it affects |
|-------|---------|-----------------|
| **Property** | `level === 'property'` on root inventory | Search page / property-level hero |
| **Config** | `level === 'config'` per unit-type child | Room-type option hero on the property page |

Config results appear in **Action Items** (description prefixed `Config "…"`) and in the API JSON field `configHeroes`. Property-level results drive **Property Summary → Hero Action**.

### How “current hero” is chosen

1. First image in that gallery with `featured: true`.
2. If none, **`images[0]`** (positional fallback). Summary shows `[no featured flag, used images[0]]`.
3. Multiple `featured: true` in one gallery → **first in array order wins** (data-quality issue; reconcile to one).

### Three layers (priority for supply)

| Layer | Severity | Rule | Property Summary `Hero Action` |
|-------|----------|------|--------------------------------|
| **1** | **Critical** | Current hero upstream tag is **not** `bedroom` or legacy `room` | `🔴 FEATURED NOT BEDROOM` |
| **2** | Warning | Hero **is** a bedroom, but another AI-`bedroom` image scores higher (no watermark) | `🔄 SWAP → <imageId>` |
| **3** | — | Same layers **per config** inventory | Config rows in **Action Items** only |

Layer 1 uses **upstream** `images[].type` only (what Amber has stored today). Layer 2 uses **AI** `bedroom` for the candidate pool.

**Action Items** issue category `featured_not_bedroom` (critical) and `hero_image` (warning for swap).

### Hero score (Layer 2)

```
heroScore = 0  if watermark detected
heroScore = 0  if AI primary is not bedroom (after canonicalize)
else heroScore = 50% resolution-vs-recommended + 50% sharpness
```

Best-scoring image in scope becomes `recommendedHeroImageId` in the audit JSON / Summary thumbs.

### What to fix in Amber

- **Property root:** exactly **one** `featured: true` on a **`bedroom`** image (search hero).
- **Each config row:** exactly **one** `featured: true` on a **`bedroom`** image for that room type.
- Prefer retagging legacy upstream `room` → `bedroom` over time (QC already treats them the same).

### API fields

| Field | Content |
|-------|---------|
| `audit.hero` | Property-level hero audit |
| `audit.configHeroes[]` | Per config: `configName`, `action`, `reason`, current/recommended image IDs |
| `audit.issues[]` | All layers flattened for Action Items |

`HERO_EXPECTED_CATEGORY` env var (default `bedroom`) controls the Layer 2 candidate pool without a code deploy.

---

## 5. Text QC

Full architecture, product goals, and deprecated patterns:
**[TEXT-QC-ARCHITECTURE.md](./TEXT-QC-ARCHITECTURE.md)** (source of truth for text QC).

Implementation: `api/src/services/text/TextQcService.ts` and modules under
`api/src/services/text/`.

### 5.1 Pipeline summary

| Step | Source | Mechanism |
|------|--------|-----------|
| Amber listing text | `inventories` (description, faqs, meta, …) | `PropertyTextReader` |
| PMG URL | `inventories.source_link` → `pmgSourceUrl` | `PmgSourceResolver` — **no web search** |
| PMG page content | HTTP GET of that URL | `PmgPageFetcher` — **not** OpenAI web search |
| Claims | LLM structured JSON | `TextExtractor` — `TEXT_QC_EXTRACTION_MODEL` |
| Compare | LLM structured JSON | `PmgFactChecker` — `TEXT_QC_FACTCHECK_MODEL` |

### 5.2 Text checks (`textChecks` API parameter)

| Check | Default? | What it does |
|-------|----------|--------------|
| `extraction` | Yes | Claims + missingInformation from Amber text |
| `fact_check` | Yes | PMG page fetch + compare verifiable claim types |
| `missing_info` | No | Required types + structured diff + LLM gaps → warnings |
| `cross_field_consistency` | No | Plausibility + internal contradiction LLM |
| `duplicate_property` | No | Duplicate claim detection |

### 5.3 Text Summary (one row per property)

| Column | Source / meaning |
|--------|------------------|
| Property ID / Name | Audit context |
| Text QC Score | 0–100 (`TextQcScorer`) |
| Total Claims | Extracted claim count |
| Verified Claims | Fact-check status `verified` |
| Conflicting Claims | Status `conflict` — **fix first** |
| Missing Evidence Claims | `missing_evidence` / `not_found` — informational |
| Missing Fields | Count of missing required types among rent, deposit, amenity |
| Critical Issues / Warnings | Issue severities |
| Audit ID / Last Audit | Run metadata |

### 5.4 Text Details (one row per claim)

**Amber (our website) columns:**

| Column | Meaning |
|--------|---------|
| Claim ID | `{propertyId}-txt-{n}` |
| Claim Type / Label / Value / Unit | Structured fact |
| Source Section | `description`, `faqs`, `amenities_blurbs`, … |
| Source Text | Quote from that Amber section (verify in Amber admin) |

**PMG (operator page) columns — only for externally verifiable types:**

| Column | Meaning |
|--------|---------|
| Verification Status | `verified`, `conflict`, `missing_evidence`, `unknown`, … |
| Confidence | LLM confidence 0–1 |
| Evidence URL | PMG page used (usually same as `source_link`) |
| Evidence Snippet | Quote from PMG page supporting or contradicting |
| Fact Check Source | `pmg` or `none` |
| Verification Mode | `pmg_db`, `no_url`, `fetch_failed` |
| Evidence Type | `pmg_db_url` or `none` |
| Fact Check Notes | LLM notes |

**Fix hints:** Diff Type, Suggested Fix (when linked issue exists).

**Amenity rows:** Often `unknown` / `none` — amenities are **not** PMG fact-checked by design.

**Independent verification:** Open `source_link` in browser; confirm Source Text on
Amber and Evidence Snippet on PMG for conflicts.

### 5.5 Text Action Items (fix queue)

Only **critical** and **warning** issues (no info rows).

| Priority | Typical categories |
|----------|-------------------|
| CRITICAL | `fact_conflict` |
| WARNING | `missing_info`, `consistency`, `duplicate_property`, plausibility |

Columns: Issue, Action Required, Claim ID, Evidence URL (for conflicts).

### 5.6 Text Missing Info

From extraction `missingInformation` (concrete gaps in the listing). Populated
whenever text audit runs if extraction produced gaps — not the same as “copy from
description to Amenities” (see TEXT-QC-ARCHITECTURE.md Goal B).

### 5.7 Claim types sent to PMG fact-check

See `api/src/services/text/claimPolicy.ts` — includes `distance`, `offer`,
policy/FAQ/house_rule types; **excludes** `amenity`, `rent`, `deposit`, `room_size`.

---

## Appendix — Active configuration knobs

All from `api/src/config/index.ts`, sourced from `.env`. The `System Rules &
Logic` Google-Sheets tab is regenerated from this config on every API start so
the runtime values can't drift from the docs.

| Env var                              | Default | Used for                                              |
|--------------------------------------|---------|-------------------------------------------------------|
| `MIN_RESOLUTION_WIDTH`               | 800     | Resolution OK gate                                    |
| `MIN_RESOLUTION_HEIGHT`              | 800     | Resolution OK gate                                    |
| `RECOMMENDED_RESOLUTION_WIDTH`       | 1920    | Full-credit resolution score                          |
| `RECOMMENDED_RESOLUTION_HEIGHT`      | 1080    | Full-credit resolution score                          |
| `BLUR_THRESHOLD`                     | 100     | Not Blurry gate                                       |
| `SHARPNESS_THRESHOLD`                | 50      | Sharp Enough gate                                     |
| `WATERMARK_CONFIDENCE_THRESHOLD`     | 85      | Watermark detection floor                             |
| `CATEGORY_CONFIDENCE_THRESHOLD`      | 70      | Categorized YES/NO gate                               |
| `DUPLICATE_SIMILARITY_THRESHOLD`     | 95      | Duplicate flag                                        |
| `HERO_EXPECTED_CATEGORY`             | bedroom | Hero recommendation pool                              |
| `IMAGE_WATERMARK_MODEL`              | gpt-4o-mini | Watermark detector LLM                            |
| `IMAGE_CATEGORY_MODEL`               | gpt-4o-mini | Category detector LLM                             |
| `TEXT_QC_EXTRACTION_MODEL`           | gpt-4o-mini | Extract claims from Amber listing text            |
| `TEXT_QC_FACTCHECK_MODEL`            | gpt-4o-mini | Compare claims vs HTTP-fetched PMG page text      |
| `TEXT_QC_CONSISTENCY_MODEL`          | gpt-4o-mini | Internal consistency checker                      |
| `TEXT_QC_PMG_PAGE_MAX_CHARS`         | 12000       | Max PMG plain text in fact-check prompt           |
| `TEXT_QC_PMG_FETCH_TIMEOUT_MS`       | 15000       | HTTP timeout for PMG page download                |
| `TEXT_QC_PMG_ALLOWED_DOMAINS`        | wearehomesforstudents.com | Allowed `source_link` hosts      |

Change any threshold by editing `.env`, restart services
(`bash restart-services.sh`), and the System Rules sheet regenerates on the
next audit.
