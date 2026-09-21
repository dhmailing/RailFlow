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
--
-- `verified`: whether ownership of this destination has actually been
-- confirmed. fcm/webpush tokens are issued by the browser/OS itself (not
-- freely typable as someone else's), so the application layer sets this
-- true immediately on registration for those two channels; email/telegram
-- default to false until a real ownership-verification flow exists (none
-- does yet in this PR) -- see lib/watch/store.ts's registerDevice and
-- lib/watch/notification/dispatch.ts, which refuses to actually send while
-- false (recorded as a 'skipped_unverified' notification_deliveries row).
create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  channel text not null check (channel in ('fcm', 'webpush', 'telegram', 'email')),
  token text not null,
  verified boolean not null default false,
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
  -- "다시 감시"를 누를 때마다 애플리케이션이 1씩 증가시키는 세대 카운터
  -- (lib/watch/worker.ts의 resumeWatching). notification_deliveries의
  -- 멱등키 구성에 포함돼, 재감시 이후 같은 후보가 다시 발견되면 이전 세대의
  -- 멱등키와 충돌하지 않고 새 알림이 나가게 한다(§6 검토사항).
  watch_cycle integer not null default 0,
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
-- 동시 선택"). `id` is always server-generated (gen_random_uuid()) -- the
-- application (lib/watch/store.ts's createWatchJob) never accepts a
-- client-supplied value for it, only for `external_key` below. This closes
-- the mismatch the §7 review found: the application used to let clients
-- pass an arbitrary string as `id` even though this column is `uuid`.
create table watch_job_candidates (
  id uuid primary key default gen_random_uuid(),
  watch_job_id uuid not null references watch_jobs (id) on delete cascade,
  -- The client/source-schedule identifier for this same train (e.g. a
  -- v0.3/TAGO search-result key). Opaque to this table; unique per job so
  -- the same train cannot be listed twice as a candidate on one WatchJob.
  external_key text not null,
  train_number text not null,
  train_type text not null,
  depart_at timestamptz not null,
  arrive_at timestamptz not null,
  -- Only ever read by the mock Seat Availability Provider (lib/watch/mock-seat-provider.ts).
  -- Must be null for every row a real Provider ever produces.
  mock_scenario text check (mock_scenario in ('seat_after_one_check', 'no_seat_ever', 'error_on_check')),
  constraint watch_job_candidates_external_key_uniq unique (watch_job_id, external_key)
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
-- device_id + watch_cycle are stored as their own columns (not just folded
-- into idempotency_key) so a real adapter can query/audit "did this specific
-- device already get notified this cycle" without parsing the key string --
-- §6 검토사항: 이전에는 idempotency_key가 jobId:candidateId:eventType뿐이라
-- 여러 채널/기기가 하나의 키를 공유해, 첫 성공 알림이 나머지를 모두
-- 억제해버렸다. 이제 idempotency_key 자체도 channel+device_id+watch_cycle을
-- 포함하도록 애플리케이션(lib/watch/worker.ts)이 구성한다.
create table notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  watch_job_id uuid not null references watch_jobs (id) on delete cascade,
  candidate_id uuid references watch_job_candidates (id) on delete set null,
  channel text not null check (channel in ('fcm', 'webpush', 'telegram', 'email')),
  device_id uuid not null references devices (id) on delete cascade,
  watch_cycle integer not null default 0,
  event_type text not null check (
    event_type in ('seat_found', 'watch_started', 'watch_expired', 'auth_required', 'provider_unavailable', 'duplicate_job_blocked', 'system_halted', 'booking_confirmation_requested')
  ),
  idempotency_key text not null,
  status text not null check (status in ('delivered', 'failed', 'skipped_duplicate', 'skipped_unverified')),
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
-- docs/adr/0002). `metadata` must never contain secrets, tokens, or raw
-- notification destinations (enforced by convention at the call sites in
-- lib/watch/store.ts, not by the database).
--
-- §8 검토사항: 계정 삭제 시 `user_id`를 원래 계정과 무관한 새 무작위 값으로
-- 되돌릴 수 없이 교체한다(pseudonymization -- lib/watch/store.ts의
-- pseudonymizeAuditEventsForUser 참고). "userId만 남아서 개인정보가 아니다"라고
-- 가정하지 않기 위함이며, 대안(일정 보존기간 후 삭제)은 채택하지 않았다.
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
