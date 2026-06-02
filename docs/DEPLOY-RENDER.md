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
- **Build command:** `npm ci --include=dev && npm run build`
- **Start command:** `npm start`

> Important: `NODE_ENV=production` (set below) makes npm omit `devDependencies`,
> which would leave `typescript` uninstalled and break `npm run build`. The
> `--include=dev` flag forces dev dependencies to install at build time. The
> compiled entry point is `dist/api/src/index.js` (the build preserves the repo
> structure so `shared/` imports resolve); `npm start` already points there.

Set required environment variables:
- `NODE_ENV=production`
- `IMAGE_MODULE_URL` = URL from step 2
- `OPENAI_API_KEY`
- Database variables (`AMBER_DB_HOST`, `AMBER_DB_PORT`, `AMBER_DB_NAME`, `AMBER_DB_USER`, `AMBER_DB_PASSWORD`)
- `DB_SSL_REJECT_UNAUTHORIZED=false` (or wire a CA bundle and set strict SSL)
- Google Sheets variables (if `OUTPUT_MODE=sheets`)
- `API_KEY` (recommended for all non-local deployments)
- `CORS_ALLOWED_ORIGINS=https://<your-frontend-domain>`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=30`

Notes:
- Render injects `PORT` automatically; the API now supports `PORT` and `API_PORT`.
- For multiple CORS origins, use a comma-separated list with exact origins.

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

- **Build fails on API (`tsc: not found`):** `NODE_ENV=production` made npm skip dev deps — use `npm ci --include=dev && npm run build` and verify `package-lock.json` is committed.
- **Image module boot timeout:** check Python dependencies and startup command.
- **API cannot call image-module:** wrong `IMAGE_MODULE_URL` or service not healthy.
- **DB connection errors:** validate SSL requirements and Render egress allow-listing.
- **No Sheets output:** verify service account JSON and spreadsheet permissions.

## 8) Optional hardening

- Enable Render auto-deploy from `main`.
- Require API key on `/api/v1/*`.
- Add uptime monitoring for both `/health` endpoints.
- Run `scripts/check-secrets.sh` before every push.
