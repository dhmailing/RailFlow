// v0.9 서버형 자동예약 Worker 테스트.
//
// 여기서 쓰는 Provider 는 Mock 이다. **실제 사이트 연동 검증이 아니다.**
// 검증하는 것은 "Provider 가 이런 값을 돌려줬을 때 Worker 가 어떻게
// 행동하는가" -- 특히 중복 예약을 만들지 않는가다.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";
const { loadTs } = loader;

process.env.NODE_ENV = "test";
process.env.AUTOBOOK_PROVIDER = "mock-server";
process.env.AUTOBOOK_STORE = "memory";
process.env.ENABLE_AUTOBOOK_JOBS = "true";

const { createMemoryAutobookStore, resetMemoryAutobookStore } = loadTs("lib/autobook/memory-store.ts");
const { mockServerProvider, setMockScenario, resetMockServerProvider } = loadTs(
  "lib/autobook/providers/mock-server.ts",
);
const { unavailableProvider } = loadTs("lib/autobook/providers/unavailable.ts");
const { officialApprovedStubProvider } = loadTs("lib/autobook/providers/official-approved-stub.ts");
const { runOnce } = loadTs("lib/autobook/worker.ts");

const HOUR = 60 * 60 * 1000;

function makeJob(over = {}) {
  const now = new Date().toISOString();
  return {
    id: over.id ?? "job-1",
    userId: "user-1",
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
    dedupeKey: "user-1|2026-10-10|동탄|울산(통도사)|1",
    reservationIdempotencyKey: "idem-1",
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

function setup() {
  resetMemoryAutobookStore();
  resetMockServerProvider();
  return createMemoryAutobookStore();
}

test("동시 Worker 10개가 같은 작업을 잡아도 예약 요청은 한 번만 나간다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "seat_after", checks: 1, seatClass: "standard" });

  let createCalls = 0;
  const countingProvider = {
    ...mockServerProvider,
    async createReservation(input) {
      createCalls += 1;
      return mockServerProvider.createReservation(input);
    },
  };

  // 10개를 동시에 돌린다.
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      runOnce({ store, provider: countingProvider, workerId: `worker-${i}` }),
    ),
  );

  assert.equal(createCalls, 1, `예약 요청이 ${createCalls}번 나갔다`);
  const job = await store.getJob("job-1");
  assert.equal(job.status, "RESERVATION_HELD");
  // 나머지 9개는 작업을 잡지 못했거나(IDLE) 물러났어야 한다.
  const progressed = results.filter((r) => r.kind === "PROGRESSED");
  assert.equal(progressed.length, 1, "두 개 이상의 Worker 가 작업을 진행했다");
});

test("오래된 Worker 는 아무 것도 쓰지 못한다 (fencing token)", async () => {
  const store = setup();
  await store.createJob(makeJob());

  // Worker A 가 먼저 잡는다.
  const a = await store.claimNext({ workerId: "A", now: new Date().toISOString(), leaseMs: 1 });
  assert.ok(a);
  const tokenA = a.claim.fencingToken;

  // lease 가 만료된 뒤 Worker B 가 가져간다.
  await new Promise((r) => setTimeout(r, 10));
  const b = await store.claimNext({ workerId: "B", now: new Date().toISOString(), leaseMs: 30_000 });
  assert.ok(b);
  assert.ok(b.claim.fencingToken > tokenA, "새 토큰이 더 커야 한다");

  // 뒤늦게 깨어난 A 의 쓰기는 거부된다.
  await assert.rejects(
    () => store.updateJob({ jobId: "job-1", workerId: "A", fencingToken: tokenA, patch: { status: "CANCELLED" } }),
    /STALE_CLAIM|더 최신 Worker/,
  );
  const job = await store.getJob("job-1");
  assert.notEqual(job.status, "CANCELLED", "오래된 Worker 의 쓰기가 반영됐다");
});

test("좌석 확보 후 나머지 후보가 즉시 중단된다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "seat_after", checks: 1, seatClass: "standard" });

  await runOnce({ store, provider: mockServerProvider, workerId: "w1" });
  const job = await store.getJob("job-1");

  assert.equal(job.status, "RESERVATION_HELD");
  assert.equal(job.candidates.find((c) => c.id === "c1").state, "RESERVED");
  assert.equal(job.candidates.find((c) => c.id === "c2").state, "STOPPED");
});

test("예약 응답이 유실돼도 예약내역 재조회로 확정한다 (재예약 없음)", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "ambiguous_but_reserved", checks: 1 });

  let createCalls = 0;
  const provider = {
    ...mockServerProvider,
    async createReservation(input) {
      createCalls += 1;
      return mockServerProvider.createReservation(input);
    },
  };

  await runOnce({ store, provider, workerId: "w1" });
  const job = await store.getJob("job-1");

  assert.equal(job.status, "RESERVATION_HELD", "예약내역에서 확인했으면 확보 상태여야 한다");
  assert.equal(createCalls, 1, "재예약을 시도했다");
  assert.match(job.statusDetail, /예약내역에서 예약을 확인/);
});

test("결과가 불명확하고 예약도 없으면 자동 재예약 없이 멈춘다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "ambiguous_and_absent", checks: 1 });

  let createCalls = 0;
  const provider = {
    ...mockServerProvider,
    async createReservation(input) {
      createCalls += 1;
      return mockServerProvider.createReservation(input);
    },
  };

  await runOnce({ store, provider, workerId: "w1" });
  let job = await store.getJob("job-1");
  assert.equal(job.status, "AMBIGUOUS_RESULT");
  assert.equal(createCalls, 1);

  // 다시 돌려도 종료 상태라 집히지 않는다 = 자동 재예약이 없다.
  const again = await runOnce({ store, provider, workerId: "w2" });
  assert.equal(again.kind, "IDLE");
  job = await store.getJob("job-1");
  assert.equal(job.status, "AMBIGUOUS_RESULT");
  assert.equal(createCalls, 1, "종료 후에도 예약을 시도했다");
});

test("좌석이 사라진 경우(GONE)는 감시로 안전하게 돌아간다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "seat_then_gone", checks: 1 });

  await runOnce({ store, provider: mockServerProvider, workerId: "w1" });
  const job = await store.getJob("job-1");
  assert.equal(job.status, "WATCHING");
  assert.match(job.statusDetail, /사라졌습니다/);
});

test("인증 만료는 즉시 중단하고 재시도하지 않는다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "auth_required" });

  await runOnce({ store, provider: mockServerProvider, workerId: "w1" });
  const job = await store.getJob("job-1");
  assert.equal(job.status, "AUTH_REQUIRED");
});

test("요청 제한은 지수적으로 폭주하지 않고 뒤로 민다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "rate_limited", retryAfterSeconds: 120 });

  const before = Date.now();
  await runOnce({ store, provider: mockServerProvider, workerId: "w1" });
  const job = await store.getJob("job-1");

  assert.equal(job.status, "RATE_LIMITED");
  assert.ok(job.nextCheckAt, "다음 조회 시각이 없다");
  const waitMs = Date.parse(job.nextCheckAt) - before;
  assert.ok(waitMs >= 1000, `백오프가 너무 짧다: ${waitMs}ms`);
  // 즉시 다시 집히면 안 된다.
  const again = await runOnce({ store, provider: mockServerProvider, workerId: "w2" });
  assert.equal(again.kind, "IDLE", "요청 제한 중인데 바로 다시 돌았다");
});

test("운영자 차단은 BLOCKED_BY_OPERATOR 로 전환하고 끝난다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "blocked_by_operator" });

  await runOnce({ store, provider: mockServerProvider, workerId: "w1" });
  const job = await store.getJob("job-1");
  assert.equal(job.status, "BLOCKED_BY_OPERATOR");

  // 종료 상태다. 다시 집히지 않는다(= 우회 재시도가 없다).
  assert.equal((await runOnce({ store, provider: mockServerProvider, workerId: "w2" })).kind, "IDLE");
});

test("결제기한이 지나면 만료된다", async () => {
  const store = setup();
  await store.createJob(makeJob({ expiresAt: new Date(Date.now() - 1000).toISOString() }));

  await runOnce({ store, provider: mockServerProvider, workerId: "w1" });
  const job = await store.getJob("job-1");
  assert.equal(job.status, "EXPIRED");
});

test("좌석 조회만 가능한 Provider 로는 예약을 시도하지 않는다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "seat_after", checks: 1, seatClass: "standard" });

  let createCalls = 0;
  const readOnlyProvider = {
    ...mockServerProvider,
    capabilities: () => ({
      canReadAvailability: true,
      canCreateReservation: false,
      canVerifyReservation: false,
      simulation: true,
    }),
    async createReservation() {
      createCalls += 1;
      throw new Error("호출되면 안 된다");
    },
  };

  await runOnce({ store, provider: readOnlyProvider, workerId: "w1" });
  const job = await store.getJob("job-1");
  assert.equal(job.status, "PROVIDER_UNAVAILABLE");
  assert.equal(createCalls, 0);
});

test("unavailable Provider 는 좌석 조회조차 하지 않고 정직하게 멈춘다", async () => {
  const store = setup();
  await store.createJob(makeJob({ providerName: "unavailable", simulation: false }));

  await runOnce({ store, provider: unavailableProvider, workerId: "w1" });
  const job = await store.getJob("job-1");
  assert.equal(job.status, "PROVIDER_UNAVAILABLE");
  assert.match(job.statusDetail, /공식·승인된 좌석 조회 연동이 아직 없습니다/);
});

test("official-approved 는 Stub 이라 아무 것도 하지 않는다", async () => {
  const store = setup();
  await store.createJob(makeJob({ providerName: "official-approved (stub)", simulation: false }));

  const caps = officialApprovedStubProvider.capabilities();
  assert.equal(caps.canReadAvailability, false);
  assert.equal(caps.canCreateReservation, false);
  assert.equal(caps.simulation, false);

  await runOnce({ store, provider: officialApprovedStubProvider, workerId: "w1" });
  const job = await store.getJob("job-1");
  assert.equal(job.status, "PROVIDER_UNAVAILABLE");
});

test("같은 멱등키로 두 번 예약해도 예약은 하나다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  const job = await store.getJob("job-1");
  const candidate = job.candidates[0];

  const first = await mockServerProvider.createReservation({ job, candidate, idempotencyKey: "same-key" });
  const second = await mockServerProvider.createReservation({ job, candidate, idempotencyKey: "same-key" });

  assert.equal(first.kind, "HELD");
  assert.equal(second.kind, "HELD");
  assert.equal(first.hold.reservationRef, second.hold.reservationRef, "예약이 두 건 생겼다");
});

test("예약 요청 중 예외가 나면 감시로 되돌리지 않고 결과를 확정한다", async () => {
  // 회귀 방지: 예외 처리에서 claim 시점의 상태를 보면 예약 요청을 보낸 뒤인데도
  // WATCHING 으로 되돌려, 다음 주기에 같은 좌석을 다시 예약하려 든다.
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "seat_after", checks: 1, seatClass: "standard" });

  let createCalls = 0;
  const throwingProvider = {
    ...mockServerProvider,
    async createReservation() {
      createCalls += 1;
      throw new Error("연결이 끊겼습니다");
    },
    async findExistingReservation() {
      return null;
    },
  };

  const result = await runOnce({ store, provider: throwingProvider, workerId: "worker-1" });
  assert.equal(result.kind, "PROGRESSED");
  assert.equal(result.to, "AMBIGUOUS_RESULT");

  const job = await store.getJob("job-1");
  assert.equal(job.status, "AMBIGUOUS_RESULT", "예약 요청 뒤에 상태가 되돌아갔다");
  assert.equal(job.nextCheckAt, null, "종료 상태인데 다음 조회가 예약돼 있다");

  // 다시 돌려도 Worker 가 집지 않는다(종료 상태) = 재예약 경로가 없다.
  const again = await runOnce({ store, provider: throwingProvider, workerId: "worker-2" });
  assert.equal(again.kind, "IDLE");
  assert.equal(createCalls, 1, `예약 요청이 ${createCalls}번 나갔다`);
});

test("예약 요청 중 예외가 났지만 실제로 예약이 생겼으면 예약내역으로 확정한다", async () => {
  const store = setup();
  await store.createJob(makeJob());
  setMockScenario("job-1", { kind: "seat_after", checks: 1, seatClass: "standard" });

  const hold = {
    candidateId: "c1",
    trainNumber: "T101",
    departAt: "08:05",
    reservationRef: "SIM-RECOVER1",
    paymentDueAt: null,
    officialPaymentUrl: null,
    confirmedBy: "reservationList",
    confirmedAt: new Date().toISOString(),
  };

  let createCalls = 0;
  const flakyProvider = {
    ...mockServerProvider,
    async createReservation() {
      createCalls += 1;
      throw new Error("응답을 받기 전에 연결이 끊겼습니다");
    },
    async findExistingReservation() {
      return hold;
    },
  };

  const result = await runOnce({ store, provider: flakyProvider, workerId: "worker-1" });
  assert.equal(result.to, "RESERVATION_HELD");

  const job = await store.getJob("job-1");
  assert.equal(job.status, "RESERVATION_HELD");
  assert.equal(job.hold.reservationRef, "SIM-RECOVER1");
  assert.equal(job.hold.confirmedBy, "reservationList", "예약내역 재조회로 확정하지 않았다");
  assert.deepEqual(
    job.candidates.map((c) => c.state),
    ["RESERVED", "STOPPED"],
    "확보 후 나머지 후보를 중단하지 않았다",
  );
  assert.equal(createCalls, 1, `예약 요청이 ${createCalls}번 나갔다`);
});
