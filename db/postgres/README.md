# PostgreSQL schema (design only -- not applied)

`migrations/0001_init.sql` is the persistent-storage design for the v0.5 auth
and Seat Watch subsystem (`lib/auth`, `lib/watch`). It has never been run
against any database, is not referenced by any build or deploy step, and does
not require `pg` or any other new dependency to be added to `package.json`.

It is completely separate from `db/schema.ts` / `db/index.ts` at the
repository root, which is an unrelated, currently-empty Cloudflare
D1/SQLite schema (`drizzle.config.ts`'s `dialect: "sqlite"`) used only by the
ChatGPT Sites/Cloudflare Workers deployment path. Neither file was touched by
this PR.

## Trying it locally (optional, never against a real/shared database)

```bash
createdb railflow_dev
psql "postgres:///railflow_dev" -f db/postgres/migrations/0001_init.sql
```

## Mapping to the code

| Table | Backs |
| --- | --- |
| `users` | `lib/auth/types.ts` `AuthStore` (`AuthUser` + password hash) |
| `sessions` | `lib/auth/session.ts` (opaque bearer/cookie tokens -- only a hash is stored) |
| `devices` | `lib/watch/types.ts` `Device` |
| `watch_jobs` | `lib/watch/types.ts` `WatchJob` |
| `watch_job_candidates` | `lib/watch/types.ts` `TrainCandidate` |
| `watch_job_history` | `lib/watch/types.ts` `WatchJobHistoryEntry` |
| `notification_deliveries` | `lib/watch/types.ts` `NotificationDelivery` |
| `consent_history` | `lib/watch/types.ts` `ConsentHistoryEntry` |
| `audit_events` | `lib/watch/types.ts` `AuditEvent` |

## What a real adapter needs to implement

Two interfaces, both already defined and already the only thing every route
and the Worker talk to -- no route would need to change:

- `AuthStore` (`lib/auth/types.ts`), currently implemented in-memory by
  `lib/auth/memory-store.ts` and selected by `lib/auth/store.ts`'s
  `getAuthStore()`.
- The free functions exported by `lib/watch/store.ts` (`createWatchJob`,
  `getWatchJob`, `registerDevice`, `recordNotificationDelivery`, ...),
  currently backed by the in-memory Maps/arrays at the top of that file.

A Postgres-backed implementation of each, wired behind those same seams, plus
a real `DATABASE_URL` and running this migration, is what "영속 저장소" means
in practice. See `docs/adr/0002-auth-storage-notification.md` for the
comparison against alternatives (a managed Postgres, SQLite/Turso, staying
in-memory longer) and why Postgres was chosen.
