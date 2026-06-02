# Database Schema

## Database Connection

- **Type:** Redshift/PostgreSQL
- **Database:** amberdb
- **Schema:** public
- **Total Properties:** 182,067

## Inventories Table

The system uses the `inventories` table for property data.

### Key Columns

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Property ID (primary key) |
| `name` | varchar | Property name |
| `location` | varchar | JSON with location details |
| `status` | varchar | Property status (active, deleted) |
| `description` | varchar | JSON array with descriptions |
| `images` | varchar | **JSON array with image URLs** |
| `inventory_no` | varchar | Unique inventory number |
| `unit_type` | varchar | Property type |
| `pricing` | varchar | JSON with pricing info |
| `source_link` | varchar | **PMG / syndicator property page URL** — used by Text QC fact-check (`pmgSourceUrl`) and shown as Property URL on Sheets |
| `canonical_name` | varchar | Slug for Amber customer URL (`amberstudent.com/places/…`) |
| `meta` | varchar | JSON — amenities, policies, FAQs, house rules, URLs |
| `faqs` | varchar | FAQ content (JSON or text) |
| `features` / `highlights` | varchar | Structured amenity/feature lists |
| `message` / `message_1` | varchar | Policy-style messages |

Text QC reads prose from `description`, `faqs`, `meta`, and related columns. See [TEXT-QC-ARCHITECTURE.md](./TEXT-QC-ARCHITECTURE.md).

## Images Storage

Images are stored as JSON array in the `images` column:

```json
[
  {
    "path": "https://s3-ap-southeast-1.amazonaws.com/assets.amberstudent.com/inventories/12430/10f09b1a.jpg",
    "base_path": "https://s3-ap-southeast-1.amazonaws.com/assets.amberstudent.com/inventories/12430/10f09b1a.jpg"
  }
]
```

### Image URL Format
- **S3 Bucket:** assets.amberstudent.com
- **Path:** `inventories/{inventory_id}/{image_hash}.jpg`
- **Access:** Public HTTPS URLs

## Sample Queries

### Get Property with Images
```sql
SELECT 
  id,
  name,
  location,
  status,
  images
FROM inventories
WHERE id = 12430
AND status = 'active'
LIMIT 1;
```

### Count Active Properties
```sql
SELECT COUNT(*) 
FROM inventories
WHERE status = 'active';
```

### Get Properties by Location
```sql
SELECT 
  id,
  name,
  location::text,
  images
FROM inventories
WHERE status = 'active'
AND location::text ILIKE '%Sacramento%'
LIMIT 10;
```

## Performance Notes

- Always use `LIMIT` with large queries (182K+ records)
- Filter by `status = 'active'` to reduce dataset
- JSON parsing may be slower than relational joins
- Ensure `id` and `status` columns are indexed

## Test Property IDs

- **12430** - Green Leaf Arbors (31 images)
- Any ID from 1 to 182,067
