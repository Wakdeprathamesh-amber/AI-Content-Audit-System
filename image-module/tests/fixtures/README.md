# Eval fixtures

This folder is the home of the labeled "gold set" for measuring real
detection accuracy (watermark, category, duplicate). The PRD targets
(95% blur, 90% watermark, 85% category) are only meaningful with a labeled
set to measure against.

## Structure

```
tests/fixtures/
  labels.csv                 ← one row per image
  images/                    ← .jpg/.png/.webp/.avif (50+ recommended)
```

### `labels.csv` columns

```
filename,category,has_watermark,is_blurred,notes
0001_bedroom.jpg,Bedroom,false,false,
0002_watermark_corner.jpg,Bedroom,true,false,corner photographer credit
...
```

## How to run the eval

A dedicated script (not yet written) should:

1. Load each image from `images/`.
2. Call the local image module's `/api/v1/image/analyze` endpoint.
3. Compare the response to the CSV row.
4. Compute precision/recall/F1 per check.
5. Emit a summary to stdout and (optionally) append a row to a Google Sheet
   so trend over time is visible.

The eval should be triggered on each release. Without it, the accuracy
claims in the README are aspirations, not measurements.
