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

-- === notification_deliveries (Outbox/Claim 테이블) ===============================
-- NotificationDelivery (§3-B). (검토 재반영, §6) 이 테이블은 append-only 로그가
-- 아니라 "Outbox"다 -- (user_id, idempotency_key) 조합마다 정확히 한 행만
-- 존재하고, 그 행의 status를 원자적으로 전이시키는 것 자체가 "발송 권한
-- (claim)"이다. 재검토 이전 설계는 "hasDeliveredNotification()으로 확인 ->
-- 어댑터 발송(await) -> 성공 시에만 별도 unique index로 저장"이었는데,
-- **확인과 저장 사이의 await 구간**에서 두 Worker가 동시에 같은 알림을
-- 처리하면 (예: Worker 인스턴스 두 개가 겹쳐 실행) 둘 다 "아직 안 보냈다"는
-- 확인을 통과해버릴 수 있었다. 그 시점에는 이미 외부로 알림이 두 번
-- 나간 뒤이므로, 발송 *이후*에 unique index 충돌이 나도 중복 발송 자체는
-- 막지 못한다.
--
-- 해결책: 발송 "전"에 이 행을 원자적으로 claim한다. 애플리케이션
-- (lib/watch/store.ts의 claimNotification)이 하는 일을 SQL로 옮기면:
--
--   -- 1) 새 알림이면 이 INSERT 하나가 곧 claim이다. 동시에 여러 요청이
--   --    똑같은 (user_id, idempotency_key)로 이 문장을 실행해도, Postgres는
--   --    유니크 제약을 행 삽입 시점에 검사하므로 정확히 하나만 성공한다.
--   --    $9는 이 claim을 위해 애플리케이션이 새로 생성한 무작위 claim_token이다.
--   insert into notification_deliveries
--     (user_id, watch_job_id, candidate_id, channel, device_id, watch_cycle,
--      event_type, idempotency_key, claim_token, status, attempt_count, locked_at, lock_expires_at)
--   values
--     ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'sending', 1, now(), now() + interval '30 seconds')
--   on conflict (user_id, idempotency_key) do nothing
--   returning *;
--   -- 0행이 반환되면(이미 존재) 아래로 진행한다.
--
--   -- 2) 기존 행을 읽어 duplicate/already_claimed/재시도 가능 여부를 판단한다.
--   select * from notification_deliveries where user_id = $1 and idempotency_key = $8;
--   --   status = 'delivered' 또는 'skipped_unverified' -> duplicate(그대로 반환, claim 안 함)
--   --   status = 'sending' and lock_expires_at > now()   -> already_claimed(다른 Worker가 처리 중)
--   --   status = 'sending' and lock_expires_at <= now()  -> 방치된 claim, 아래 3)으로 재획득 시도
--   --   status = 'failed'  and next_attempt_at <= now()  -> 재시도 가능, 아래 3)으로 재획득 시도
--   --   status = 'failed'  and next_attempt_at >  now()  -> already_claimed(아직 재시도 시각 아님)
--
--   -- 3) 조건부 UPDATE로 재획득을 시도한다 -- WHERE 절의 조건이 여전히
--   --    참이어야만 실제로 행을 갱신하고 반환하므로(Postgres의 행 잠금이
--   --    동시 요청 중 하나만 통과시킨다), 이 UPDATE 자체가 원자적 claim이다.
--   --    $9는 이번 재획득을 위해 새로 생성한 claim_token -- 이전 토큰을 쥔
--   --    Worker가 뒤늦게 돌아와도 4)의 CAS 조건에서 걸러지도록 반드시 교체한다.
--   update notification_deliveries
--   set status = 'sending', attempt_count = attempt_count + 1, claim_token = $9,
--       locked_at = now(), lock_expires_at = now() + interval '30 seconds',
--       updated_at = now()
--   where user_id = $1 and idempotency_key = $8
--     and (
--       (status = 'sending' and lock_expires_at <= now())
--       or (status = 'failed' and next_attempt_at <= now())
--     )
--   returning *;
--   -- 0행이 반환되면 다른 Worker가 먼저 재획득에 성공한 것이므로
--   -- already_claimed로 취급하고 어댑터를 호출하지 않는다.
--
--   -- 4) claim에 성공한 호출자(claim_token을 기억해둔 쪽)만 실제 어댑터를
--   --    호출하고, 끝나면 종료 상태로 전이한다. **핵심은 WHERE 절의
--   --    `and claim_token = $3` fencing 조건이다** -- Worker A가 claim한
--   --    뒤 lease가 만료돼 Worker B가 재획득하면 claim_token이 바뀌므로,
--   --    A가 뒤늦게(stale) 이 UPDATE를 실행해도 WHERE 조건에 걸려 0행이
--   --    반환된다 -- B의 claim이나 결과를 절대 덮어쓰지 않는다:
--   update notification_deliveries
--   set status = 'delivered', delivery_ref = $4, claim_token = null,
--       locked_at = null, lock_expires_at = null, updated_at = now()
--   where user_id = $1
--     and idempotency_key = $2
--     and status = 'sending'
--     and claim_token = $3
--   returning *;
--   -- 실패 시 (같은 fencing 조건):
--   update notification_deliveries
--   set status = 'failed', last_error = $4, next_attempt_at = now(), claim_token = null,
--       locked_at = null, lock_expires_at = null, updated_at = now()
--   where user_id = $1
--     and idempotency_key = $2
--     and status = 'sending'
--     and claim_token = $3
--   returning *;
--   -- 두 UPDATE 모두 0행이 반환되면(stale completion) 애플리케이션은 이
--   -- 결과를 무시하고, 대신 현재 저장된 행을 다시 SELECT해 돌려줘야 한다
--   -- (lib/watch/store.ts의 completeNotificationClaim이 반환하는
--   -- { applied: false, reason: "stale_claim", entry }가 바로 이 경우다).
--
-- `last_error`에는 절대 실제 알림 목적지 원문이나 비밀값을 넣지 않는다 --
-- 구조화된 오류 메시지만 기록한다(lib/watch/notification/dispatch.ts 참고).
--
-- **전달 보장 수준에 대한 솔직한 고지**: 위 claim/fencing은 "이 저장소를
-- 함께 보는 두 Worker가 동시에 같은 알림을 발송하는" 경쟁을 없애고, 저장소
-- 상태 자체는 항상 일관되게 유지한다. 하지만 Worker가 어댑터 호출을 실제로
-- 완료한 뒤 그 결과를 4)의 UPDATE로 기록하기 *전에* 죽으면(프로세스가
-- 강제 종료되는 등), 그 알림은 이미 외부로 나갔지만 저장소는 여전히
-- "sending"으로 남고, lease가 만료되면 다른 Worker가 재시도해 똑같은
-- 알림을 다시 외부로 보낼 수 있다. 즉 **이 설계가 보장하는 것은 저장소
-- 자체의 일관성(같은 idempotency_key에 서로 다른 두 최종 상태가 동시에
-- 남는 일이 없음)과 최소 한 번(at-least-once) 전달이지, "정확히 한
-- 번(exactly-once)" 외부 전달이 아니다.** 외부 Provider(FCM/이메일 발송
-- 서비스 등)가 자체 멱등키를 지원한다면, 이 idempotency_key를 그대로
-- Provider 호출에 실어 Provider 쪽에서도 재시도 중복을 걸러내게 하는 것을
-- 권장한다 -- 이번 PR은 실제 Provider 연동이 없어 아직 적용하지 않았다.
--
-- device_id + watch_cycle은 자체 컬럼으로도 저장한다(idempotency_key 문자열
-- 파싱 없이 "이 기기가 이번 세대에 이미 알림을 받았는지" 조회/감사할 수
-- 있도록) -- §6 검토사항: 이전에는 idempotency_key가 jobId:candidateId:
-- eventType뿐이라 여러 채널/기기가 하나의 키를 공유해, 첫 성공 알림이
-- 나머지를 모두 억제해버렸다. 이제 idempotency_key 자체도
-- channel+device_id+watch_cycle을 포함하도록 애플리케이션
-- (lib/watch/worker.ts)이 구성한다.
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
  status text not null check (status in ('pending', 'sending', 'delivered', 'failed', 'skipped_unverified')),
  delivery_ref text,
  attempt_count integer not null default 0,
  last_error text,
  next_attempt_at timestamptz,
  -- 현재 claim 보유자만 아는 무작위 토큰 -- status='sending'일 때만 의미가
  -- 있고, 그 외에는 null이다. 재획득할 때마다(lease 만료, 실패 후 재시도)
  -- 새 값으로 교체한다. 완료 UPDATE(위 4번)는 이 값이 자신이 claim 시 받은
  -- 값과 일치할 때만 적용되는 CAS(compare-and-swap) 조건으로 쓰인다 --
  -- 뒤늦게 도착한(stale) 완료가 더 최신 claim을 덮어쓰는 것을 막는 핵심
  -- 방어선이다.
  claim_token uuid,
  locked_at timestamptz,
  lock_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 이전 설계는 status='delivered' 행만 대상으로 하는 partial unique
  -- index였다 -- 이 테이블이 append-only 로그였을 때는 그것으로 충분했지만,
  -- 이제는 한 idempotency_key당 정확히 한 행만 존재해야 하므로(Outbox 모델)
  -- 상태와 무관한 전체 unique 제약이어야 한다. 이 제약 자체가 위 claim
  -- 패턴의 `on conflict (user_id, idempotency_key)` 대상이다.
  unique (user_id, idempotency_key)
);
create index notification_deliveries_user_id_idx on notification_deliveries (user_id, watch_job_id);
-- 방치된(lease 만료) claim이나 재시도 대기 중인 실패 건을 스캔하는 백그라운드
-- 잡(cron 등)이 있다면 이 인덱스로 효율적으로 찾을 수 있다.
create index notification_deliveries_reclaimable_idx
  on notification_deliveries (status, lock_expires_at, next_attempt_at)
  where status in ('sending', 'failed');

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
-- AuditEvent (lib/audit/types.ts -- 재검토, §3: lib/watch/types.ts에 있던
-- 것을 lib/auth와 lib/watch가 공유하는 독립 모듈로 옮겼다. 애플리케이션
-- 코드가 옮겨졌을 뿐 이 테이블 자체는 처음부터 두 주체가 함께 써 왔으므로
-- 스키마 변경은 없다). Deliberately NOT a foreign key into users: this
-- table is meant to survive account deletion for security/audit integrity
-- (see docs/adr/0002). `metadata` must never contain secrets, tokens, or
-- raw notification destinations (enforced by convention at the call sites
-- in lib/audit/memory-store.ts, not by the database).
--
-- §8 검토사항: 계정 삭제 시 `user_id`를 원래 계정과 무관한 새 무작위 UUID로
-- 되돌릴 수 없이 교체한다(pseudonymization -- lib/audit/memory-store.ts의
-- pseudonymizeForUser 참고). "userId만 남아서 개인정보가 아니다"라고
-- 가정하지 않기 위함이며, 대안(일정 보존기간 후 삭제)은 채택하지 않았다.
-- (재검토, §3) 계정 삭제 순서는 반드시 다음과 같아야 한다: (1) user_deleted
-- 이벤트를 기록 -> (2) 이 사용자의 모든 이벤트를(방금 기록한 것 포함) 하나의
-- 공통 가명으로 치환 -> (3) watch_jobs/devices/notification_deliveries/
-- consent_history 삭제 -> (4) users 행 삭제. user_deleted 자체가 다른
-- 이전 이벤트와 별개의 가명을 받으면 안 되므로, 반드시 (2)보다 먼저
-- 기록해야 한다 -- 아래 계정 삭제 트랜잭션 예시 참고.
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

-- === 계정 삭제 트랜잭션 예시 (실제 DDL 아님, Postgres Adapter 구현 참고용) ============
--
-- DELETE /api/auth/account가 재인증에 성공하면 이 모양의 트랜잭션 하나로
-- 처리한다. 핵심은: 가명 UUID를 애플리케이션(또는 아래처럼 트랜잭션 맨 앞의
-- 별도 `select`)에서 "정확히 한 번" 생성해 파라미터로 바인딩하고, 그 값을
-- audit_events UPDATE 한 번에 그대로 재사용하는 것이다.
--
-- 절대 하면 안 되는 것: `update audit_events set user_id = gen_random_uuid()
-- where user_id = $1` 처럼 UPDATE 문 안에서 직접 gen_random_uuid()를 호출하는
-- 것 -- 이 경우 Postgres가 매 행(row)마다 새 값을 평가하므로, 같은 사용자의
-- 이벤트가 여러 개면 서로 다른 가명 UUID를 갖게 되어 "같은 사용자는 같은
-- 가명을 공유해야 한다"는 요구사항이 깨진다.
--
-- begin;
--   -- 1) "삭제됨" 감사 이벤트를 먼저 기록한다 -- 이 이벤트도 아래 2)에서
--   --    같은 가명으로 치환되어야 하므로, 반드시 가명처리보다 먼저 쓴다.
--   insert into audit_events (user_id, action, target_id, metadata)
--   values ($1, 'user_deleted', null, null);
--
--   -- 2) 이 삭제 한 번을 위한 가명 UUID를 정확히 한 번만 생성한다.
--   --    (애플리케이션에서 crypto.randomUUID()로 생성해 바인딩해도 되고,
--   --    아래처럼 SQL에서 만들어 클라이언트로 돌려받은 뒤 같은 트랜잭션
--   --    안에서 파라미터로 재사용해도 된다.)
--   select gen_random_uuid() as pseudonym; -- 애플리케이션이 이 값을 $2로 캡처
--
--   -- 3) 이 사용자의 모든 AuditEvent(방금 1)에서 넣은 user_deleted 포함)를
--   --    "동일한" 가명으로 한 번에 치환한다. 원래 user_id($1)와 새 가명($2)
--   --    사이의 매핑은 이 트랜잭션 밖 어디에도 저장하지 않는다 -- 저장하면
--   --    역추적이 다시 가능해진다.
--   update audit_events set user_id = $2 where user_id = $1;
--
--   -- 4) 이 사용자가 소유한 나머지 데이터는 실제로 삭제한다(가명처리가 아님).
--   delete from watch_job_history where watch_job_id in (select id from watch_jobs where user_id = $1);
--   delete from notification_deliveries where user_id = $1;
--   delete from watch_job_candidates where watch_job_id in (select id from watch_jobs where user_id = $1);
--   delete from watch_jobs where user_id = $1;
--   delete from devices where user_id = $1;
--   delete from consent_history where user_id = $1;
--   delete from sessions where user_id = $1;
--   delete from users where id = $1;
-- commit;
--
-- 위 순서(자식 테이블 먼저)는 `on delete cascade` FK가 이미 대부분 처리해
-- 주지만, 트랜잭션 안에서 명시적으로 지워도 안전하고 의도가 더 분명하다.
