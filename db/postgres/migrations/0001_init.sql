-- RailFlow v0.5 -- PostgreSQL schema design for the auth + Seat Watch subsystem.
--
-- STATUS: design only. This file has never been run against any database,
-- real or otherwise, and is not wired into any build/deploy step or into
-- the existing db/schema.ts (which is a separate, unrelated, currently-empty
-- Cloudflare D1/SQLite schema for the ChatGPT Sites deployment -- see
-- drizzle.config.ts's dialect: "sqlite"). To try this against a throwaway
-- local Postgres instance:
--   psql "$DATABASE_URL" -f db/postgres/migrations/0001_init.sql
-- See docs/V0.5-SEAT-WATCH.md and docs/adr/0002-auth-storage-notification.md
-- for the reasoning behind these tables.

begin;

create extension if not exists pgcrypto; -- gen_random_uuid()
create extension if not exists citext;   -- case-insensitive email column

-- === users ===================================================================
-- Backs lib/auth/types.ts's AuthStore. The in-memory implementation shipped in
-- this PR hard-deletes this row on account deletion; a real deployment should
-- prefer a soft delete (set deleted_at, scrub email/password_hash) instead, so
-- that audit_events.user_id below keeps meaning something after deletion
-- without needing an enforced foreign key into a row that no longer exists.
create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- === sessions =================================================================
-- Opaque server-side session tokens (lib/auth/session.ts). Only a hash of the
-- token is stored -- never the raw value -- so a database read alone can never
-- produce a usable session token. Deleting a row revokes that session
-- immediately; deleting every row for a user_id revokes all of that user's
-- sessions (logout-everywhere / account deletion).
create table sessions (
  token_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

-- === devices ===================================================================
-- A notification destination the user registered (§3-B Device entity).
-- `token` is channel-specific: FCM registration token, WebPush subscription
-- JSON, Telegram chat id, or an email address.
create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  channel text not null check (channel in ('fcm', 'webpush', 'telegram', 'email')),
  token text not null,
  label text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, channel, token)
);
create index devices_user_id_idx on devices (user_id);

-- === watch_jobs ================================================================
-- The core Seat Watch entity (lib/watch/types.ts's WatchJob).
create table watch_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  departure text not null,
  arrival text not null,
  departure_id text not null,
  arrival_id text not null,
  date date not null,
  time_range_start time not null,
  time_range_end time not null,
  train_type text not null,
  passengers integer not null check (passengers between 1 and 4),
  seat_class_preference text not null check (seat_class_preference in ('standard_only', 'standard_preferred', 'any')),
  watch_until timestamptz not null,
  status text not null check (
    status in ('REGISTERED', 'WATCHING', 'SEAT_FOUND', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'FAILED')
  ),
  seat_provider text not null check (seat_provider in ('unavailable', 'mock')),
  simulation boolean not null default false,
  found_candidate_id uuid, -- FK added after watch_job_candidates exists, see below
  found_at timestamptz,
  attempts integer not null default 0,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index watch_jobs_user_id_idx on watch_jobs (user_id);

-- Same dedupe rule as lib/watch/store.ts's hasActiveDuplicate: at most one
-- non-terminal job per (user, route, date, passengers). A partial unique
-- index enforces it at the database level too, not just in application code.
create unique index watch_jobs_active_dedupe_idx
  on watch_jobs (user_id, departure_id, arrival_id, date, passengers)
  where status not in ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- === watch_job_candidates ======================================================
-- TrainCandidate (§3-B). A job can watch several trains at once ("여러 열차
-- 동시 선택").
create table watch_job_candidates (
  id uuid primary key default gen_random_uuid(),
  watch_job_id uuid not null references watch_jobs (id) on delete cascade,
  train_number text not null,
  train_type text not null,
  depart_at timestamptz not null,
  arrive_at timestamptz not null,
  -- Only ever read by the mock Seat Availability Provider (lib/watch/mock-seat-provider.ts).
  -- Must be null for every row a real Provider ever produces.
  mock_scenario text check (mock_scenario in ('seat_after_one_check', 'no_seat_ever', 'error_on_check'))
);
create index watch_job_candidates_job_id_idx on watch_job_candidates (watch_job_id);

alter table watch_jobs
  add constraint watch_jobs_found_candidate_fkey
  foreign key (found_candidate_id) references watch_job_candidates (id) on delete set null;

-- === watch_job_history ==========================================================
-- JobStatusHistory (§3-B) -- one row per state transition, append-only.
create table watch_job_history (
  id uuid primary key default gen_random_uuid(),
  watch_job_id uuid not null references watch_jobs (id) on delete cascade,
  at timestamptz not null default now(),
  from_status text,
  to_status text not null,
  reason text not null
);
create index watch_job_history_job_id_idx on watch_job_history (watch_job_id, at);

-- === notification_deliveries ====================================================
-- NotificationDelivery (§3-B). Idempotency is enforced per user via a partial
-- unique index on 'delivered' rows only -- a 'failed' attempt is retryable
-- (see lib/watch/notification/dispatch.ts and store.ts's comment on why only
-- a successful send may poison the idempotency key).
create table notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  watch_job_id uuid not null references watch_jobs (id) on delete cascade,
  candidate_id uuid references watch_job_candidates (id) on delete set null,
  channel text not null check (channel in ('fcm', 'webpush', 'telegram', 'email')),
  event_type text not null check (
    event_type in ('seat_found', 'watch_started', 'watch_expired', 'auth_required', 'provider_unavailable', 'duplicate_job_blocked', 'system_halted', 'booking_confirmation_requested')
  ),
  idempotency_key text not null,
  status text not null check (status in ('delivered', 'failed', 'skipped_duplicate')),
  delivery_ref text,
  created_at timestamptz not null default now()
);
create index notification_deliveries_user_id_idx on notification_deliveries (user_id, watch_job_id);
create unique index notification_deliveries_delivered_idempotency_idx
  on notification_deliveries (user_id, idempotency_key)
  where status = 'delivered';

-- === consent_history =============================================================
-- ConsentHistory (§3-B) -- append-only; never updated or deleted except by a
-- full account deletion cascade.
create table consent_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  consent_type text not null check (consent_type in ('no_ticket_sale_disclaimer', 'notification_permission')),
  granted boolean not null,
  at timestamptz not null default now()
);
create index consent_history_user_id_idx on consent_history (user_id);

-- === audit_events =================================================================
-- AuditEvent (§3-B). Deliberately NOT a foreign key into users: this table is
-- meant to survive account deletion for security/audit integrity (see
-- docs/adr/0002). `user_id` becomes an orphaned reference once the owning
-- account is deleted; `metadata` must never contain secrets, tokens, or raw
-- notification destinations (enforced by convention at the call sites in
-- lib/watch/store.ts, not by the database).
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  action text not null check (
    action in ('user_signup', 'user_login', 'user_logout', 'user_deleted', 'watch_job_created', 'watch_job_cancelled', 'watch_job_completed', 'device_registered')
  ),
  target_id text,
  at timestamptz not null default now(),
  metadata jsonb
);
create index audit_events_user_id_idx on audit_events (user_id, at);

commit;
