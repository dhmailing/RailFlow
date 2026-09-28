-- v0.10 후속 migration.
--
-- 0002_autobook.sql 은 v0.9 의 **설계 전용** 스키마였다. v0.10 에서
-- lib/autobook/postgres-store.ts 가 그 스키마를 실제로 쓰게 되면서 두 곳이
-- 어긋나는 지점이 드러났다. 0002 를 고쳐 쓰지 않고 여기에 덧붙인다 --
-- 이미 적용한 환경이 있을 수 있고, migration 을 되감는 것은 위험하다.
--
-- 이 파일은 **반복 실행해도 안전하다**(IF NOT EXISTS / IF EXISTS). 배포
-- 순서상 0002 뒤에 오기만 하면 되고, 기존 행을 지우거나 컬럼을 떨어뜨리지
-- 않는다.
--
-- 실제 운영 DB 에는 적용하지 않았다. 적용 방법과 필요한 환경변수는
-- docs/V0.10-POSTGRES-WORKER-READINESS.md 참조.

-- 1. claim 시작 시각.
--
-- store.ts 의 AutobookClaim 은 claimedAt 과 leaseExpiresAt 을 모두 갖는다.
-- 0002 에는 만료시각만 있어서, 저장소가 claimedAt 을 updated_at 으로 대신
-- 채워야 했다. "언제 집었는가"와 "언제 마지막으로 썼는가"는 다른 값이다.
ALTER TABLE autobook_jobs
  ADD COLUMN IF NOT EXISTS claim_claimed_at TIMESTAMPTZ;

-- 2. 예약 멱등키의 유일성.
--
-- 0002 에는 컬럼만 있고 제약이 없었다. 멱등키가 중복되면 "같은 키로 두 번
-- 요청해도 예약은 하나"라는 약속이 DB 수준에서 깨진다. 재시도로 같은 키가
-- 다시 들어오는 경로는 애플리케이션이 막지만, 마지막 방어선을 둔다.
CREATE UNIQUE INDEX IF NOT EXISTS autobook_jobs_reservation_idem
  ON autobook_jobs (reservation_idempotency_key);

-- 3. claimNext 가 실제로 쓰는 조건에 맞춘 인덱스.
--
-- 0002 의 부분 인덱스는 next_check_at 만 정렬했고 claim 만료를 보지 않았다.
-- 실제 쿼리는 (상태, next_check_at, claim_expires_at) 을 함께 본다.
-- 상태 목록은 lib/autobook/state-machine.ts 의 CLAIMABLE_STATUSES 와 같다 --
-- DRAFT 와 RESERVATION_CLAIMING 이 빠져 있는 것은 의도적이다(예약 요청이
-- 나간 작업을 다시 집으면 같은 좌석을 또 노리는 경로가 열린다).
DROP INDEX IF EXISTS autobook_jobs_claimable;
CREATE INDEX IF NOT EXISTS autobook_jobs_claimable
  ON autobook_jobs (next_check_at NULLS FIRST, created_at)
  WHERE status IN ('SCHEDULED', 'WATCHING', 'SEAT_FOUND', 'AUTH_REQUIRED', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE');

-- 4. 사용자별 목록 조회.
CREATE INDEX IF NOT EXISTS autobook_jobs_by_user
  ON autobook_jobs (user_id, created_at);

-- 5. 죽은 claim 회수.
--
-- lease 가 지났는데 claim 이 남아 있는 행을 찾는 진단 쿼리용이다.
CREATE INDEX IF NOT EXISTS autobook_jobs_stale_claims
  ON autobook_jobs (claim_expires_at)
  WHERE claim_worker_id IS NOT NULL;

-- 6. Outbox 집기.
--
-- 0002 의 부분 인덱스는 sent_at IS NULL 만 봤다. 실제 쿼리는 아직 아무도
-- 집지 않은 행(claimed_by IS NULL)을 먼저 찾는다.
CREATE INDEX IF NOT EXISTS autobook_notifications_unclaimed
  ON autobook_notifications (created_at)
  WHERE sent_at IS NULL AND claimed_by IS NULL;

-- 7. 감사 기록의 사용자별 조회.
--
-- user_pseudonym 은 단방향 해시다(lib/autobook/audit.ts). 원본 식별자를
-- 이 테이블에서 되돌릴 수 없다.
CREATE INDEX IF NOT EXISTS autobook_audit_pseudonym
  ON autobook_audit (user_pseudonym, created_at);
