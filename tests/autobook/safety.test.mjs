// v0.9 안전장치 테스트: fail-closed 플래그, Outbox 멱등성, 자격증명 미노출.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";
const { loadTs } = loader;

const { createMemoryAutobookStore, resetMemoryAutobookStore } = loadTs("lib/autobook/memory-store.ts");
const { buildNotification, createInMemoryChannel, flushOutboxOnce, notificationIdempotencyKey } = loadTs(
  "lib/autobook/outbox.ts",
);
const { accountLinkAvailability, createMemoryAccountLinkStore, METHOD_AVAILABILITY } = loadTs(
  "lib/autobook/account-link.ts",
);
const { canTransition, resolveCancelTarget, isTerminal, STATUS_LABEL } = loadTs("lib/autobook/state-machine.ts");
const { AUTOBOOK_JOB_STATUSES } = loadTs("lib/autobook/types.ts");

function freshFlags(env) {
  for (const key of ["AUTOBOOK_PROVIDER", "AUTOBOOK_STORE", "ENABLE_AUTOBOOK_JOBS", "AUTOBOOK_KILL_SWITCH", "NODE_ENV"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  // 플래그 모듈은 호출 시점에 env 를 읽으므로 캐시를 비울 필요가 없다.
  return loadTs("lib/autobook/feature-flags.ts");
}

// --- fail-closed 플래그 -----------------------------------------------------

test("기본값은 전부 비활성이다", () => {
  const flags = freshFlags({ NODE_ENV: "test" });
  assert.equal(flags.getAutobookProviderFlag(), "unavailable");
  assert.equal(flags.getAutobookStoreMode(), "disabled");
  assert.equal(flags.isAutobookEnabled(), false);
  assert.equal(flags.isAutobookStoreUsable(), false);
});

test("알 수 없는 값은 가장 안전한 쪽으로 떨어진다", () => {
  const flags = freshFlags({ NODE_ENV: "test", AUTOBOOK_PROVIDER: "yolo", AUTOBOOK_STORE: "s3" });
  assert.equal(flags.getAutobookProviderFlag(), "unavailable");
  assert.equal(flags.getAutobookStoreMode(), "disabled");
});

test("Production 에서는 Mock Provider 와 메모리 저장소가 막힌다", () => {
  const flags = freshFlags({
    NODE_ENV: "production",
    AUTOBOOK_PROVIDER: "mock-server",
    AUTOBOOK_STORE: "memory",
    ENABLE_AUTOBOOK_JOBS: "true",
  });
  assert.equal(flags.getAutobookProviderFlag(), "unavailable", "운영에서 Mock 이 선택됐다");
  assert.equal(flags.isAutobookStoreUsable(), false, "운영에서 메모리 저장소가 쓰인다");
});

test("강제 중단 스위치가 모든 것보다 우선한다", () => {
  const flags = freshFlags({
    NODE_ENV: "test",
    AUTOBOOK_KILL_SWITCH: "on",
    AUTOBOOK_PROVIDER: "mock-server",
    AUTOBOOK_STORE: "memory",
    ENABLE_AUTOBOOK_JOBS: "true",
  });
  assert.equal(flags.getAutobookProviderFlag(), "unavailable");
  assert.equal(flags.getAutobookStoreMode(), "disabled");
  assert.equal(flags.isAutobookEnabled(), false);
  assert.equal(flags.autobookRuntimeStatus().killSwitch, true);
});

test("실제 예약이 가능한 조합은 아직 없다", () => {
  for (const provider of ["unavailable", "mock-server", "official-approved"]) {
    const flags = freshFlags({ NODE_ENV: "test", AUTOBOOK_PROVIDER: provider, ENABLE_AUTOBOOK_JOBS: "true" });
    assert.equal(
      flags.autobookRuntimeStatus().liveReservationPossible,
      false,
      `${provider} 에서 실제 예약이 가능하다고 표시된다`,
    );
  }
});

test("Worker 배치 크기에 상한이 있다", () => {
  const flags = freshFlags({ NODE_ENV: "test", AUTOBOOK_WORKER_BATCH: "1000" });
  assert.ok(flags.getWorkerBatchSize() <= 5);
  delete process.env.AUTOBOOK_WORKER_BATCH;
});

// --- 상태 기계 --------------------------------------------------------------

test("예약 요청 뒤에는 재시도로 돌아가는 길이 없다", () => {
  assert.equal(canTransition("RESERVATION_CLAIMING", "SEAT_FOUND"), false);
  assert.equal(canTransition("RESERVATION_CLAIMING", "RESERVATION_CLAIMING"), false);
  // 확정·소멸·불명확만 가능하다.
  assert.equal(canTransition("RESERVATION_CLAIMING", "RESERVATION_HELD"), true);
  assert.equal(canTransition("RESERVATION_CLAIMING", "WATCHING"), true);
  assert.equal(canTransition("RESERVATION_CLAIMING", "AMBIGUOUS_RESULT"), true);
});

test("예약 요청 뒤에는 사용자 취소가 곧바로 CANCELLED 가 되지 않는다", () => {
  assert.equal(canTransition("RESERVATION_CLAIMING", "CANCELLED"), false);
  assert.equal(resolveCancelTarget("RESERVATION_CLAIMING"), "RESERVATION_CLAIMING");
  // 요청 전이라면 그냥 취소다.
  assert.equal(resolveCancelTarget("WATCHING"), "CANCELLED");
});

test("불명확·운영자 차단은 종료 상태다", () => {
  for (const status of ["AMBIGUOUS_RESULT", "BLOCKED_BY_OPERATOR", "COMPLETED", "EXPIRED", "CANCELLED"]) {
    assert.equal(isTerminal(status), true, `${status} 가 종료 상태가 아니다`);
    assert.equal(canTransition(status, "WATCHING"), false, `${status} 에서 되살아난다`);
  }
});

test("중단 상태는 활성 상태 어디서든 도달할 수 있다", () => {
  const active = ["SCHEDULED", "WATCHING", "SEAT_FOUND", "RESERVATION_CLAIMING", "RESERVATION_HELD"];
  for (const from of active) {
    for (const to of ["AUTH_REQUIRED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "BLOCKED_BY_OPERATOR", "EXPIRED"]) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to} 가 막혀 있다`);
    }
  }
});

test("모든 상태에 화면 라벨이 있다", () => {
  for (const status of AUTOBOOK_JOB_STATUSES) {
    assert.ok(STATUS_LABEL[status], `${status} 의 라벨이 없다`);
  }
});

// --- Outbox -----------------------------------------------------------------

function makeJob() {
  return {
    id: "job-n",
    userId: "user-1",
    condition: { departure: "동탄", arrival: "울산(통도사)", date: "2026-10-10", passengers: 1, seatClass: "any", timeFrom: null, timeTo: null },
    hold: { candidateId: "c1", trainNumber: "T101", departAt: "08:05", reservationRef: "SIM-ABCD1234", paymentDueAt: "2026-10-01T10:00:00.000Z", officialPaymentUrl: null, confirmedBy: "createResponse", confirmedAt: "2026-10-01T09:40:00.000Z" },
    simulation: true,
  };
}

test("같은 사건의 알림은 한 번만 큐에 들어간다", async () => {
  resetMemoryAutobookStore();
  const store = createMemoryAutobookStore();
  const job = makeJob();

  const first = await store.enqueueNotification(buildNotification({ job, kind: "SEAT_HELD", id: "n1" }));
  const second = await store.enqueueNotification(buildNotification({ job, kind: "SEAT_HELD", id: "n2" }));

  assert.ok(first);
  assert.equal(second, null, "같은 사건의 알림이 두 번 들어갔다");
  assert.equal((await store.listNotifications("job-n")).length, 1);
});

test("멱등키는 예약 식별자까지 포함한다", () => {
  const job = makeJob();
  const other = { ...job, hold: { ...job.hold, reservationRef: "SIM-ZZZZ9999" } };
  assert.notEqual(notificationIdempotencyKey(job, "SEAT_HELD"), notificationIdempotencyKey(other, "SEAT_HELD"));
});

test("Outbox 는 보낸 뒤에만 sent 로 표시한다", async () => {
  resetMemoryAutobookStore();
  const store = createMemoryAutobookStore();
  const channel = createInMemoryChannel();
  await store.enqueueNotification(buildNotification({ job: makeJob(), kind: "SEAT_HELD", id: "n1" }));

  const result = await flushOutboxOnce({ store, channel, workerId: "w1", fencingToken: 1 });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(channel.sent.length, 1);
  assert.ok((await store.listNotifications("job-n"))[0].sentAt);
});

test("전송이 실패하면 다시 시도할 수 있게 남는다", async () => {
  resetMemoryAutobookStore();
  const store = createMemoryAutobookStore();
  const failing = { name: "failing", async send() { throw new Error("네트워크 오류"); } };
  await store.enqueueNotification(buildNotification({ job: makeJob(), kind: "SEAT_HELD", id: "n1" }));

  const result = await flushOutboxOnce({ store, channel: failing, workerId: "w1", fencingToken: 1 });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  const [notification] = await store.listNotifications("job-n");
  assert.equal(notification.sentAt, null);
  assert.equal(notification.failedAttempts, 1);
  assert.equal(notification.claimedBy, null, "다시 집을 수 있어야 한다");
});

test("알림 payload 에 자격증명·세션·예약번호 원문이 없다", () => {
  const notification = buildNotification({ job: makeJob(), kind: "SEAT_HELD", id: "n1" });
  const dumped = JSON.stringify(notification.payload);
  for (const word of ["password", "cookie", "token", "session", "SIM-ABCD1234"]) {
    assert.ok(!dumped.includes(word), `알림에 ${word} 가 들어 있다`);
  }
});

// --- 계정 연결 --------------------------------------------------------------

test("실제 계정 비밀번호를 받는 통로가 없다", async () => {
  const store = createMemoryAccountLinkStore();
  // 어떤 방식으로도 연결을 시작할 수 없다.
  for (const method of ["official_oauth", "official_api_credential", "short_lived_session"]) {
    await assert.rejects(() => store.beginLink({ userId: "u1", method }), /ACCOUNT_LINK_REQUIRED|확인하지 못했/);
  }
  const status = await store.getStatus("u1");
  assert.equal(status.kind, "NOT_LINKED");
});

test("계정 연결 안내가 무엇이 없어서 못 하는지 말해 준다", () => {
  const availability = accountLinkAvailability();
  assert.equal(availability.anyAvailable, false);
  assert.match(availability.summary, /비밀번호를 입력받지도, 저장하지도 않습니다/);
  for (const entry of availability.methods) {
    assert.equal(entry.available, false);
    assert.ok(entry.blockedReason.length > 0);
  }
});

test("연결 방식 목록에 비밀번호 방식이 없다", () => {
  assert.deepEqual(Object.keys(METHOD_AVAILABILITY).sort(), [
    "official_api_credential",
    "official_oauth",
    "short_lived_session",
  ]);
});
