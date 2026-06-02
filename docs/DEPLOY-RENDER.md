# Deploying on Render

This project has two services that must be deployed together:
- `api` (Node.js/TypeScript, HTTP service)
- `image-module` (Python/FastAPI, HTTP service)

Deploy both as Render Web Services and wire them with environment variables.

## 1) Prerequisites

- GitHub repo contains this project
- A Render account connected to GitHub
- Required credentials available (DB, OpenAI, Google Sheets if used)

## 2) Create the image-module service first

Create a new **Web Service** in Render:
- **Root directory:** `image-module`
- **Environment:** `Python`
- **Build command:** `pip install -r requirements.txt`
- **Start command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`

Set environment variables needed by image analysis:
- `OPENAI_API_KEY`
- Any watermark/category model overrides you use in `.env`

Deploy and copy its public URL, for example:
`https://ai-content-image-module.onrender.com`

## 3) Create the API service

Create another **Web Service**:
- **Root directory:** `api`
- **Environment:** `Node`
- **Build command:** `npm ci && npm run build`
- **Start command:** `npm start`

Set required environment variables:
- `NODE_ENV=production`
- `PORT` (Render injects this; do not hardcode)
- `IMAGE_MODULE_URL` = URL from step 2
- `OPENAI_API_KEY`
- Database variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, etc.)
- Google Sheets variables (if `OUTPUT_MODE=sheets`)
- `API_KEY` (optional but recommended)

## 4) Health check and networking

- Ensure both services expose a `/health` endpoint.
- In Render service settings, use `/health` as health check path.
- Confirm API can reach image-module URL from production logs.

## 5) Secrets and files

- Do not commit `.env` or credential JSON files.
- Add secrets directly in Render Environment settings.
- If Google credentials are needed, store JSON in an env var and reconstruct at runtime, or use a secure file mount strategy.

## 6) Post-deploy verification checklist

1. Open API health endpoint:
   - `https://<api-service>.onrender.com/health`
2. Open image-module health endpoint:
   - `https://<image-service>.onrender.com/health`
3. Trigger a single audit through API.
4. Confirm response includes both media and text outputs (`auditType=both`).
5. If Sheets are enabled, verify rows are created in target tabs.

## 7) Common Render issues

- **Build fails on API:** use `npm ci` and verify `package-lock.json` is committed.
- **Image module boot timeout:** check Python dependencies and startup command.
- **API cannot call image-module:** wrong `IMAGE_MODULE_URL` or service not healthy.
- **DB connection errors:** validate SSL requirements and Render egress allow-listing.
- **No Sheets output:** verify service account JSON and spreadsheet permissions.

## 8) Optional hardening

- Enable Render auto-deploy from `main`.
- Require API key on `/api/v1/*`.
- Add uptime monitoring for both `/health` endpoints.
- Run `scripts/check-secrets.sh` before every push.
