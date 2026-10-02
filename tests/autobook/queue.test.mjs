// lib/autobook/queue.ts 의 drainOnce.
//
// T2. 이 함수는 **호출자도 테스트도 없는 공개 진입점**이었다. 외부 스케줄러가
// 부르도록 만들어진 자리이므로, 지금 동작을 고정해 둔다.
//
// worker-entry.ts 의 runAutobookWorkerOnce() 와 역할이 겹치지만 계약이 다르다 --
// drainOnce 는 저장소를 인자로 받고 Provider 능력(canReadAvailability 등)을
// 확인하지 않는다. 그 차이를 추측하지 않고 실제 동작으로 적어 둔다.
//
// 외부 요청은 한 건도 없어야 한다 -- fetch 를 가로채서 직접 센다.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";
import { makeJob } from "./store-conformance.mjs";

const { loadTs } = loader;

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
  AUTOBOOK_WORKER_BATCH: undefined,
};

/** claimNext 호출 횟수를 세는 얇은 래퍼. 나머지는 그대로 넘긴다. */
function countingStore(inner) {
  const counts = { claimNext: 0 };
  return {
    counts,
    store: new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "claimNext" || typeof value !== "function") return value;
        return (...args) => {
          counts.claimNext += 1;
          return value.apply(target, args);
        };
      },
    }),
  };
}

function freshStore() {
  const { createMemoryAutobookStore, resetMemoryAutobookStore } = loadTs("lib/autobook/memory-store.ts");
  resetMemoryAutobookStore();
  return createMemoryAutobookStore();
}

function resetProvider() {
  const { resetMockServerProvider } = loadTs("lib/autobook/providers/mock-server.ts");
  resetMockServerProvider();
}

async function drain(env, store) {
  const { drainOnce } = loadTs("lib/autobook/queue.ts");
  return withEnv({ ...BASE_ENV, ...env }, () =>
    countNetworkCalls(() => drainOnce({ store, workerId: "queue-test" })),
  );
}

// --- 중단 조건 -------------------------------------------------------------

test("기본값에서는 아무 것도 진행하지 않는다", async () => {
  const { value, calls } = await drain({}, freshStore());
  assert.equal(value.stopped, "JOBS_DISABLED");
  assert.deepEqual(value.ran, []);
  assert.equal(calls.length, 0, "외부 요청이 발생했다");
});

test("강제 중단 스위치가 모든 것보다 먼저다", async () => {
  const { counts, store } = countingStore(freshStore());
  await store.createJob(makeJob({ id: "job-1" }));

  const { value, calls } = await drain(
    {
      AUTOBOOK_KILL_SWITCH: "on",
      ENABLE_AUTOBOOK_JOBS: "true",
      AUTOBOOK_PROVIDER: "mock-server",
    },
    store,
  );

  assert.equal(value.stopped, "KILL_SWITCH_ON");
  assert.deepEqual(value.ran, []);
  assert.equal(counts.claimNext, 0, "강제 중단 상태에서 작업을 집으려 했다");
  assert.equal(calls.length, 0);
});

test("강제 중단이 JOBS_DISABLED 보다 먼저 보고된다", async () => {
  // 둘 다 막힌 상태에서 어느 쪽을 보고하는지 고정한다.
  const { value } = await drain({ AUTOBOOK_KILL_SWITCH: "on" }, freshStore());
  assert.equal(value.stopped, "KILL_SWITCH_ON");
});

// --- 빈 저장소에서 루프가 도는지 ------------------------------------------

test("집을 작업이 없으면 배치를 다 돌지 않고 한 번에 멈춘다", async () => {
  const { counts, store } = countingStore(freshStore());

  const { value, calls } = await drain(
    { ENABLE_AUTOBOOK_JOBS: "true", AUTOBOOK_PROVIDER: "mock-server", AUTOBOOK_WORKER_BATCH: "5" },
    store,
  );

  assert.equal(value.stopped, null);
  assert.deepEqual(value.ran, []);
  assert.equal(counts.claimNext, 1, `IDLE 에서 멈추지 않고 ${counts.claimNext}번 집으려 했다`);
  assert.equal(calls.length, 0);
});

// --- 진행과 배치 상한 -----------------------------------------------------

test("작업이 있으면 진행하고 결과를 모은다", async () => {
  resetProvider();
  const store = freshStore();
  await store.createJob(makeJob({ id: "job-1" }));
  const { setMockScenario } = loadTs("lib/autobook/providers/mock-server.ts");
  setMockScenario("job-1", { kind: "seat_after", checks: 1, seatClass: "standard" });

  const { value, calls } = await drain(
    { ENABLE_AUTOBOOK_JOBS: "true", AUTOBOOK_PROVIDER: "mock-server" },
    store,
  );

  assert.equal(value.stopped, null);
  assert.ok(value.ran.length >= 1, "작업을 한 건도 진행하지 않았다");
  assert.ok(
    value.ran.every((r) => r.kind !== "IDLE"),
    "IDLE 결과가 ran 에 섞였다",
  );
  assert.equal(calls.length, 0, "시뮬레이션이 외부로 요청을 보냈다");
});

test("배치 상한을 넘겨 집지 않는다", async () => {
  resetProvider();
  const { counts, store } = countingStore(freshStore());
  const { setMockScenario } = loadTs("lib/autobook/providers/mock-server.ts");
  for (let i = 0; i < 8; i += 1) {
    await store.createJob(
      makeJob({ id: `job-${i}`, dedupeKey: `d-${i}`, reservationIdempotencyKey: `i-${i}` }),
    );
    setMockScenario(`job-${i}`, { kind: "always_sold_out" });
  }

  const { value } = await drain(
    { ENABLE_AUTOBOOK_JOBS: "true", AUTOBOOK_PROVIDER: "mock-server", AUTOBOOK_WORKER_BATCH: "3" },
    store,
  );

  assert.equal(counts.claimNext, 3, `배치 3인데 ${counts.claimNext}번 집었다`);
  assert.ok(value.ran.length <= 3);
});

test("배치 상한 요청이 과도해도 5를 넘지 않는다", async () => {
  resetProvider();
  const { counts, store } = countingStore(freshStore());
  const { setMockScenario } = loadTs("lib/autobook/providers/mock-server.ts");
  for (let i = 0; i < 12; i += 1) {
    await store.createJob(
      makeJob({ id: `job-${i}`, dedupeKey: `d-${i}`, reservationIdempotencyKey: `i-${i}` }),
    );
    setMockScenario(`job-${i}`, { kind: "always_sold_out" });
  }

  await drain(
    { ENABLE_AUTOBOOK_JOBS: "true", AUTOBOOK_PROVIDER: "mock-server", AUTOBOOK_WORKER_BATCH: "50" },
    store,
  );

  assert.ok(counts.claimNext <= 5, `배치 상한을 넘겼다: ${counts.claimNext}`);
});

// --- Provider 선택 --------------------------------------------------------

test("Production 에서는 mock-server 가 선택되지 않는다", async () => {
  resetProvider();
  const store = freshStore();
  await store.createJob(makeJob({ id: "job-1" }));

  const { calls } = await withEnv({ NODE_ENV: "production" }, () =>
    drain({ ENABLE_AUTOBOOK_JOBS: "true", AUTOBOOK_PROVIDER: "mock-server" }, store),
  );

  // mock 이 거부되면 unavailable 로 떨어지고, 좌석을 읽지 못해 진행이 막힌다.
  assert.equal(calls.length, 0);
  const job = await store.getJob("job-1");
  assert.notEqual(job.status, "RESERVATION_HELD", "Production 에서 시뮬레이션으로 좌석을 확보했다");
  assert.notEqual(job.status, "PAYMENT_PENDING");
});

test("drainOnce 는 Provider 능력을 확인하지 않는다(worker-entry 와의 차이)", async () => {
  // 사실을 기록하는 테스트다. worker-entry.runAutobookWorkerOnce() 는
  // canReadAvailability 를 보고 PROVIDER_CANNOT_READ 로 멈추지만, drainOnce 는
  // 그 검사 없이 runOnce 에 그대로 넘긴다. 외부 요청이 없다는 것과, 좌석을
  // 확보한 것처럼 끝나지 않는다는 것만 보장된다.
  resetProvider();
  const store = freshStore();
  await store.createJob(makeJob({ id: "job-1" }));

  const { value, calls } = await drain({ ENABLE_AUTOBOOK_JOBS: "true" }, store); // Provider 미지정 -> unavailable

  assert.equal(value.stopped, null, "drainOnce 가 Provider 능력으로 멈춘다면 이 테스트를 고쳐야 한다");
  assert.equal(calls.length, 0);
  const job = await store.getJob("job-1");
  assert.ok(
    job.status !== "RESERVATION_HELD" && job.status !== "PAYMENT_PENDING",
    `Provider 가 unavailable 인데 ${job.status} 로 갔다`,
  );
});
