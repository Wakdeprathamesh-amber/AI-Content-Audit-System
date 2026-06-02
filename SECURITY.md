# Security

## Current state

The `.env` file at the repo root contains live credentials (Redshift password and OpenAI API key). It is gitignored, but the file itself sits on developer machines.

## Required actions (one-time)

These cannot be done by code — operator action required:

1. **Rotate OpenAI API key**
   - Revoke the existing key in https://platform.openai.com/api-keys
   - Generate a new key
   - Update `.env` locally
   - Store the new key in a secret manager (1Password, AWS Secrets Manager, Doppler, Vault, etc.)

2. **Rotate Redshift password** (`AMBER_DB_USER` account)
   - Coordinate with data engineering — this account is `data_engg`
   - Update `.env` locally
   - Update the secret manager entry

3. **Audit anywhere the old creds may have leaked**
   - Search Slack DMs, screenshots, chat logs for the key prefix `sk-proj-b1Mb`
   - Check git history of any project that may have committed it (this repo is not a git repo, but other projects may have)

## Runtime security

Implemented in code:

- **API key auth**: set `API_KEY` in `.env`. When set, all `/api/v1/*` requests must include `x-api-key: <key>` header. When unset, auth is disabled (local dev only — never deploy without it).
- **Rate limiting**: per-IP, 30 requests/minute on `/api/v1/audits/*` by default. Configurable via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`.
- **CORS allowlist**: configurable via `CORS_ALLOWED_ORIGINS` (comma-separated). Defaults to `http://localhost:3000`. Never deploy with `*`.
- **Helmet headers**: standard secure HTTP headers enabled.

## Pre-commit guard

Run before committing if you ever convert this directory to a git repo:

```bash
bash scripts/check-secrets.sh
```

It greps tracked files for common credential patterns and exits non-zero on a hit.

## Defense-in-depth checklist before production

- [ ] All creds rotated
- [ ] Creds loaded from secret manager, not `.env` on disk
- [ ] `API_KEY` is set in production env
- [ ] `CORS_ALLOWED_ORIGINS` is restricted to your real frontend origin
- [ ] Database SSL `rejectUnauthorized` is `true` with the proper Redshift CA bundle pinned
- [ ] Run behind HTTPS (load balancer or reverse proxy)
- [ ] Logs do not echo `OPENAI_API_KEY` or DB password (search `process.env` logging)
- [ ] Add a `google-credentials.json` rotation cadence (Google service-account keys should rotate every 90 days)
