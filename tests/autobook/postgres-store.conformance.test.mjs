// PostgreSQL 저장소가 **실제 DB 에서** 공통 계약을 만족하는지.
//
// AUTOBOOK_TEST_DATABASE_URL 이 없으면 한 건도 실행하지 않고 NOT RUN 으로
// 남긴다. Memory 저장소 테스트 통과를 이 검증으로 대신하지 않는다.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";
import { makeJob, makeNotification, runStoreConformance } from "./store-conformance.mjs";
import { applyMigrations, skipReason, testDatabaseUrl, truncateAutobookTables } from "./pg-harness.mjs";

const url = testDatabaseUrl();

if (!url) {
  test("[postgres] 통합 테스트 NOT RUN", { skip: skipReason() }, () => {});
} else {
  // 저장소 코드는 AUTOBOOK_DATABASE_URL / DATABASE_URL 을 본다. 테스트는
  // 전용 변수로만 받고, 여기서 프로세스 안의 값으로 옮긴다.
  process.env.AUTOBOOK_DATABASE_URL = url;

  const { loadTs } = loader;
  const { createPostgresAutobookStore } = loadTs("lib/autobook/postgres-store.ts");
  const { getPostgresPool, closePostgresPool, redactDbError } = loadTs("lib/autobook/postgres/client.ts");

  // Pool 핸들을 붙잡아 두지 않는다. 아래 "재시작 상당" 테스트가 Pool 을
  // 실제로 닫으므로, 매번 현재 Pool 을 다시 얻어야 한다.
  const db = () => getPostgresPool();
  await applyMigrations(await db());

  runStoreConformance({
    label: "postgres",
    async setup() {
      await truncateAutobookTables(await db());
      return createPostgresAutobookStore();
    },
    helpers: {
      // 새 저장소 인스턴스. 같은 DB 를 본다.
      async newInstance() {
        return createPostgresAutobookStore();
      },
    },
  });

  // --- PostgreSQL 에서만 확인할 수 있는 것 ---------------------------------

  test("[postgres] 연결을 끊고 다시 붙어도 작업이 남아 있다(서버 재시작 상당)", async () => {
    await truncateAutobookTables(await db());
    const store = createPostgresAutobookStore();
    await store.createJob(makeJob({ id: "restart-1", dedupeKey: "d-r", reservationIdempotencyKey: "i-r" }));
    const claimed = await store.claimNext({ workerId: "w-1", now: new Date().toISOString(), leaseMs: 30_000 });
    await store.updateJob({
      jobId: "restart-1",
      workerId: "w-1",
      fencingToken: claimed.claim.fencingToken,
      patch: { status: "WATCHING", attempts: 3, statusDetail: "감시 중" },
    });

    // 프로세스가 죽었다 살아난 것과 같은 상태: Pool 을 완전히 닫고 새로 연다.
    await closePostgresPool();

    const revived = createPostgresAutobookStore();
    const job = await revived.getJob("restart-1");
    assert.ok(job, "재연결 후 작업을 찾지 못했다");
    assert.equal(job.status, "WATCHING");
    assert.equal(job.attempts, 3);
    assert.equal(job.claim.workerId, "w-1", "claim 이 복원되지 않았다");
    assert.equal(job.claim.fencingToken, claimed.claim.fencingToken);
  });

  test("[postgres] 동시 Worker 20개가 붙어도 한 작업은 한 번만 집힌다", async () => {
    await truncateAutobookTables(await db());
    const store = createPostgresAutobookStore();
    await store.createJob(makeJob({ id: "race-1", dedupeKey: "d-race", reservationIdempotencyKey: "i-race" }));

    const now = new Date().toISOString();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.claimNext({ workerId: `w-${i}`, now, leaseMs: 60_000 })),
    );
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1, `${winners.length}개의 Worker 가 같은 작업을 잡았다`);
  });

  test("[postgres] 작업이 여러 개면 Worker 들이 서로 다른 작업을 나눠 집는다", async () => {
    await truncateAutobookTables(await db());
    const store = createPostgresAutobookStore();
    for (let i = 0; i < 5; i += 1) {
      await store.createJob(
        makeJob({ id: `job-${i}`, dedupeKey: `d-${i}`, reservationIdempotencyKey: `i-${i}` }),
      );
    }

    const now = new Date().toISOString();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.claimNext({ workerId: `w-${i}`, now, leaseMs: 60_000 })),
    );
    const ids = results.filter(Boolean).map((job) => job.id);
    assert.equal(new Set(ids).size, ids.length, `같은 작업을 두 Worker 가 집었다: ${ids.join(",")}`);
    assert.equal(ids.length, 5, "SKIP LOCKED 가 작업을 나눠 주지 못했다");
  });

  test("[postgres] DB 오류에 연결 문자열·자격증명이 들어가지 않는다", async () => {
    await truncateAutobookTables(await db());
    const store = createPostgresAutobookStore();
    await store.createJob(makeJob({ id: "dup", dedupeKey: "d-dup", reservationIdempotencyKey: "i-dup" }));

    let thrown = null;
    try {
      // 같은 예약 멱등키 -> UNIQUE 위반. 드라이버 원문에는 테이블·값이 담긴다.
      await store.createJob(
        makeJob({ id: "dup-2", userId: "u2", dedupeKey: "d-dup2", reservationIdempotencyKey: "i-dup" }),
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown, "중복 멱등키가 거부되지 않았다");
    const text = `${thrown.message} ${thrown.stack ?? ""}`;
    const parsed = new URL(url);
    for (const secret of [parsed.password, parsed.username, parsed.host, url].filter(Boolean)) {
      assert.ok(!text.includes(secret), `오류 메시지에 연결 정보가 들어 있다: ${secret.slice(0, 3)}…`);
    }
    assert.ok(!/postgres(ql)?:\/\//.test(text), "오류 메시지에 연결 문자열이 들어 있다");

    // 원문을 줄이는 함수 자체도 확인한다.
    const redacted = redactDbError({ code: "23505", constraint: "x", message: `secret ${url}` });
    assert.ok(!redacted.safeMessage.includes(url), "redactDbError 가 원문을 흘린다");
  });

  test("[postgres] 예약·알림 멱등키 유일성이 DB 제약으로 강제된다", async () => {
    await truncateAutobookTables(await db());
    const store = createPostgresAutobookStore();
    await store.createJob(makeJob({ id: "idem-1", dedupeKey: "d1", reservationIdempotencyKey: "same-key" }));

    // 저장소를 우회해 직접 INSERT 해도 제약이 막는다.
    await assert.rejects(
      async () =>
        (await db()).query(
          `INSERT INTO autobook_jobs (id, user_id, status, condition, candidates, provider_name, dedupe_key,
             reservation_idempotency_key, attempts, expires_at)
           VALUES ($1,$2,$3,'{}'::jsonb,'[]'::jsonb,$4,$5,$6,0, NOW())`,
          ["idem-2", "u2", "SCHEDULED", "mock-server", "d2", "same-key"],
        ),
      "예약 멱등키 UNIQUE 제약이 없다",
    );

    await store.enqueueNotification(makeNotification({ jobId: "idem-1", idempotencyKey: "k1" }));
    await assert.rejects(
      async () =>
        (await db()).query(
          `INSERT INTO autobook_notifications (id, job_id, user_id, kind, idempotency_key, payload)
           VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`,
          ["n2", "idem-1", "user-1", "SEAT_HELD", "k1"],
        ),
      "알림 멱등키 UNIQUE 제약이 없다",
    );
  });

  test("[postgres] migration 을 다시 실행해도 안전하다", async () => {
    // 배포가 두 번 돌아도 깨지지 않아야 한다.
    await applyMigrations(await db());
    await applyMigrations(await db());
    const { rows } = await (await db()).query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'autobook_jobs' AND column_name = 'claim_claimed_at'`,
    );
    assert.equal(rows[0].n, 1);
  });

  test.after(async () => {
    await closePostgresPool();
  });
}
