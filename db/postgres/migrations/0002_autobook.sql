-- v0.9 서버형 자동예약 스키마 (설계 전용 -- 이 PR에는 이 SQL을 실행하는
-- 코드가 없다. lib/autobook/memory-store.ts 가 같은 계약을 메모리로 구현하며,
-- Postgres 어댑터는 승인된 Provider 가 확보된 뒤에 추가한다.)
--
-- 이 스키마가 지켜야 하는 것은 lib/autobook/store.ts 의 계약이다:
--  * claimNext 는 원자적이어야 한다  -> SELECT ... FOR UPDATE SKIP LOCKED
--  * 쓰기는 fencing token 을 거쳐야 한다 -> WHERE fencing_token = $n
--  * 같은 사용자·날짜·구간·인원에 활성 작업 하나 -> 부분 유니크 인덱스
--  * 같은 사건의 알림은 한 번 -> idempotency_key 유니크

CREATE TABLE IF NOT EXISTS autobook_jobs (
  id                          TEXT PRIMARY KEY,
  user_id                     TEXT NOT NULL,
  status                      TEXT NOT NULL,
  condition                   JSONB NOT NULL,
  candidates                  JSONB NOT NULL,
  provider_name               TEXT NOT NULL,
  -- Mock Provider 로 만든 작업인지. 화면이 실제처럼 보여주면 안 된다.
  simulation                  BOOLEAN NOT NULL DEFAULT FALSE,
  dedupe_key                  TEXT NOT NULL,
  -- 예약 요청의 멱등키. 재시도해도 예약이 두 번 생기지 않게 한다.
  reservation_idempotency_key TEXT NOT NULL,
  hold                        JSONB,
  status_detail               TEXT,
  attempts                    INTEGER NOT NULL DEFAULT 0,
  next_check_at               TIMESTAMPTZ,
  expires_at                  TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- claim: 지금 이 작업을 잡고 있는 Worker
  claim_worker_id             TEXT,
  claim_fencing_token         BIGINT,
  claim_expires_at            TIMESTAMPTZ,
  -- 이 작업에 지금까지 발급된 최대 토큰. 단조 증가를 보장한다.
  last_fencing_token          BIGINT NOT NULL DEFAULT 0
);

-- 같은 사용자·날짜·구간·인원에 활성 작업은 하나만. 후보 열차는 키에 넣지
-- 않는다 -- 같은 구간을 여러 열차로 동시에 노리는 것이 곧 중복 위험이므로.
CREATE UNIQUE INDEX IF NOT EXISTS autobook_jobs_active_dedupe
  ON autobook_jobs (user_id, dedupe_key)
  WHERE status NOT IN ('COMPLETED', 'EXPIRED', 'CANCELLED', 'AMBIGUOUS_RESULT', 'BLOCKED_BY_OPERATOR');

-- claimNext 가 스캔하는 순서.
CREATE INDEX IF NOT EXISTS autobook_jobs_claimable
  ON autobook_jobs (next_check_at NULLS FIRST)
  WHERE status IN ('SCHEDULED', 'WATCHING', 'SEAT_FOUND', 'AUTH_REQUIRED', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE');

-- 참고 구현:
--
--   -- claimNext: 두 Worker 가 동시에 불러도 한 쪽만 가져간다.
--   WITH picked AS (
--     SELECT id FROM autobook_jobs
--      WHERE status IN ('SCHEDULED','WATCHING','SEAT_FOUND','AUTH_REQUIRED','RATE_LIMITED','PROVIDER_UNAVAILABLE')
--        AND (next_check_at IS NULL OR next_check_at <= NOW())
--        AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
--      ORDER BY next_check_at NULLS FIRST
--      FOR UPDATE SKIP LOCKED
--      LIMIT 1
--   )
--   UPDATE autobook_jobs j
--      SET claim_worker_id = $1,
--          last_fencing_token = j.last_fencing_token + 1,
--          claim_fencing_token = j.last_fencing_token + 1,
--          claim_expires_at = NOW() + ($2 || ' milliseconds')::INTERVAL
--     FROM picked WHERE j.id = picked.id
--   RETURNING j.*;
--
--   -- updateJob: 오래된 Worker 의 쓰기를 여기서 막는다.
--   UPDATE autobook_jobs
--      SET status = $3, updated_at = NOW()
--    WHERE id = $1 AND claim_worker_id = $2 AND claim_fencing_token = $4;
--   -- 0 rows 이면 STALE_CLAIM.

CREATE TABLE IF NOT EXISTS autobook_notifications (
  id                    TEXT PRIMARY KEY,
  job_id                TEXT NOT NULL REFERENCES autobook_jobs(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  -- 같은 사건에 알림이 두 번 가지 않게 한다.
  idempotency_key       TEXT NOT NULL UNIQUE,
  -- 자격증명·세션·예약번호 원문을 넣지 않는다(lib/autobook/outbox.ts).
  payload               JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by            TEXT,
  claimed_fencing_token BIGINT,
  sent_at               TIMESTAMPTZ,
  failed_attempts       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS autobook_notifications_pending
  ON autobook_notifications (created_at)
  WHERE sent_at IS NULL;

-- 감사로그. 개인정보와 자격증명은 넣지 않는다 -- 무엇이 언제 일어났는지만.
CREATE TABLE IF NOT EXISTS autobook_audit (
  id          BIGSERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL,
  -- 사용자 식별자는 가명으로만 남긴다(lib/audit/** 과 같은 규칙).
  user_pseudonym TEXT NOT NULL,
  event       TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  worker_id   TEXT,
  fencing_token BIGINT,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS autobook_audit_job ON autobook_audit (job_id, created_at);

-- 계정 연결. 이번 단계에서는 어떤 행도 만들어지지 않는다 --
-- 공식 연결 방식이 확인되지 않아 연결 자체가 비활성이기 때문이다.
-- 비밀번호 컬럼이 없는 것은 의도적이다(lib/autobook/account-link.ts).
CREATE TABLE IF NOT EXISTS autobook_account_links (
  user_id     TEXT PRIMARY KEY,
  method      TEXT NOT NULL CHECK (method IN ('official_oauth', 'official_api_credential', 'short_lived_session')),
  -- 토큰 자체가 아니라 외부 보관소의 참조만 둔다.
  secret_ref  TEXT NOT NULL,
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ
);
