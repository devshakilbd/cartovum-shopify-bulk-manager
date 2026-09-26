# Architecture

```
Shopify Admin (embedded iframe, App Bridge, Polaris web components)
   │  fetch /app/api/* with the session token
   ▼
React Router app (app/routes)            ← authenticate.admin on every request; shop from the token
   │  createOperation / createRevert / createDryRun / preview / search
   ▼
Engine (app/lib/core, platform-free TypeScript)
   │   Store interface            Gateway interface
   ▼                              ▼
PrismaStore (store.server.ts)     ShopifyGateway (gateway.server.ts) ──► Admin GraphQL 2026-07
SQLite (dev) / PostgreSQL (prod)
   ▲
Background worker (services.server.ts): claim lease → step (one batch of 10) → release
```

## Layers

- **`app/lib/core/`** holds every rule: filters, fingerprint, stock, attributes, conversion, preview and the operation engine. It imports nothing from Shopify or Prisma, so the whole behaviour is tested against `MemoryGateway` (an in-memory Shopify with failure injection) and `MemoryStore`.
- **`gateway.server.ts`** is the only code that speaks GraphQL. Fixed documents with variables; reads retried with bounded exponential backoff on throttling/5xx/network errors; writes attempted once.
- **`store.server.ts`** implements the Store with Prisma. Every query filters by shop.
- **`services.server.ts`** wires them and runs the worker.
- **Routes** are thin: parse input into closed shapes, call the engine, return JSON.

## An operation's life

1. **Create.** The request is validated (`parseOp`, stock status, selection). Explicit IDs are frozen as targets at once. *Select all matching* stores the filter snapshot with status `resolving`.
2. **Resolve** (select all / dry run). Each step reads one page of the catalogue, confirms matches exactly, and appends targets, until done or the cap is reached (reported).
3. **Process.** Each step takes the next 10 targets. Per product: read → rules → before-state saved on the target (`markWriting`) → write → **read back** → verify expected values → fingerprint compare → result saved. A write's success response is never taken as success.
4. **Stop** sets a flag; the next step ends the run. Nothing after the current batch is touched.
5. **Finish.** Counts and warnings are stored. A revert marks its source as put back.

## Concurrency, retries, idempotency

- The worker claims an operation with a compare-and-set lease (60 s), runs one step, releases it. Several server processes can run workers safely; a crashed process's lease expires and the work resumes.
- Targets are unique per operation, and each carries its state (`pending` → `writing` → `done`). A step never re-processes a `done` target.
- **Interrupted write**: a target left in `writing` is re-read before anything else. If it still equals the saved before-state, it is processed normally. If not, the write landed: it is recorded as *failed* with before and after (so Put back can undo it) and **never written again**.
- A step that throws is retried after the lease expires; after 5 consecutive failures the run is marked failed with the reason.
- Write transport failures are marked *uncertain* and resolved by reading back, never by retrying.

## Caching

Product data is never cached: every verification is a fresh read. The only cache is the local-attribute value list for dropdowns (12 h, per shop), dropped after any attribute, conversion or revert batch — the same rule as v1.3.9's transient.

## Billing readiness

No billing is required. Operation creation is a single function (`createOperation`), so a plan check can be added there later without touching the engine.
