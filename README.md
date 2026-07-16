# Aula CRM — Backend (Node.js + Express + SQL Server / MySQL)

A standalone, metadata-driven backend service for the **Aula CRM** frontend. It
exposes the same versioned REST API the frontend already speaks (`/api/v1/**`),
but persists data in a **SQL database — Microsoft SQL Server or MySQL** (pick one
with `DB_CLIENT`) — instead of memory, and adds real **JWT authentication** (with
a dev-persona fallback for parity with the frontend's persona switcher).

It is a faithful port of the frontend's embedded backend (`src/lib/**`): the
proven metadata, permissions, query-engine, domain, finance and workflow layers
are reused verbatim; only the **data repository** (now a SQL database) and the
**HTTP layer** (now Express) are new.

> Guiding principle (unchanged): **UI = f(metadata + state + permissions + data
> + locale + featureFlags + tenantContext)**. Declaring an entity yields its
> table, CRUD endpoints, validation, RBAC/ABAC, PII projection, optimistic
> concurrency and lifecycle — no per-entity code.

---

## 1. Architecture

```
Express HTTP layer            src/http/**            server, routers, runApi wrapper
  │  (auth · rate limit · CSRF · error serialization · metrics)
Domain / Finance / Workflow   src/lib/{domain,finance,workflow}/**
  │  (lifecycle, invariants, audit, events, billing/AR)
Query Engine (gateway)        src/lib/data/query-engine.ts
  │  (tenant scope · permissions · validation · uniqueness · concurrency · PII)
SQL Repository                src/lib/data/sql/**       ← persistence adapter (dialect-driven)
  │  (parameterized SQL, metadata-generated tables; one dialect + driver per engine)
Microsoft SQL Server   ·   MySQL 8.0+ / MariaDB      ← selected by DB_CLIENT
```

- **Single data gateway:** every read/write flows through the `QueryEngine`,
  which enforces tenant isolation, RBAC/ABAC, metadata validation, unique
  constraints, optimistic concurrency and field-level PII projection. The
  repository below it is a "dumb", tenant-scoped persistence contract.
- **Metadata-driven DDL:** `src/lib/data/sql/ddl.ts` generates one typed table
  per entity (system columns + one column per field) with indexes on
  filterable/sortable fields and tenant-scoped unique indexes, rendered for the
  active engine by the dialect. Adding an entity = declaring metadata + running
  `npm run migrate`.
- **Injection-safe:** all values are bound as SQL parameters; identifiers are
  quoted per dialect (brackets on SQL Server, backticks on MySQL) and aggregation
  fields are whitelisted against metadata.
- **Two engines, one code path:** `DB_CLIENT` selects a dialect + driver
  (`mssql` → node-mssql, `mysql` → mysql2). The repository, DDL and migrator are
  written once against the dialect interface (`src/lib/data/sql/dialect.ts`).

## 2. Requirements

- **Node.js 20+** (developed on 22.x).
- **A SQL database — one of:**
  - **Microsoft SQL Server** 2016+ (or Azure SQL) with `DB_CLIENT=mssql`. You do
    **not** need to pre-create the database — `migrate` connects to `master` and
    creates `MSSQL_DATABASE` if missing (the login needs `CREATE DATABASE`, or a
    DBA pre-creates it and grants `CREATE TABLE`/`CREATE INDEX`). On Azure SQL,
    create the database via the portal and the create step is skipped.
  - **MySQL 8.0+** (or **MariaDB 10.2+**) with `DB_CLIENT=mysql`. `migrate`
    connects without a database and runs `CREATE DATABASE IF NOT EXISTS`
    (utf8mb4), or point `MYSQL_DATABASE` at a pre-created one. MySQL 8.0 is
    required for window functions (`COUNT(*) OVER()`).

## 3. Setup

```bash
npm install
cp .env.example .env      # then set DB_CLIENT=mssql|mysql and that engine's connection details
npm run setup             # = migrate + seed: creates the DB if missing,
                          #   provisions the schema, loads demo data (idempotent)
npm run dev               # start on http://localhost:4000 (tsx watch)
```

`npm run migrate` creates the database if it doesn't exist, then provisions the
schema; `npm run seed` loads demo data (skips if already populated). Both are
idempotent and safe to re-run.

`npm run dev`/`npm start` will also auto-migrate and auto-seed on boot when
`AULA_AUTO_MIGRATE` / `AULA_AUTO_SEED` are `true` (the default in development),
so the explicit `migrate`/`seed` steps are optional locally.

## 4. Environment variables

See [.env.example](.env.example). Key ones:

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `4000` |
| `CORS_ORIGINS` | Allowed origins (comma list or `*`) | `http://localhost:3000` |
| `DB_CLIENT` | **SQL engine: `mssql` or `mysql`** | `mssql` |
| `AULA_PERSISTENCE` | `sql` (durable, engine = `DB_CLIENT`) or `memory` | `sql` |
| `MSSQL_SERVER` / `MSSQL_PORT` | SQL Server host / port (when `DB_CLIENT=mssql`) | `localhost` / `1433` |
| `MSSQL_DATABASE` | Target database (auto-created if missing) | `aula_crm` |
| `MSSQL_USER` / `MSSQL_PASSWORD` | SQL login | `sa` / — |
| `MSSQL_ENCRYPT` | TLS (true for Azure SQL) | `false` |
| `MSSQL_TRUST_SERVER_CERTIFICATE` | Trust self-signed cert (on-prem/dev) | `true` |
| `MSSQL_INSTANCE` | Named instance (e.g. `SQLEXPRESS`); blank ⇒ host+port | — |
| `MYSQL_HOST` / `MYSQL_PORT` | MySQL host / port (when `DB_CLIENT=mysql`) | `localhost` / `3306` |
| `MYSQL_DATABASE` | Target database (auto-created if missing) | `aula_crm` |
| `MYSQL_USER` / `MYSQL_PASSWORD` | MySQL login | `root` / — |
| `MYSQL_SSL` | Connect over TLS (managed/cloud MySQL) | `false` |
| `MSSQL_POOL_MAX` / `MYSQL_POOL_MAX` | Max pooled connections | `10` |
| `AULA_JWT_SECRET` | HS256 signing secret (**required in prod**) | dev fallback |
| `AULA_JWT_TTL` | Token lifetime (seconds) | `3600` |
| `AULA_ENCRYPTION_KEY` | AES-256-GCM key (**required in prod**) | dev fallback |
| `AULA_DEV_AUTH` | Enable dev persona auth alongside JWT | `true` |
| `AULA_AUTO_MIGRATE` / `AULA_AUTO_SEED` | Provision/seed on boot | `true` |

In **production** (`NODE_ENV=production`) the app refuses to start with insecure
defaults: `AULA_JWT_SECRET`, `AULA_ENCRYPTION_KEY` and the active engine's
password (`MSSQL_PASSWORD` or `MYSQL_PASSWORD`) must be set and `AULA_DEV_AUTH`
must be `false`.

## 5. Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start with hot reload (tsx watch). |
| `npm start` | Start the server. |
| `npm run migrate` | Generate + apply the schema from metadata (idempotent). |
| `npm run seed` | Ensure schema, then seed demo data (idempotent). |
| `npm run typecheck` / `npm run build` | `tsc --noEmit`. |
| `tsx scripts/smoke.ts` | Offline check (metadata, DDL, app, JWT) — no DB needed. |

## 6. Authentication

Two modes, controlled by `AULA_DEV_AUTH`:

- **JWT (always on):** send `Authorization: Bearer <token>`. Tokens must carry
  `tenantId`, `orgId`, `roles`, `sub`. Mint one for a demo persona:

  ```bash
  curl -s localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
    -d '{"actor":"admin"}'      # actor: admin | manager | rep | accountant | globex
  # → { "token": "...", "tokenType": "Bearer", "expiresIn": 3600, "user": {...} }
  ```

- **Dev personas (when `AULA_DEV_AUTH=true`):** if no bearer token is present,
  the request is resolved from the `x-actor` header (or `aula_actor` cookie):
  `admin`, `manager`, `rep`, `accountant`. Send `x-tenant: t_globex` to act as
  the second tenant. This mirrors the frontend's persona switcher.

`GET /api/v1/auth/me` returns the resolved principal + scope + feature flags.

## 7. API

Base path `/api/v1`. The full surface from the frontend is preserved — generic
CRUD (`/entities/:entity`...), lifecycle transitions, audit, metadata,
aggregate, stats, activity, search, CSV import + export (`/export/:entity?format=csv|xlsx|pdf` — real .xlsx via exceljs, table PDF via pdfkit), leads convert, quotes &
invoices (master-detail) + payments + conversion, recurring billing, cron tick,
webhooks, notifications, admin governance/releases, and health. See the
frontend README §13 for the endpoint catalogue; the contract is identical.

Conventions: list params `?q=&page=&pageSize=&sort=field:dir&filter.<field>=v`;
mutations honour `If-Match: <version>` for optimistic concurrency and a
double-submit CSRF cookie (`aula_csrf` / `x-csrf-token`) when a cookie is set;
errors are `{ error: { code, message, details?, correlationId? } }`.

## 8. Persistence model

**Durable in the SQL database (SQL Server or MySQL):** all entity records (one
typed table per entity), document number sequences (`_seq_counter`, atomic),
file blobs (`_file_blob`), and the schema-version ledger (`_schema_migrations`).

**In-memory (per process, like the frontend's default):** audit log, the event
bus / outbox / idempotency, the search index, the stats cache, and the
webhook + notification registries. These are wired the same way the frontend
ships them; back them with SQL/Redis for full production durability (clear swap
points remain — see §9).

## 9. Production notes / swap points

| Concern | Default | Swap point |
|---|---|---|
| Persistence | `SqlRepository` (SQL Server / MySQL) | switch engines with `DB_CLIENT`, or implement `Repository` for another store |
| Auth | JWT + dev personas | `configureAuth()` / `jwtAuthenticator` (wire OIDC) |
| Cache | in-memory | `src/lib/cache/cache.ts` → Redis |
| Event bus | in-memory | `src/lib/workflow/event-bus.ts` → broker |
| Search | in-memory | `src/lib/search/engine.ts` → OpenSearch/Typesense |
| Audit / webhooks / notifications | in-memory | back with SQL tables for durability |

Because all enforcement lives above the repository, swapping persistence does
not change permission, validation, isolation or lifecycle behaviour.

## 10. Pointing the frontend at this backend

The frontend is wired to this backend out of the box (backend-for-frontend
proxy). The browser only ever talks to the Next.js origin; the frontend:

- proxies every `/api/v1/*` request to this service via `next.config.ts`
  (so client `apiFetch`, CSV export links and form posts reach the backend), and
- fetches data in server components directly from this service through its
  server-side `serverApi` helper, forwarding the caller's persona cookie /
  tenant / locale / bearer headers so the backend resolves the same principal.

Set `BACKEND_API_URL` in the frontend (default `http://localhost:4000`). Because
requests stay first-party through the Next proxy, no cross-origin cookies are
needed; the `CORS_ORIGINS` allow-list here remains useful if you ever call the
API directly from the browser.

### Run the whole stack locally (no database required)

```bash
# Terminal 1 — backend on :4000, in-memory persistence (no database needed)
cd Backend
npm install
AULA_PERSISTENCE=memory npm run dev        # seeds demo data on boot

# Terminal 2 — frontend on :3000
cd Frontend
npm install
BACKEND_API_URL=http://localhost:4000 npm run dev
```

Open http://localhost:3000. For durable storage, drop `AULA_PERSISTENCE=memory`,
set `DB_CLIENT=mssql` or `mysql`, and configure that engine's `MSSQL_*` / `MYSQL_*`
variables (see §3/§4).

This backend also exposes `GET /api/v1/jobs` (scheduled-job status for the
Automation screen) and accepts `GET /api/v1/activity?limit=N`.

## 11. Real integrations (email, files, chat)

The comms/productivity screens are backed by real infrastructure, all env-driven
and degrading gracefully when unconfigured:

| Integration | Endpoint(s) | Backed by | Config |
|---|---|---|---|
| **Email — send** | `POST /api/v1/email/send` | nodemailer (SMTP) | `SMTP_HOST/PORT/USER/PASS/FROM/SECURE` |
| **Email — receive** | `POST /api/v1/email/sync` | imapflow (IMAP) + mailparser | `IMAP_HOST/PORT/USER/PASS/SECURE/MAILBOX` |
| **Files — upload** | `POST /api/v1/files/upload` (multipart) | local disk | `UPLOAD_DIR` (default `<cwd>/uploads`) |
| **Files — download** | `GET /api/v1/files/:id/download` | local disk | — |
| **Chat — real-time** | `ws://<host>/ws/chat?actor=&tenant=` | `ws` WebSocket | `CORS_ORIGINS` (handshake origin) |

- **Email:** when `SMTP_*` is unset, compose just stores to the `sent` folder;
  when `IMAP_*` is unset, `/email/sync` is a no-op (`{configured:false}`). Set the
  vars to send/receive real mail. Bytes never touch the DB — only the parsed
  `email` rows do.
- **Files:** uploaded bytes are stored on disk keyed by the record id (metadata
  in the `file` table); deleting a `file` record removes its blob via a
  `file.deleted` event subscriber. Swap local disk for S3/Azure by reimplementing
  `src/lib/integrations/file-storage.ts`. 100 MB upload cap (keep the Next
  `experimental.proxyClientMaxBodySize` ≥ this so the proxy doesn't truncate).
  The file manager shows a live upload progress bar (XHR).
- **Chat:** the browser connects **directly** to this server's WebSocket (outside
  the Next proxy) at `/ws/chat`; inbound messages are persisted through the domain
  service (RBAC + validation + audit + events) and broadcast to every socket in
  the same tenant/org. Point the frontend at it with `NEXT_PUBLIC_WS_URL`
  (default `ws://localhost:4000`). The handshake origin is checked against
  `CORS_ORIGINS`. For multi-instance scale, back the broadcast with a Redis
  pub/sub.

Schema evolution: `migrate` is now additive — declaring a new field on an
existing entity adds the column (guarded `ALTER TABLE ... ADD`), so you don't
need to drop tables when metadata grows.

## 12. Authentication & screen access

Real credential login with a DB-backed users + positions model and a two-layer
authorization model:

- **Login:** `POST /api/v1/auth/login` with `{ email, password }` verifies the
  scrypt hash in the `user` table and sets an **httpOnly `aula_session` JWT
  cookie**. `POST /api/v1/auth/logout` clears it. `GET /api/v1/auth/me` returns
  the signed-in user, their position and their allowed screens. With no valid
  session, requests are unauthenticated (the Next middleware redirects pages to
  `/login`).
- **Positions (`position` table):** each position carries a **base role** (the
  data-RBAC role: admin / sales_manager / sales_rep / accountant) **and** a JSON
  list of **screens** it may open. Users (`user` table) belong to a position.
- **Two layers:** *screen access* (which pages a position can open) is enforced
  in the app shell (nav filtering + a 403 page) and is fully admin-configurable.
  *Data access* (which records/fields) is the base role's existing RBAC/ABAC.
  Grant a position screens whose data its base role can actually read.
- **Admin management:** Settings → **Positions** (`/settings/roles`) edits the
  screen matrix per position; Settings → **Users** (`/settings/users`) creates
  users, assigns positions and resets passwords. Endpoints: `GET /screens`,
  `GET|POST /admin/users`, `PATCH /admin/users/:id` (admin only).

Seeded on first boot (idempotent): 4 positions (Administrator / Sales Manager /
Sales Rep / Accountant) and 4 users (`avery@acme.test`, `morgan@acme.test`,
`riley@acme.test`, `casey@acme.test`) — **default password `Passw0rd!`** (change
in production). The frontend connects to the chat WebSocket; in production issue
a short-lived WS ticket instead of the dev `?actor=` param.
