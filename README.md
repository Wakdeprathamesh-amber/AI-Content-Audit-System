# AI-Content-Audit-System

Automated media and text quality audits for Amber property listings.

The system runs two pipelines:
- **Media QC** (Python image module) for quality, watermark, category, and duplicate checks.
- **Text QC** (Node API modules) for claim extraction and PMG fact-checking.

Results are exposed in:
- Dashboard UI (`http://localhost:3000`)
- JSON API responses
- Google Sheets exports (when configured)

## Architecture

| Service | Port | Purpose |
|---------|------|---------|
| API (Node.js + TypeScript) | 3000 | Orchestration, dashboard, sheets writing, text QC |
| Image module (FastAPI + Python) | 8000 | Image analysis and vision-based checks |

```text
Property ID -> DB read -> media checks + text checks -> scoring -> dashboard/API/Sheets
```

Text QC resolves PMG URLs from `inventories.source_link` and uses HTTP fetch (not web search). See `docs/TEXT-QC-ARCHITECTURE.md`.

## Quick Start (Local)

1) Prepare environment:
```bash
cp .env.example .env
```

2) Install API dependencies:
```bash
cd api
npm install
```

3) Install image module dependencies:
```bash
cd ../image-module
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

4) Start both services:
```bash
cd ..
bash restart-services.sh
```

5) Optional first-time sheets setup:
```bash
cd api
node init-google-sheets.js
```

## Health Checks

```bash
curl http://localhost:3000/health
curl http://localhost:8000/health
```

## API Example

```bash
curl -X POST http://localhost:3000/api/v1/audits/single \
  -H "Content-Type: application/json" \
  -d '{"propertyId":"170410","auditType":"both","checks":["quality","watermark","category"],"textChecks":["extraction","fact_check","missing_info"]}'
```

If `API_KEY` is enabled, include `x-api-key` on `/api/v1/*` routes.
Inactive properties return `422 PROPERTY_NOT_ACTIVE`.

## Scoring

- Media score = resolution (40%) + watermark (40%) + sharpness (20%)
- Combined score (`auditType=both`) = media (65%) + text (35%)

## Repository Layout

```text
ai-content-audit-system/
├── api/                  # Express API + dashboard
├── image-module/         # FastAPI image analysis pipeline
├── shared/               # Shared schema / category helpers
├── docs/                 # System docs and references
├── scripts/              # Utility scripts (e.g., check-secrets)
├── restart-services.sh
└── .env.example
```

## Documentation Index

| Document | Purpose |
|----------|---------|
| `docs/USER-GUIDE.md` | Operations guide for Supply/QA |
| `docs/TEXT-QC-ARCHITECTURE.md` | Text QC behavior and product decisions |
| `docs/QC-REFERENCE.md` | Column-level field and verification reference |
| `docs/DATABASE-SCHEMA.md` | Key DB columns and sample queries |
| `docs/DEPLOY-RENDER.md` | Deployment checklist for Render |
| `SECURITY.md` | Security and credential handling |

## Deployment

For production deployment on Render, follow `docs/DEPLOY-RENDER.md`.

## Troubleshooting

| Issue | Action |
|-------|--------|
| Services not responding | `bash restart-services.sh` |
| 422 not active | Confirm property `status='active'` in DB |
| Google Sheets not updating | Check `.env`, credentials, and run `api/init-google-sheets.js` |
| Slow audits | Tune batch/concurrency env variables |

Logs are written under `logs/`.
