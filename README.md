# Aula — Backend (Node.js · Express · SQL Server / MySQL)

Stock, inventory, sales and financial reporting for a single company. A
metadata-driven service: declaring an entity yields its table, CRUD endpoints,
validation, RBAC/ABAC, PII projection, optimistic concurrency and lifecycle —
no per-entity code.

> **UI = f(metadata + state + permissions + data + locale + featureFlags + tenantContext)**

Roughly 27,000 lines across 75 entities and 154 endpoints, on either SQL Server
or MySQL behind one code path.

---

## 1. Architecture

```
Express HTTP layer            src/http/**           server, router, runApi wrapper
  │  (edge rate limit · auth · CSRF · error serialisation · metrics · realtime)
Domain / Finance / Inventory  src/lib/{domain,finance,inventory,accounting}/**
  │  (lifecycle, invariants, costing, GL postings, audit, outbox events)
Query Engine (gateway)        src/lib/data/query-engine.ts
  │  (tenant scope · permissions · validation · uniqueness · concurrency · PII)
SQL Repository                src/lib/data/sql/**   persistence adapter (dialect-driven)
  │
SQL Server   ·   MySQL 8.0+ / MariaDB               selected by DB_CLIENT
```

**Single data gateway.** Every read and write goes through the `QueryEngine`.
Tenant isolation, RBAC/ABAC, metadata validation, unique constraints, optimistic
concurrency and field-level PII projection live there and nowhere else. The
repository below it is a dumb, tenant-scoped persistence contract.

**Metadata-driven DDL.** `src/lib/data/sql/ddl.ts` generates one typed table per
entity, with indexes on filterable/sortable fields and tenant-scoped unique
indexes. On boot the migrator either provisions everything (first run, or after a
`SCHEMA_VERSION` bump) or reconciles: it introspects the live schema in one query
and emits DDL only for genuine differences. Adding an entity or a nullable field
needs no version bump — it appears on the next boot.

**Two engines, one code path.** `DB_CLIENT` selects a dialect and driver
(`mssql` → node-mssql, `mysql` → mysql2). Repository, DDL and migrator are
written once against `src/lib/data/sql/dialect.ts`. Every value is bound as a
parameter; identifiers are quoted per dialect and aggregation fields are
whitelisted against metadata.

## 2. Requirements

- **Node.js 20+** (developed on 22.x)
- **One SQL engine:**
  - **SQL Server 2016+** / Azure SQL with `DB_CLIENT=mssql`. The database is
    created for you if the login has `CREATE DATABASE`; on Azure SQL create it in
    the portal and that step is skipped.
  - **MySQL 8.0+** / **MariaDB 10.2+** with `DB_CLIENT=mysql`. MySQL 8.0 is the
    floor because the repository uses window functions (`COUNT(*) OVER()`).

## 3. Setup

```bash
npm install
cp .env.example .env       # set DB_CLIENT and that engine's connection details
npm run setup              # migrate + seed (idempotent)
npm run dev                # http://localhost:4000
```

`AULA_ADMIN_PASSWORD` has **no default**. Outside production a well-known dev
value is used and announced loudly on the boot that creates the account;
production refuses to start without one. A shipped default password is a
published credential.

| Script | What it does |
| --- | --- |
| `npm run dev` | tsx watch |
| `npm start` | run once |
| `npm run migrate` | provision/reconcile the schema |
| `npm run seed` | demo data (idempotent) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm test` | node:test — offline, no database needed |
| `npm run retenant` | re-scope existing rows to a new tenant/org |

## 4. Configuration

Everything is validated at startup by `src/lib/config/env.ts`; see `.env.example`
for the full annotated list. The settings most worth understanding:

| Variable | Notes |
| --- | --- |
| `DB_CLIENT` | `mssql` (default) or `mysql`. Ignored when `AULA_PERSISTENCE=memory`. |
| `AULA_PERSISTENCE` | `sql` (default) or `memory` — process-local, for local dev, CI and tests. |
| `AULA_ADMIN_EMAIL` / `AULA_ADMIN_PASSWORD` | Bootstrap administrator. No default password. |
| `AULA_TRUST_PROXY` | Number of reverse-proxy hops. **Security setting** — see below. |
| `AULA_EDGE_RATE_LIMIT` | Requests per minute per client IP (default 3000). |
| `AULA_BASE_CURRENCY` | Currency the ledger is kept in. Defaults to `TRY`. |
| `AULA_ALLOW_NEGATIVE_STOCK` | `false` (default) rejects an issue that would drive on-hand negative. |
| `AULA_AUTO_MIGRATE` | DDL on boot. **Production refuses to start with this on** — migration is a deploy step. |
| `AULA_LOG_LEVEL` | `debug` outside production, `info` in it. |

**`AULA_TRUST_PROXY` deserves a paragraph.** Express derives `req.ip` from
`X-Forwarded-For`, and the client writes that header — only hops you actually
trust may overwrite it. Set it to the number of proxies in front of the process
(`1` behind a single nginx, `2` behind a CDN as well), or to a list of trusted
ingress IPs/CIDRs. The default trusts nothing, which is correct for a direct
listener. Setting it to `true` makes `req.ip` whatever the caller types, which
silently defeats the login brute-force throttle and the edge rate limit; the
server logs a warning if you do.

In production the startup check also refuses: a weak `AULA_JWT_SECRET` or
`AULA_ENCRYPTION_KEY`, a missing database password, `CORS_ORIGINS=*` (it is
reflected with credentials enabled), and `MSSQL_TRUST_SERVER_CERTIFICATE=true`
(it disables TLS verification).

## 5. Authentication

JWT only. `POST /auth/login` returns a token and sets an httpOnly session cookie;
subsequent requests use either. There is no dev-persona bypass — the resolver
authenticates or throws.

- Login is throttled per source IP and per email address, with the email lock
  cleared on success.
- Mutations enforce a double-submit CSRF token when the client presents the
  cookie (i.e. a browser).
- Optional TOTP two-factor per user.

## 6. Rate limiting

Two limiters on different axes, both wanted:

- **Edge** (`src/lib/security/edge-rate-limit.ts`) — per client IP, every route,
  as Express middleware ahead of body parsing. This exists because `runApi`
  authenticates *first*: an unauthenticated request threw before the
  per-principal counter was reached, so credential stuffing was never limited at
  all. The liveness probe is exempt — an orchestrator cannot back off, and
  limiting it turns a traffic spike into a restart loop.
- **Per principal** (`runApi`) — per user *and* per path. An IP limit cannot
  express "this account is hammering one endpoint", and in an office everyone
  shares one NAT address.

## 7. Inventory and costing

Costing is **perpetual moving weighted average** (VUK-compliant, and the method
Logo/Mikro/Netsis default to, so an accountant can reconcile against it).

Two rules the code depends on:

- **`avgCost` is display only.** The authoritative pair is (`qty`, `value`), and
  issue cost is consumed proportionally: `value × q / qty`. This guarantees
  `qty → 0 ⟹ value → 0` to the cent. Deriving issue cost from a stored 2-decimal
  average instead lets rounding accumulate until the Inventory account carries a
  balance with no units behind it.
- **The GL and the stock ledger never compute the same number twice.**
  `writeMovement` returns the value it applied, and the posting layer uses that
  figure rather than recalculating one. `stock-reconcile` (nightly, report-only)
  asserts the two still agree; drift means a bug, so it reports rather than
  quietly repairing.

Negative-stock protection is a locked read of the balance row
(`UPDLOCK, ROWLOCK, HOLDLOCK` / `FOR UPDATE`), not a plain read plus retry — a
retry inside the same transaction re-reads the same stale snapshot on MySQL.

## 8. Turkish compliance

- Tekdüzen Hesap Planı (100/101/102/103/120/121/153/191/320/321/326/391/600/621/…)
- Input vs output VAT kept apart (191 / 391), `devreden KDV` carried forward
- KDV tevkifat: withheld VAT is a separate posting, not a reduced one
- VKN/TCKN check-digit validation
- Cheques and notes (`çek`/`senet`) with their own lifecycle and GL treatment
- e-Fatura / e-Arşiv: UBL-TR 1.2 documents are built, validated, numbered and
  stored with **no integrator configured**. Choosing a provider means writing one
  adapter against `EInvoiceIntegrator` (`isRegistered` / `send` / `status`).
  Until then transmission fails loudly — an invoice marked sent that the tax
  office never received is worse than one that was never sent.

## 9. Realtime

A WebSocket at `/ws` carries change notices. Screens use it to stop polling
blind; the notification bell and the register queue keep a slower timer as a
backstop, because a socket can die without either end noticing.

**It carries signals, not records.** The frame is `{ type, entity, id, at }` and
the client refetches through the normal API, where the permission checks apply.
Piping event payloads down the socket would hand every listener a copy of records
that never passed through the authorisation layer.

Authentication happens during the HTTP upgrade: `POST /realtime/ticket` mints a
single-use ticket that expires in 30 seconds, because a browser cannot set an
`Authorization` header on `new WebSocket(...)` and the query string is the only
channel it controls.

## 10. Scheduled jobs

Registered in `src/lib/jobs/scheduler.ts`, run in-process and also reachable via
`POST /cron/tick`. All are idempotent.

| Job | Cadence | Purpose |
| --- | --- | --- |
| `billing-run` | daily | Recurring invoices |
| `mark-overdue` | daily | Move past-due invoices to `overdue` |
| `outbox-recovery` | frequent | Redeliver events stranded by a crash |
| `retention` | daily | Prune delivery logs, published events, notifications |
| `stock-reconcile` | daily | Assert balances still equal the ledger (report-only) |
| `stock-alerts` | daily | Open/close `stockAlert` records from stock conditions |
| `calendar-due-dates` | daily | Project PO/invoice/bill dates onto the calendar |

`stock-alerts` is worth a note: it opens an alert **once** when a condition
starts holding and closes it when it stops. Re-announcing the same shortage every
night is how an alert channel gets muted, taking the urgent messages with it.
Opening one emits `stockAlert.created`, which the automation rules act on — who
gets told and through which channel is a rule, not code.

## 11. Testing

```bash
npm test          # 167 tests, offline
```

Every test runs without a database — pure functions plus the in-memory
repository, plus HTTP-level tests that boot the real Express app on an ephemeral
port. The suite deliberately concentrates on the places where a silent error
costs money: costing arithmetic, the chart of accounts, VAT and tevkifat, UBL-TR
serialisation, paging limits, and the realtime fan-out's negative cases (no
records on the wire, nothing across a tenant boundary).

## 12. Deployment

`Dockerfile` builds a production image; `AULA_AUTO_MIGRATE` must be off, so run
`npm run migrate` as a deliberate deploy step. `.github/workflows/ci.yml` gates
typecheck, lint and tests.

Graceful shutdown closes realtime sockets first — `server.close()` waits for open
connections to end, and a WebSocket never ends on its own — then drains in-flight
requests before tearing down the pool.
