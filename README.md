# TradeX Terminal v3

Multi-user trading intelligence platform — India (Groww) + Crypto (Delta
Exchange). Bloomberg-terminal-style UI, FastAPI backend, Supabase auth,
Upstash Redis state, admin audit trail.

This is the **production-hardened rebuild** of the v2 codebase. If you're
coming from v2, read `UPGRADING.md` and run `scripts/migrate_v2_keys.py`
before promoting.

---

## What changed vs v2

### Security — critical

| Issue in v2 | Fix in v3 |
|---|---|
| `CORSMiddleware(allow_origins=["*"], allow_credentials=True)` — invalid per spec; lets any site drive authed requests | Locked to `CORS_ALLOWED_ORIGINS` env var. Prod config rejects `*`. |
| `security.get_user_{groww,delta}_client` mutated `os.environ` per-request — concurrent users could cross-contaminate credentials | New `data/broker_factory.py` serializes under a module lock for the short construction window; credentials stay instance-scoped. |
| `/ws/live` had no authentication | JWT required as `?token=...`; token verified via cached verifier on every connect. |
| `decrypt_key` fell back to treating the input as plaintext when it didn't look encrypted | v3 ciphertexts carry a `"TXV"` magic header. Non-v3 inputs return `""`, never guesses. |
| No rate limiting | Per-endpoint limits for admin (30/min), user (120/min), scan (5/min). |
| No audit trail for admin actions | `audit_log` table records actor, action, target, redacted details, IP, request ID. |
| Supabase client rebuilt every request (2 clients per auth check) | Shared admin + anon clients, JWT verification cached for 60s with invalidation on deactivation. |
| Secrets returned to the `GET /user/config` endpoint (partial mask) | Never decrypted for display; masked at the API boundary. |

### Reliability

- `/health` is now a cheap liveness probe (no I/O).
- New `/ready` endpoint checks Supabase + state-store and returns 503 when degraded.
- `RequestIDMiddleware` threads a request ID through every log line.
- Structured JSON logs in prod, pretty logs in dev.
- Global exception handler returns `500 {error, request_id}` instead of leaking internals.
- Graceful rollback: if `users` insert fails during user creation, the auth user is deleted.

### Frontend

- **Bug fix**: `TickerStrip.jsx` had the entire `FunctionBar` component pasted into it — removed.
- `ErrorBoundary` at the top level plus per-panel boundaries so one crashed panel doesn't take down the terminal.
- `useWebSocket` now: sends auth token, exponential backoff with jitter, 30s heartbeat with auto-reconnect, reconnects on Supabase token refresh.
- `MOCK_*` fallback data now only renders in dev — prod shows empty states so users never mistake fake signals for real ones.
- Kill-switch requires confirmation before firing (v2 fired on single click).
- Real command parser with autocomplete and slash-commands (`/users`, `/settings`, `/logout`, `HELP`).
- F1–F9 hotkeys bound via `useHotkeys` (ignores presses in inputs).
- 401 responses auto-sign-out; 429 shows Retry-After; 5xx dedupes toasts.

### Deployment

- Multi-stage `Dockerfile`, non-root UID 10001, tini PID 1, healthcheck.
- `.dockerignore` + documented `.env.example` for both backend and frontend.
- Migration script `scripts/migrate_v2_keys.py` for rotating existing ciphertexts.
- **16 passing pytest tests** cover encryption, tamper detection, masking, and audit redaction.

---

## Repo layout

```
tradex_v3/
├── backend/
│   ├── api.py                    # FastAPI v3 — locked CORS, authed WS, rate limits, audit
│   ├── main.py                   # CLI entry (api / scheduler / test / scan)
│   ├── scheduler.py              # Background worker (unchanged)
│   ├── core/
│   │   ├── config.py             # Pydantic-validated settings
│   │   ├── supabase_pool.py      # Cached clients + JWT verification cache
│   │   ├── security.py           # AES-GCM, "TXV" magic header, mask_secret
│   │   ├── ratelimit.py          # Per-user/IP fixed-window limiter
│   │   ├── logging_config.py     # JSON logs in prod, request-ID ContextVar
│   │   ├── audit.py              # Admin audit trail with secret redaction
│   │   ├── database.py           # Supabase CRUD helpers (unchanged)
│   │   └── state_store.py        # Upstash Redis wrapper (unchanged)
│   ├── data/
│   │   ├── broker_factory.py     # NEW — thread-safe per-user client factory
│   │   ├── groww_client.py       # unchanged
│   │   ├── delta_client.py       # unchanged
│   │   └── ...
│   ├── agents/                   # unchanged from v2
│   ├── notifications/            # unchanged from v2
│   ├── scripts/
│   │   └── migrate_v2_keys.py    # NEW — one-shot v2→v3 ciphertext rotation
│   ├── tests/                    # pytest: security, audit redaction
│   ├── Dockerfile                # production
│   ├── .dockerignore
│   ├── .env.example              # every env var documented
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── main.jsx              # + top-level ErrorBoundary
│   │   ├── App.jsx               # cleaner auth bootstrap
│   │   ├── lib/
│   │   │   ├── supabase.js       # split from api.js
│   │   │   └── api.js            # axios + interceptors (401, 429, 5xx, retry-id)
│   │   ├── store/index.js        # + wsState, news dedupe
│   │   ├── hooks/index.js        # useWebSocket (authed), useHotkeys, useISTClock
│   │   ├── components/
│   │   │   ├── common/
│   │   │   │   ├── ErrorBoundary.jsx
│   │   │   │   ├── LoadingSkeleton.jsx    # + EmptyState + ConnectionStatus
│   │   │   │   └── ConfirmDialog.jsx
│   │   │   ├── terminal/
│   │   │   │   ├── CommandBar.jsx         # parser + autocomplete + slash-cmds
│   │   │   │   ├── TickerStrip.jsx        # bug-fixed
│   │   │   │   ├── FunctionBar.jsx        # + connection status pill
│   │   │   │   └── Watchlist.jsx          # dev-only mocks
│   │   │   ├── risk/RiskPanel.jsx         # kill-switch confirm dialog
│   │   │   ├── signals/SignalDetail.jsx
│   │   │   ├── news/IntelFeed.jsx
│   │   │   ├── settings/SettingsPage.jsx
│   │   │   └── users/UsersPage.jsx
│   │   └── pages/{Login,Terminal}.jsx
│   ├── vite.config.js            # dev proxy + manual chunks
│   ├── .env.example
│   ├── package.json
│   └── index.html
├── docs/
│   ├── SETUP.md
│   └── supabase_schema.sql       # add audit_log table — see core/audit.py
└── render.yaml
```

---

## Deploying

### 1. Database migration

Apply the schema SQL in `docs/supabase_schema.sql`, plus the new `audit_log` table
documented at the top of `backend/core/audit.py`:

```sql
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_id    UUID REFERENCES users(id),
    actor_email TEXT,
    action      TEXT NOT NULL,
    target      TEXT,
    details     JSONB,
    ip          TEXT,
    request_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);
```

### 2. Env vars

Copy `backend/.env.example` → `backend/.env` and fill in. Generate the encryption key:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

The same key used in v2 can be reused (ciphertexts are rotated, not re-encrypted with
a new key). If you want to rotate the key too, run the migration with the old key first,
then re-encrypt with the new key — ping me and I'll write the two-phase script.

### 3. Migrate existing broker keys

```bash
cd backend
python -m scripts.migrate_v2_keys --dry-run    # preview
python -m scripts.migrate_v2_keys --apply      # execute
```

Idempotent — safe to re-run. Already-v3 rows are skipped.

### 4. Build and deploy

```bash
# Backend
cd backend
docker build -t tradex-api .
docker run -p 8000:8000 --env-file .env tradex-api

# Frontend
cd frontend
npm ci
npm run build
# Serve dist/ on any static host with SPA fallback to index.html
```

### 5. Production env checklist

- `ENVIRONMENT=prod` — triggers strict validation, disables `/docs`, switches logs to JSON.
- `CORS_ALLOWED_ORIGINS=https://app.tradex.example` — no wildcards in prod (enforced).
- `ENCRYPTION_KEY` — 64-char hex.
- `SUPABASE_SERVICE_KEY` — service-role key; keep out of git.
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — state store; in-memory fallback is dev-only.

---

## Running tests

```bash
cd backend
pip install -r requirements.txt
pytest tests/ -v
```

Currently 16 tests passing. CI is not yet configured — adding a GitHub Actions workflow
is a ~15-line task.

---

## Known remaining work

- `SignalDetail.jsx`, `IntelFeed.jsx`, `SettingsPage.jsx`, `UsersPage.jsx` are copied
  unchanged from v2; they work, but could use the dev-only-mocks + empty-state +
  loading-skeleton treatment the other components got.
- The underlying Groww/Delta client classes still read env at import time. The factory
  handles this correctly via a short lock window, but native per-instance credentials
  would be cleaner.
- No GitHub Actions CI yet.
- No frontend tests.
