# User Guide — Supply & QA

## Run an audit

### Web dashboard (recommended)

1. Open http://localhost:3000
2. Choose scope: **Media**, **Text**, or **Media + Text**
3. Enter **Property ID** (must be **active** in Amber)
4. Click **Run audit**
5. Review tabs: **Overview** (score, hero, links) · **Media** (images) · **Text** (claims vs PMG) · **Issues**
6. Use **Open Google Sheet** for the full export (when configured)

### API / Sheets only

Same property ID via API; full column detail lives in Google Sheets tabs (see below).

## Quality scores

| Score | Meaning |
|-------|---------|
| 90–100 | Excellent — OK to publish |
| 70–89 | Good — minor fixes optional |
| 50–69 | Needs attention |
| Below 50 | Critical — fix before publish |

**Both** audits: headline score = media **65%** + text **35%** (shown on Overview).

---

## Featured / hero images

Featured image must be a **bedroom** (any bed/sleeping space). Legacy tag `room` counts as bedroom.

| Priority | Meaning | Action |
|----------|---------|--------|
| Critical | Featured is not a bedroom | Set `featured` on a bedroom image |
| Warning | Bedroom featured but better one exists | Swap when possible |
| Config | Same rules per room-type gallery | Fix that config’s featured image |

Dashboard **Overview** shows hero status; Sheets: Property Summary **Hero Action** and Action Items.

---

## Google Sheets tabs

| Tab | Audit type |
|-----|------------|
| Property Summary, History, Image Details, Action Items, System Rules | Media |
| Text Summary, Details, Action Items, Missing Info | Text |

Column definitions: [QC-REFERENCE.md](./QC-REFERENCE.md).

---

## Text QC (summary)

- Compares Amber listing claims to the **PMG page** from `source_link`
- **Critical** action items = proven PMG **conflicts** only
- “Unverified” / missing evidence is not treated as proof the listing is wrong

Details: [TEXT-QC-ARCHITECTURE.md](./TEXT-QC-ARCHITECTURE.md).
