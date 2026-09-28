import "server-only";

import { CLAIMABLE_STATUSES } from "@/lib/autobook/state-machine";
import { getPostgresPool, toStoreError, type PgQueryable, type SqlValue } from "@/lib/autobook/postgres/client";
import type { AutobookAuditEntry, AutobookStore } from "@/lib/autobook/store";
import {
  AutobookError,
  type AutobookJob,
  type AutobookNotification,
} from "@/lib/autobook/types";

// v0.10 PostgreSQL 저장소.
//
// lib/autobook/memory-store.ts 와 **같은 계약**을 구현한다. 둘의 동작이
// 갈라지면 "개발에서는 되는데 운영에서 중복 예약이 생긴다"가 된다. 그래서
// tests/autobook/store-conformance.mjs 가 두 구현에 같은 시나리오를 돌린다.
//
// 동시성 장치는 메모리 구현과 같은 두 가지다.
//
//  1. claimNext 의 원자성 -> SELECT ... FOR UPDATE SKIP LOCKED.
//     두 Worker 가 같은 순간에 불러도 서로 다른 행을 잡거나 한 쪽이 빈손으로
//     돌아간다. 행 잠금과 UPDATE 가 한 문장 안에 있으므로 그 사이에 끼어들
//     틈이 없다.
//  2. 쓰기의 fencing -> WHERE claim_worker_id = $n AND claim_fencing_token = $m.
//     토큰이 뒤처진 Worker 의 UPDATE 는 0행을 고치고, 그것을 STALE_CLAIM 으로
//     돌려준다. 잠깐 멈췄다 깨어난 Worker 가 남의 작업을 덮어쓰지 못한다.
//
// SQL 값은 **전부 파라미터 바인딩**이다. 문자열 연결로 값을 넣는 곳이 없다
// (scripts/verify-autobook.cjs 가 이것을 검사한다).

const JOB_COLUMNS = `
  id, user_id, status, condition, candidates, provider_name, simulation,
  dedupe_key, reservation_idempotency_key, hold, status_detail, attempts,
  next_check_at, expires_at, created_at, updated_at,
  claim_worker_id, claim_fencing_token, claim_claimed_at, claim_expires_at
`;

type JobRow = {
  id: string;
  user_id: string;
  status: AutobookJob["status"];
  condition: AutobookJob["condition"];
  candidates: AutobookJob["candidates"];
  provider_name: string;
  simulation: boolean;
  dedupe_key: string;
  reservation_idempotency_key: string;
  hold: AutobookJob["hold"];
  status_detail: string | null;
  attempts: number;
  next_check_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  claim_worker_id: string | null;
  claim_fencing_token: string | number | null;
  claim_claimed_at: Date | null;
  claim_expires_at: Date | null;
};

type NotificationRow = {
  id: string;
  job_id: string;
  user_id: string;
  kind: AutobookNotification["kind"];
  idempotency_key: string;
  payload: AutobookNotification["payload"];
  created_at: Date;
  claimed_by: string | null;
  claimed_fencing_token: string | number | null;
  sent_at: Date | null;
  failed_attempts: number;
};

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);
/** BIGINT 는 드라이버가 문자열로 준다. 토큰 비교 전에 숫자로 되돌린다. */
const num = (value: string | number | null): number | null =>
  value === null ? null : typeof value === "number" ? value : Number(value);

function toJob(row: JobRow): AutobookJob {
  const token = num(row.claim_fencing_token);
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    condition: row.condition,
    candidates: row.candidates,
    providerName: row.provider_name,
    simulation: row.simulation,
    dedupeKey: row.dedupe_key,
    reservationIdempotencyKey: row.reservation_idempotency_key,
    hold: row.hold,
    statusDetail: row.status_detail,
    attempts: row.attempts,
    nextCheckAt: iso(row.next_check_at),
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    claim:
      row.claim_worker_id && token !== null && row.claim_expires_at
        ? {
            workerId: row.claim_worker_id,
            fencingToken: token,
            claimedAt: iso(row.claim_claimed_at) ?? row.updated_at.toISOString(),
            leaseExpiresAt: row.claim_expires_at.toISOString(),
          }
        : null,
  };
}

function toNotification(row: NotificationRow): AutobookNotification {
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
    claimedBy: row.claimed_by,
    claimedFencingToken: num(row.claimed_fencing_token),
    sentAt: iso(row.sent_at),
    failedAttempts: row.failed_attempts,
  };
}

/** 모든 쿼리를 이 함수로 감싼다. 드라이버 오류 원문이 밖으로 나가지 않는다. */
async function run<Row>(
  db: PgQueryable,
  text: string,
  values: readonly SqlValue[] = [],
): Promise<{ rows: Row[]; rowCount: number | null }> {
  try {
    return await db.query<Row>(text, values);
  } catch (error) {
    throw toStoreError(error);
  }
}

/**
 * 부분 수정을 컬럼 목록으로 바꾼다.
 *
 * 컬럼 이름은 **이 표에 있는 것만** 쓴다. 호출자가 준 키를 SQL 에 그대로
 * 넣지 않는다는 뜻이다. 값은 전부 $n 바인딩으로 나간다.
 */
const PATCHABLE: Readonly<Record<string, string>> = Object.freeze({
  status: "status",
  condition: "condition",
  candidates: "candidates",
  providerName: "provider_name",
  simulation: "simulation",
  dedupeKey: "dedupe_key",
  reservationIdempotencyKey: "reservation_idempotency_key",
  hold: "hold",
  statusDetail: "status_detail",
  attempts: "attempts",
  nextCheckAt: "next_check_at",
  expiresAt: "expires_at",
});

const JSON_COLUMNS = new Set(["condition", "candidates", "hold"]);
const TIMESTAMP_COLUMNS = new Set(["next_check_at", "expires_at"]);

function buildPatch(patch: Record<string, unknown>, startIndex: number): { sets: string[]; values: SqlValue[] } {
  const sets: string[] = [];
  const values: SqlValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = PATCHABLE[key];
    if (!column) continue; // id·userId·createdAt·claim 은 패치로 바꾸지 않는다.
    const index = startIndex + values.length;
    if (JSON_COLUMNS.has(column)) {
      sets.push(`${column} = $${index}::jsonb`);
      values.push(JSON.stringify(value ?? null));
    } else if (TIMESTAMP_COLUMNS.has(column)) {
      sets.push(`${column} = $${index}::timestamptz`);
      values.push((value as string | null) ?? null);
    } else {
      sets.push(`${column} = $${index}`);
      values.push(value as SqlValue);
    }
  }
  return { sets, values };
}

export function createPostgresAutobookStore(): AutobookStore {
  const db = async (): Promise<PgQueryable> => getPostgresPool();

  const store: AutobookStore = {
    async createJob(job) {
      const pool = await db();
      const { rows } = await run<JobRow>(
        pool,
        `INSERT INTO autobook_jobs (
           id, user_id, status, condition, candidates, provider_name, simulation,
           dedupe_key, reservation_idempotency_key, hold, status_detail, attempts,
           next_check_at, expires_at, created_at, updated_at, last_fencing_token
         ) VALUES (
           $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7,
           $8, $9, $10::jsonb, $11, $12,
           $13::timestamptz, $14::timestamptz, $15::timestamptz, $16::timestamptz, 0
         )
         ON CONFLICT (id) DO NOTHING
         RETURNING ${JOB_COLUMNS}`,
        [
          job.id,
          job.userId,
          job.status,
          JSON.stringify(job.condition),
          JSON.stringify(job.candidates),
          job.providerName,
          job.simulation,
          job.dedupeKey,
          job.reservationIdempotencyKey,
          JSON.stringify(job.hold ?? null),
          job.statusDetail,
          job.attempts,
          job.nextCheckAt,
          job.expiresAt,
          job.createdAt,
          job.updatedAt,
        ],
      );
      if (rows.length === 0) {
        throw new AutobookError("DUPLICATE_JOB", "같은 id 의 작업이 이미 있습니다.");
      }
      return toJob(rows[0]);
    },

    async getJob(id) {
      const pool = await db();
      const { rows } = await run<JobRow>(pool, `SELECT ${JOB_COLUMNS} FROM autobook_jobs WHERE id = $1`, [id]);
      return rows.length ? toJob(rows[0]) : null;
    },

    async listJobsByUser(userId) {
      const pool = await db();
      const { rows } = await run<JobRow>(
        pool,
        `SELECT ${JOB_COLUMNS} FROM autobook_jobs WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      );
      return rows.map(toJob);
    },

    async findActiveByDedupeKey(userId, dedupeKey) {
      const pool = await db();
      const { rows } = await run<JobRow>(
        pool,
        `SELECT ${JOB_COLUMNS} FROM autobook_jobs
          WHERE user_id = $1 AND dedupe_key = $2 AND status <> ALL($3::text[])
          ORDER BY created_at ASC LIMIT 1`,
        [userId, dedupeKey, TERMINAL_LIST],
      );
      return rows.length ? toJob(rows[0]) : null;
    },

    async claimNext({ workerId, now, leaseMs }) {
      const pool = await db();
      // 한 문장 안에서 고르고·잠그고·표시한다. 두 Worker 가 같은 행을
      // 가져갈 틈이 없다. SKIP LOCKED 덕분에 서로 기다리지도 않는다.
      const { rows } = await run<JobRow>(
        pool,
        `WITH picked AS (
           SELECT id FROM autobook_jobs
            WHERE status = ANY($2::text[])
              AND (next_check_at IS NULL OR next_check_at <= $3::timestamptz)
              AND (claim_expires_at IS NULL OR claim_expires_at <= $3::timestamptz)
            ORDER BY next_check_at NULLS FIRST, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE autobook_jobs j
            SET claim_worker_id     = $1,
                last_fencing_token  = j.last_fencing_token + 1,
                claim_fencing_token = j.last_fencing_token + 1,
                claim_claimed_at    = $3::timestamptz,
                claim_expires_at    = $3::timestamptz + ($4 || ' milliseconds')::interval,
                updated_at          = $3::timestamptz
           FROM picked
          WHERE j.id = picked.id
        RETURNING ${JOB_COLUMNS.split(",").map((c) => `j.${c.trim()}`).join(", ")}`,
        [workerId, CLAIMABLE_LIST, now, String(Math.max(0, Math.floor(leaseMs)))],
      );
      return rows.length ? toJob(rows[0]) : null;
    },

    async renewClaim({ jobId, workerId, fencingToken, leaseMs }) {
      const pool = await db();
      const { rowCount } = await run(
        pool,
        `UPDATE autobook_jobs
            SET claim_expires_at = NOW() + ($4 || ' milliseconds')::interval
          WHERE id = $1 AND claim_worker_id = $2 AND claim_fencing_token = $3`,
        [jobId, workerId, fencingToken, String(Math.max(0, Math.floor(leaseMs)))],
      );
      if (!rowCount) await assertExists(pool, jobId, "이 작업에 대한 claim 이 없습니다.");
    },

    async updateJob({ jobId, workerId, fencingToken, patch }) {
      const pool = await db();
      const { sets, values } = buildPatch(patch as Record<string, unknown>, 4);
      const { rows } = await run<JobRow>(
        pool,
        `UPDATE autobook_jobs
            SET ${[...sets, "updated_at = NOW()"].join(", ")}
          WHERE id = $1 AND claim_worker_id = $2 AND claim_fencing_token = $3
        RETURNING ${JOB_COLUMNS}`,
        [jobId, workerId, fencingToken, ...values],
      );
      if (rows.length === 0) {
        // 토큰이 뒤처졌거나 claim 이 이미 넘어갔다. 어느 쪽이든 쓰면 안 된다.
        await assertExists(pool, jobId, "더 최신 Worker가 이 작업을 맡고 있습니다.");
      }
      return toJob(rows[0]);
    },

    async releaseClaim({ jobId, workerId, fencingToken }) {
      const pool = await db();
      // 남의 claim 은 지우지 않는다. 토큰(last_fencing_token)은 남긴다 --
      // 다음 claim 이 더 큰 토큰을 받아야 하기 때문이다.
      await run(
        pool,
        `UPDATE autobook_jobs
            SET claim_worker_id = NULL, claim_fencing_token = NULL,
                claim_claimed_at = NULL, claim_expires_at = NULL
          WHERE id = $1 AND claim_worker_id = $2 AND claim_fencing_token = $3`,
        [jobId, workerId, fencingToken],
      );
    },

    async updateByUser({ jobId, userId, status, statusDetail = null }) {
      const pool = await db();
      const { rows } = await run<JobRow>(
        pool,
        `UPDATE autobook_jobs
            SET status = $3, status_detail = $4, updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        RETURNING ${JOB_COLUMNS}`,
        [jobId, userId, status, statusDetail],
      );
      if (rows.length === 0) throw new AutobookError("NOT_FOUND", "작업을 찾을 수 없습니다.");
      return toJob(rows[0]);
    },

    async enqueueNotification(notification) {
      const pool = await db();
      // 같은 사건이면 같은 멱등키다. UNIQUE 제약이 두 번째를 흡수한다.
      const { rows } = await run<NotificationRow>(
        pool,
        `INSERT INTO autobook_notifications (
           id, job_id, user_id, kind, idempotency_key, payload, created_at,
           claimed_by, claimed_fencing_token, sent_at, failed_attempts
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, NULL, NULL, NULL, 0)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          notification.id,
          notification.jobId,
          notification.userId,
          notification.kind,
          notification.idempotencyKey,
          JSON.stringify(notification.payload),
          notification.createdAt,
        ],
      );
      return rows.length ? toNotification(rows[0]) : null;
    },

    async claimNotification({ workerId, fencingToken }) {
      const pool = await db();
      const { rows } = await run<NotificationRow>(
        pool,
        `WITH picked AS (
           SELECT id FROM autobook_notifications
            WHERE sent_at IS NULL AND claimed_by IS NULL
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE autobook_notifications n
            SET claimed_by = $1, claimed_fencing_token = $2
           FROM picked WHERE n.id = picked.id
        RETURNING n.*`,
        [workerId, fencingToken],
      );
      return rows.length ? toNotification(rows[0]) : null;
    },

    async markNotificationSent({ id, workerId, fencingToken }) {
      const pool = await db();
      const { rowCount } = await run(
        pool,
        `UPDATE autobook_notifications SET sent_at = NOW()
          WHERE id = $1 AND claimed_by = $2 AND claimed_fencing_token = $3`,
        [id, workerId, fencingToken],
      );
      if (!rowCount) await assertNotificationExists(pool, id);
    },

    async markNotificationFailed({ id, workerId, fencingToken }) {
      const pool = await db();
      const { rowCount } = await run(
        pool,
        `UPDATE autobook_notifications
            SET failed_attempts = failed_attempts + 1,
                claimed_by = NULL, claimed_fencing_token = NULL
          WHERE id = $1 AND claimed_by = $2 AND claimed_fencing_token = $3`,
        [id, workerId, fencingToken],
      );
      if (!rowCount) await assertNotificationExists(pool, id);
    },

    async listNotifications(jobId) {
      const pool = await db();
      const { rows } = await run<NotificationRow>(
        pool,
        `SELECT * FROM autobook_notifications WHERE job_id = $1 ORDER BY created_at ASC`,
        [jobId],
      );
      return rows.map(toNotification);
    },

    async recordAudit(entry) {
      const pool = await db();
      await run(
        pool,
        `INSERT INTO autobook_audit (job_id, user_pseudonym, event, from_status, to_status, worker_id, fencing_token, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.jobId,
          entry.userPseudonym,
          entry.event,
          entry.fromStatus,
          entry.toStatus,
          entry.workerId,
          entry.fencingToken,
          entry.detail,
        ],
      );
    },

    async listAudit(jobId) {
      const pool = await db();
      const { rows } = await run<{
        job_id: string;
        user_pseudonym: string;
        event: string;
        from_status: string | null;
        to_status: string | null;
        worker_id: string | null;
        fencing_token: string | number | null;
        detail: string | null;
        created_at: Date;
      }>(
        pool,
        `SELECT job_id, user_pseudonym, event, from_status, to_status, worker_id, fencing_token, detail, created_at
           FROM autobook_audit WHERE job_id = $1 ORDER BY created_at ASC, id ASC`,
        [jobId],
      );
      return rows.map((row) => ({
        jobId: row.job_id,
        userPseudonym: row.user_pseudonym,
        event: row.event,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        workerId: row.worker_id,
        fencingToken: num(row.fencing_token),
        detail: row.detail,
        createdAt: row.created_at.toISOString(),
      })) satisfies AutobookAuditEntry[];
    },
  };

  return store;
}

/** 행이 아예 없으면 NOT_FOUND, 있으면 STALE_CLAIM. 둘을 섞지 않는다. */
async function assertExists(db: PgQueryable, jobId: string, staleMessage: string): Promise<never> {
  const { rows } = await run<{ id: string }>(db, `SELECT id FROM autobook_jobs WHERE id = $1`, [jobId]);
  if (rows.length === 0) throw new AutobookError("NOT_FOUND", "작업을 찾을 수 없습니다.");
  throw new AutobookError("STALE_CLAIM", staleMessage);
}

async function assertNotificationExists(db: PgQueryable, id: string): Promise<never> {
  const { rows } = await run<{ id: string }>(db, `SELECT id FROM autobook_notifications WHERE id = $1`, [id]);
  if (rows.length === 0) throw new AutobookError("NOT_FOUND", "알림을 찾을 수 없습니다.");
  throw new AutobookError("STALE_CLAIM", "이 알림은 다른 Worker가 맡고 있습니다.");
}

// 상태 목록은 상태 기계에서 온다. SQL 쪽에 문자열을 따로 적어 두면 두 곳이
// 갈라진다.
const CLAIMABLE_LIST: string[] = [...CLAIMABLE_STATUSES];
const TERMINAL_LIST: string[] = ["COMPLETED", "EXPIRED", "CANCELLED", "AMBIGUOUS_RESULT", "BLOCKED_BY_OPERATOR"];
