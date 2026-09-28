// Worker 실행 진입점의 중단 조건.
//
// 여기서 확인하는 것은 "언제 아무 것도 하지 않는가"다. 외부로 나가는 요청은
// 한 건도 없어야 한다 -- 그것을 fetch 를 가로채서 직접 센다.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";

const { loadTs } = loader;

/** 이 프로세스에서 나가는 외부 요청을 전부 센다. */
function countNetworkCalls(run) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(String(args[0]));
    throw new Error("테스트 중 외부 요청이 발생했다");
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
    })
    .then((value) => ({ value, calls }));
}

function withEnv(env, run) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

const BASE_ENV = {
  AUTOBOOK_KILL_SWITCH: undefined,
  AUTOBOOK_PROVIDER: undefined,
  AUTOBOOK_STORE: undefined,
  ENABLE_AUTOBOOK_JOBS: undefined,
  AUTOBOOK_DATABASE_URL: undefined,
  DATABASE_URL: undefined,
  AUTOBOOK_WORKER_SCHEDULE: undefined,
};

async function runWorker(env) {
  const { runAutobookWorkerOnce } = loadTs("lib/autobook/worker-entry.ts");
  return withEnv({ ...BASE_ENV, ...env }, () =>
    countNetworkCalls(() => runAutobookWorkerOnce({ workerId: "test-worker" })),
  );
}

test("기본값에서는 아무 것도 실행하지 않는다", async () => {
  const { value, calls } = await runWorker({});
  assert.equal(value.stopped, "JOBS_DISABLED");
  assert.equal(value.ran.length, 0);
  assert.equal(calls.length, 0, "외부 요청이 발생했다");
});

test("강제 중단 스위치가 모든 것보다 먼저다", async () => {
  const { value, calls } = await runWorker({
    AUTOBOOK_KILL_SWITCH: "on",
    ENABLE_AUTOBOOK_JOBS: "true",
    AUTOBOOK_STORE: "memory",
    AUTOBOOK_PROVIDER: "mock-server",
  });
  assert.equal(value.stopped, "KILL_SWITCH_ON");
  assert.equal(value.store, "disabled", "kill switch 상태에서 저장소를 골랐다");
  assert.equal(calls.length, 0);
});

test("DB 설정이 없으면 memory 로 후퇴하지 않고 멈춘다", async () => {
  const { value, calls } = await runWorker({
    ENABLE_AUTOBOOK_JOBS: "true",
    AUTOBOOK_STORE: "postgres",
    AUTOBOOK_PROVIDER: "mock-server",
  });
  assert.equal(value.stopped, "STORE_UNAVAILABLE");
  assert.equal(value.store, "postgres", "postgres 를 요청했는데 memory 로 후퇴했다");
  assert.match(value.detail, /DATABASE_URL/);
  assert.equal(calls.length, 0);
});

test("DATABASE_URL 형식이 틀려도 memory 로 후퇴하지 않는다", async () => {
  const { value } = await runWorker({
    ENABLE_AUTOBOOK_JOBS: "true",
    AUTOBOOK_STORE: "postgres",
    AUTOBOOK_DATABASE_URL: "mysql://localhost/x",
    AUTOBOOK_PROVIDER: "mock-server",
  });
  assert.equal(value.stopped, "STORE_UNAVAILABLE");
  assert.equal(value.store, "postgres");
});

test("공식 Provider Stub 이면 OFFICIAL_INTEGRATION_REQUIRED 로 멈춘다", async () => {
  const { value, calls } = await runWorker({
    ENABLE_AUTOBOOK_JOBS: "true",
    AUTOBOOK_STORE: "memory",
    AUTOBOOK_PROVIDER: "official-approved",
  });
  assert.equal(value.stopped, "OFFICIAL_INTEGRATION_REQUIRED");
  assert.equal(value.ran.length, 0, "Stub Provider 로 작업을 진행했다");
  assert.equal(calls.length, 0, "Stub Provider 가 외부 요청을 보냈다");
});

test("기본 Provider(unavailable)는 좌석 조회조차 하지 않는다", async () => {
  const { value, calls } = await runWorker({
    ENABLE_AUTOBOOK_JOBS: "true",
    AUTOBOOK_STORE: "memory",
  });
  assert.equal(value.stopped, "PROVIDER_CANNOT_READ");
  assert.equal(calls.length, 0);
});

test("배치 상한은 5를 넘지 않는다", async () => {
  const { value } = await runWorker({
    ENABLE_AUTOBOOK_JOBS: "true",
    AUTOBOOK_STORE: "memory",
    AUTOBOOK_PROVIDER: "mock-server",
    AUTOBOOK_WORKER_BATCH: "50",
  });
  assert.ok(value.batchLimit <= 5, `배치 상한이 ${value.batchLimit} 이다`);
});

test("Mock Provider 로 진행해도 외부 요청은 0회다", async () => {
  const { createMemoryAutobookStore, resetMemoryAutobookStore } = loadTs("lib/autobook/memory-store.ts");
  const { setMockScenario, resetMockServerProvider } = loadTs("lib/autobook/providers/mock-server.ts");
  const { makeJob } = await import("./store-conformance.mjs");

  resetMemoryAutobookStore();
  resetMockServerProvider();
  await createMemoryAutobookStore().createJob(makeJob({ id: "job-1" }));
  setMockScenario("job-1", { kind: "seat_after", checks: 1, seatClass: "standard" });

  const { value, calls } = await runWorker({
    ENABLE_AUTOBOOK_JOBS: "true",
    AUTOBOOK_STORE: "memory",
    AUTOBOOK_PROVIDER: "mock-server",
  });

  assert.equal(value.stopped, null, `진행하지 못했다: ${value.stopped}`);
  assert.ok(value.ran.length >= 1, "작업을 한 건도 진행하지 않았다");
  assert.equal(calls.length, 0, "시뮬레이션이 외부로 요청을 보냈다");

  // 감사 기록이 남되, 사용자 식별자 원문은 없어야 한다.
  const audit = await createMemoryAutobookStore().listAudit("job-1");
  assert.ok(audit.length >= 1, "감사 기록이 남지 않았다");
  assert.ok(!JSON.stringify(audit).includes("user-1"), "감사 기록에 사용자 식별자 원문이 있다");
});

test("불명확한 예약 결과에서 재예약하지 않는다", async () => {
  const { createMemoryAutobookStore, resetMemoryAutobookStore } = loadTs("lib/autobook/memory-store.ts");
  const { setMockScenario, resetMockServerProvider } = loadTs("lib/autobook/providers/mock-server.ts");
  const { makeJob } = await import("./store-conformance.mjs");

  resetMemoryAutobookStore();
  resetMockServerProvider();
  const store = createMemoryAutobookStore();
  await store.createJob(makeJob({ id: "job-1" }));
  // 응답은 유실되고 예약도 생기지 않는 시나리오.
  setMockScenario("job-1", { kind: "ambiguous_and_absent", checks: 1 });

  const { value, calls } = await runWorker({
    ENABLE_AUTOBOOK_JOBS: "true",
    AUTOBOOK_STORE: "memory",
    AUTOBOOK_PROVIDER: "mock-server",
    AUTOBOOK_WORKER_BATCH: "5",
  });

  assert.equal(calls.length, 0);
  const job = await store.getJob("job-1");
  assert.equal(job.status, "AMBIGUOUS_RESULT", `불명확한 결과에서 ${job.status} 로 갔다`);
  // 종료 상태이므로 같은 실행의 남은 배치에서도 다시 집히지 않는다.
  const progressed = value.ran.filter((r) => r.kind === "PROGRESSED");
  assert.equal(progressed.length, 1, "불명확한 결과 뒤에 작업을 또 진행했다");
});

test("감사 detail 이 자격증명 비슷한 문구를 통과시키지 않는다", () => {
  const { safeAuditDetail, auditPseudonym } = loadTs("lib/autobook/audit.ts");
  assert.equal(safeAuditDetail("password=abcd"), "[redacted]");
  assert.equal(safeAuditDetail("Cookie: session=1"), "[redacted]");
  assert.equal(safeAuditDetail("좌석을 확보했습니다"), "좌석을 확보했습니다");
  assert.equal(safeAuditDetail(null), null);

  const a = auditPseudonym("user-1");
  assert.equal(a, auditPseudonym("user-1"), "같은 사용자가 다른 가명을 받았다");
  assert.notEqual(a, auditPseudonym("user-2"));
  assert.ok(!a.includes("user-1"));
});
