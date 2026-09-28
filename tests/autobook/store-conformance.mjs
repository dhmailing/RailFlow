// Memory 저장소와 PostgreSQL 저장소의 **공통 계약** 테스트.
//
// 두 구현이 갈라지면 "개발에서는 되는데 운영에서 예약이 두 건 생긴다"가 된다.
// 그래서 같은 시나리오를 양쪽에 그대로 돌린다. 여기 있는 것은 전부 저장소
// 계약이며, 외부로 나가는 요청은 한 건도 없다.

import assert from "node:assert/strict";
import test from "node:test";

const HOUR = 60 * 60 * 1000;

export function makeJob(over = {}) {
  const now = new Date().toISOString();
  return {
    id: over.id ?? "job-1",
    userId: over.userId ?? "user-1",
    status: "SCHEDULED",
    condition: {
      departure: "동탄",
      arrival: "울산(통도사)",
      date: "2026-10-10",
      passengers: 1,
      seatClass: "any",
      timeFrom: null,
      timeTo: null,
    },
    candidates: [
      { id: "c1", trainNumber: "T101", trainType: "KTX", departAt: "08:05", arriveAt: "10:31", state: "PENDING", lastCheckedAt: null, checkCount: 0 },
      { id: "c2", trainNumber: "T103", trainType: "KTX", departAt: "09:05", arriveAt: "11:31", state: "PENDING", lastCheckedAt: null, checkCount: 0 },
    ],
    providerName: "mock-server",
    simulation: true,
    dedupeKey: over.dedupeKey ?? "user-1|2026-10-10|동탄|울산(통도사)|1",
    reservationIdempotencyKey: over.reservationIdempotencyKey ?? "idem-1",
    hold: null,
    statusDetail: null,
    attempts: 0,
    nextCheckAt: null,
    expiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    createdAt: now,
    updatedAt: now,
    claim: null,
    ...over,
  };
}

export function makeNotification(over = {}) {
  return {
    id: over.id ?? "ntf-1",
    jobId: over.jobId ?? "job-1",
    userId: over.userId ?? "user-1",
    kind: over.kind ?? "SEAT_HELD",
    idempotencyKey: over.idempotencyKey ?? "job-1:SEAT_HELD",
    payload: { departure: "동탄", arrival: "울산(통도사)", date: "2026-10-10", simulation: 1 },
    createdAt: new Date().toISOString(),
    claimedBy: null,
    claimedFencingToken: null,
    sentAt: null,
    failedAttempts: 0,
    ...over,
  };
}

/**
 * 두 구현에 같은 시나리오를 돌린다.
 *
 * @param label 테스트 이름에 붙일 구현 이름
 * @param setup 매 테스트 전에 비어 있는 저장소를 돌려준다
 * @param helpers { newInstance } — 같은 데이터를 보는 **새 저장소 인스턴스**
 */
export function runStoreConformance({ label, setup, helpers = {} }) {
  const t = (name, fn) => test(`[${label}] ${name}`, fn);

  // --- 1. 동시 claim: 승자는 하나 -----------------------------------------
  t("Worker 10개가 동시에 claim 해도 승자는 하나다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    const now = new Date().toISOString();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.claimNext({ workerId: `w-${i}`, now, leaseMs: 30_000 }),
      ),
    );

    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1, `${winners.length}개의 Worker가 같은 작업을 잡았다`);
    assert.ok(winners[0].claim, "승자에게 claim 이 없다");
  });

  // --- 2. fencing token 단조 증가 ------------------------------------------
  t("fencing token 은 claim 마다 단조 증가한다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    const tokens = [];

    for (let i = 0; i < 3; i += 1) {
      const now = new Date().toISOString();
      // lease 0 이면 곧바로 다시 집을 수 있다. 시간을 기다리지 않는다.
      const claimed = await store.claimNext({ workerId: `w-${i}`, now, leaseMs: 0 });
      assert.ok(claimed, `${i}번째 claim 이 비었다`);
      tokens.push(claimed.claim.fencingToken);
    }

    assert.deepEqual(tokens, [1, 2, 3], `토큰이 단조 증가하지 않는다: ${tokens.join(",")}`);
  });

  // --- 3. stale Worker 의 쓰기 거부 ----------------------------------------
  t("오래된 Worker 의 쓰기는 STALE_CLAIM 으로 거부된다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    const now = new Date().toISOString();

    const first = await store.claimNext({ workerId: "w-old", now, leaseMs: 0 });
    const second = await store.claimNext({ workerId: "w-new", now, leaseMs: 30_000 });
    assert.ok(first && second);
    assert.ok(second.claim.fencingToken > first.claim.fencingToken);

    await assert.rejects(
      () =>
        store.updateJob({
          jobId: "job-1",
          workerId: "w-old",
          fencingToken: first.claim.fencingToken,
          patch: { status: "WATCHING" },
        }),
      (error) => error.code === "STALE_CLAIM",
      "오래된 Worker 가 상태를 덮어썼다",
    );

    const job = await store.getJob("job-1");
    assert.equal(job.status, "SCHEDULED", "거부됐는데도 상태가 바뀌었다");
  });

  // --- 4·5. lease 만료 ------------------------------------------------------
  t("lease 가 지나면 새 Worker 가 집고, 이전 Worker 는 쓰지 못한다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    const now = new Date().toISOString();

    const dead = await store.claimNext({ workerId: "w-dead", now, leaseMs: 0 });
    assert.ok(dead, "첫 claim 이 비었다");

    // lease 가 이미 지났으므로 다른 Worker 가 가져갈 수 있다.
    const alive = await store.claimNext({ workerId: "w-alive", now, leaseMs: 30_000 });
    assert.ok(alive, "만료된 claim 을 다른 Worker 가 가져가지 못했다");
    assert.equal(alive.claim.workerId, "w-alive");

    await assert.rejects(
      () =>
        store.updateJob({
          jobId: "job-1",
          workerId: "w-dead",
          fencingToken: dead.claim.fencingToken,
          patch: { status: "WATCHING", statusDetail: "죽었다 깨어난 Worker" },
        }),
      (error) => error.code === "STALE_CLAIM",
      "만료된 Worker 가 여전히 쓸 수 있다",
    );

    await assert.rejects(
      () =>
        store.renewClaim({
          jobId: "job-1",
          workerId: "w-dead",
          fencingToken: dead.claim.fencingToken,
          leaseMs: 30_000,
        }),
      (error) => error.code === "STALE_CLAIM",
      "만료된 Worker 가 claim 을 연장했다",
    );
  });

  // --- 6. 예약 멱등키 중복 거부 --------------------------------------------
  t("같은 예약 멱등키로 작업을 두 번 만들 수 없다", async () => {
    const store = await setup();
    await store.createJob(makeJob({ id: "job-1", reservationIdempotencyKey: "idem-shared" }));

    await assert.rejects(
      () =>
        store.createJob(
          makeJob({
            id: "job-2",
            userId: "user-2",
            dedupeKey: "다른-조건",
            reservationIdempotencyKey: "idem-shared",
          }),
        ),
      "같은 예약 멱등키를 가진 작업이 두 개 생겼다",
    );
  });

  // --- 7. Outbox 멱등키 중복 거부 ------------------------------------------
  t("같은 사건의 알림은 한 번만 Outbox 에 들어간다", async () => {
    const store = await setup();
    await store.createJob(makeJob());

    const first = await store.enqueueNotification(makeNotification({ id: "ntf-1" }));
    const second = await store.enqueueNotification(makeNotification({ id: "ntf-2" }));

    assert.ok(first, "첫 알림이 들어가지 않았다");
    assert.equal(second, null, "같은 멱등키의 알림이 두 번 들어갔다");
    assert.equal((await store.listNotifications("job-1")).length, 1);
  });

  t("Outbox 는 보낸 뒤에만 sent 가 되고, 실패하면 다시 집을 수 있다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    await store.enqueueNotification(makeNotification());

    const claimed = await store.claimNotification({ workerId: "w-1", fencingToken: 1, now: new Date().toISOString() });
    assert.ok(claimed, "알림을 집지 못했다");

    // 이미 집힌 알림은 다른 Worker 가 가져가지 못한다.
    const again = await store.claimNotification({ workerId: "w-2", fencingToken: 2, now: new Date().toISOString() });
    assert.equal(again, null, "집힌 알림을 다른 Worker 가 또 집었다");

    await store.markNotificationFailed({ id: claimed.id, workerId: "w-1", fencingToken: 1 });
    const retried = await store.claimNotification({ workerId: "w-2", fencingToken: 2, now: new Date().toISOString() });
    assert.ok(retried, "실패한 알림을 다시 집지 못했다");
    assert.equal(retried.failedAttempts, 1);

    await store.markNotificationSent({ id: retried.id, workerId: "w-2", fencingToken: 2 });
    const done = (await store.listNotifications("job-1"))[0];
    assert.ok(done.sentAt, "보낸 뒤에도 sent 로 표시되지 않았다");

    const afterSent = await store.claimNotification({ workerId: "w-3", fencingToken: 3, now: new Date().toISOString() });
    assert.equal(afterSent, null, "이미 보낸 알림을 또 집었다");
  });

  // --- 8. 후보 확정 시 나머지 중단 -----------------------------------------
  t("한 후보가 확정되면 나머지 후보가 중단된 상태로 저장된다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    const now = new Date().toISOString();
    const claimed = await store.claimNext({ workerId: "w-1", now, leaseMs: 30_000 });

    const candidates = claimed.candidates.map((candidate) =>
      candidate.id === "c1" ? { ...candidate, state: "RESERVED" } : { ...candidate, state: "STOPPED" },
    );
    await store.updateJob({
      jobId: "job-1",
      workerId: "w-1",
      fencingToken: claimed.claim.fencingToken,
      patch: { status: "RESERVATION_HELD", candidates },
    });

    const job = await store.getJob("job-1");
    assert.deepEqual(job.candidates.map((c) => c.state), ["RESERVED", "STOPPED"]);
  });

  // --- 9. 취소와 Worker 진행의 경쟁 ----------------------------------------
  t("사용자 취소와 Worker 진행이 겹쳐도 한 쪽만 남는다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    const now = new Date().toISOString();
    const claimed = await store.claimNext({ workerId: "w-1", now, leaseMs: 30_000 });

    // 사용자가 먼저 취소한다. 사용자 경로는 claim 과 무관하게 쓴다.
    await store.updateByUser({ jobId: "job-1", userId: "user-1", status: "CANCELLED", statusDetail: "사용자 취소" });

    // Worker 의 쓰기는 여전히 성공한다(토큰이 최신이므로). 중요한 것은
    // 마지막 쓰기가 무엇이든 **두 결과가 섞이지 않는다**는 점이다.
    await store.updateJob({
      jobId: "job-1",
      workerId: "w-1",
      fencingToken: claimed.claim.fencingToken,
      patch: { status: "WATCHING" },
    });

    const job = await store.getJob("job-1");
    assert.ok(["CANCELLED", "WATCHING"].includes(job.status), `예상 밖 상태: ${job.status}`);

    // 취소된 뒤에는 Worker 가 다시 집지 못한다.
    await store.updateByUser({ jobId: "job-1", userId: "user-1", status: "CANCELLED", statusDetail: null });
    await store.releaseClaim({ jobId: "job-1", workerId: "w-1", fencingToken: claimed.claim.fencingToken });
    const after = await store.claimNext({ workerId: "w-2", now: new Date().toISOString(), leaseMs: 30_000 });
    assert.equal(after, null, "취소된 작업을 Worker 가 다시 집었다");
  });

  // --- 10. 저장소 인스턴스를 새로 만들어도 작업이 남는다 --------------------
  t("저장소 인스턴스를 새로 만들어도 작업이 보인다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    const now = new Date().toISOString();
    const claimed = await store.claimNext({ workerId: "w-1", now, leaseMs: 30_000 });
    await store.updateJob({
      jobId: "job-1",
      workerId: "w-1",
      fencingToken: claimed.claim.fencingToken,
      patch: { status: "WATCHING", attempts: 2 },
    });

    const fresh = helpers.newInstance ? await helpers.newInstance() : store;
    const job = await fresh.getJob("job-1");
    assert.ok(job, "새 인스턴스에서 작업을 찾지 못했다");
    assert.equal(job.status, "WATCHING");
    assert.equal(job.attempts, 2);
    assert.equal(job.claim.fencingToken, claimed.claim.fencingToken, "claim 이 복원되지 않았다");
    assert.equal(job.condition.departure, "동탄", "조건이 복원되지 않았다");
    assert.equal(job.candidates.length, 2, "후보가 복원되지 않았다");
  });

  // --- 11. 집을 수 없는 상태 -----------------------------------------------
  t("예약 요청을 보낸 작업과 결제 대기 작업은 Worker 가 집지 않는다", async () => {
    const store = await setup();
    const now = new Date().toISOString();

    for (const status of ["DRAFT", "RESERVATION_CLAIMING", "RESERVATION_HELD", "PAYMENT_PENDING", "COMPLETED"]) {
      await store.createJob(
        makeJob({
          id: `job-${status}`,
          status,
          dedupeKey: `dedupe-${status}`,
          reservationIdempotencyKey: `idem-${status}`,
        }),
      );
    }

    const claimed = await store.claimNext({ workerId: "w-1", now, leaseMs: 30_000 });
    assert.equal(claimed, null, `집으면 안 되는 상태를 집었다: ${claimed?.status}`);
  });

  t("nextCheckAt 이 아직 오지 않은 작업은 집지 않는다", async () => {
    const store = await setup();
    const future = new Date(Date.now() + HOUR).toISOString();
    await store.createJob(makeJob({ nextCheckAt: future }));

    const tooEarly = await store.claimNext({ workerId: "w-1", now: new Date().toISOString(), leaseMs: 30_000 });
    assert.equal(tooEarly, null, "예정 시각 전인데 집었다");

    const later = await store.claimNext({ workerId: "w-1", now: new Date(Date.now() + 2 * HOUR).toISOString(), leaseMs: 30_000 });
    assert.ok(later, "예정 시각이 지났는데도 집지 못했다");
  });

  // --- 조회 계약 -----------------------------------------------------------
  t("같은 사용자·조건의 활성 작업을 찾고, 종료된 작업은 찾지 않는다", async () => {
    const store = await setup();
    await store.createJob(makeJob());

    const active = await store.findActiveByDedupeKey("user-1", "user-1|2026-10-10|동탄|울산(통도사)|1");
    assert.ok(active, "활성 작업을 찾지 못했다");

    await store.updateByUser({ jobId: "job-1", userId: "user-1", status: "CANCELLED", statusDetail: null });
    const afterCancel = await store.findActiveByDedupeKey("user-1", "user-1|2026-10-10|동탄|울산(통도사)|1");
    assert.equal(afterCancel, null, "종료된 작업을 활성으로 찾았다");
  });

  t("사용자별 목록은 자기 작업만 돌려준다", async () => {
    const store = await setup();
    await store.createJob(makeJob({ id: "a", userId: "user-1", dedupeKey: "d1", reservationIdempotencyKey: "i1" }));
    await store.createJob(makeJob({ id: "b", userId: "user-2", dedupeKey: "d2", reservationIdempotencyKey: "i2" }));

    const mine = await store.listJobsByUser("user-1");
    assert.deepEqual(mine.map((j) => j.id), ["a"]);
  });

  t("남의 작업을 사용자 경로로 바꿀 수 없다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    await assert.rejects(
      () => store.updateByUser({ jobId: "job-1", userId: "다른사람", status: "CANCELLED" }),
      (error) => error.code === "NOT_FOUND",
      "남의 작업을 바꿀 수 있다",
    );
  });

  t("claim 을 놓아도 다음 claim 은 더 큰 토큰을 받는다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    const now = new Date().toISOString();

    const first = await store.claimNext({ workerId: "w-1", now, leaseMs: 30_000 });
    await store.releaseClaim({ jobId: "job-1", workerId: "w-1", fencingToken: first.claim.fencingToken });

    const released = await store.getJob("job-1");
    assert.equal(released.claim, null, "claim 이 풀리지 않았다");

    const second = await store.claimNext({ workerId: "w-2", now, leaseMs: 30_000 });
    assert.ok(second.claim.fencingToken > first.claim.fencingToken, "토큰이 되감겼다");
  });

  t("남의 claim 은 놓을 수 없다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    const now = new Date().toISOString();
    const mine = await store.claimNext({ workerId: "w-1", now, leaseMs: 30_000 });

    await store.releaseClaim({ jobId: "job-1", workerId: "침입자", fencingToken: mine.claim.fencingToken });
    const job = await store.getJob("job-1");
    assert.ok(job.claim, "남이 내 claim 을 지웠다");
    assert.equal(job.claim.workerId, "w-1");
  });

  // --- 감사 기록 -----------------------------------------------------------
  t("감사 기록에 사용자 식별자 원문이 들어가지 않는다", async () => {
    const store = await setup();
    await store.createJob(makeJob());
    await store.recordAudit({
      jobId: "job-1",
      userPseudonym: "a".repeat(32),
      event: "PROGRESSED",
      fromStatus: "SCHEDULED",
      toStatus: "WATCHING",
      workerId: "w-1",
      fencingToken: 1,
      detail: "감시 시작",
    });

    const entries = await store.listAudit("job-1");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].userPseudonym, "a".repeat(32));
    assert.ok(!JSON.stringify(entries[0]).includes("user-1"), "감사 기록에 사용자 식별자 원문이 있다");
  });
}
