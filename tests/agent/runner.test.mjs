// 감시 루프 동작 테스트.
//
// 여기서 쓰는 Provider는 브라우저를 열지 않는 가짜(fake)다. 화면을 흉내내는
// 것이 목적이 아니라, "실제 Provider가 이런 값을 돌려줬을 때 루프가 어떻게
// 행동하는가"를 고정하는 것이 목적이다. 이 테스트가 통과했다고 해서
// 실제 사이트 연동이 검증된 것은 아니다 -- 그건 사용자의 PC에서
// LIVE_READ_ONLY 로 직접 확인해야 한다.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.RAILFLOW_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "railflow-agent-home-"));
process.env.RAILFLOW_AGENT_QUIET = "1";

const { JobRunner } = await import("../../agent/src/runner.mjs");
const { AgentLock } = await import("../../agent/src/lock.mjs");
const { JobState, RunMode } = await import("../../agent/src/status.mjs");
const { ProviderHalt } = await import("../../agent/src/providers/sr-srt-live-provider.mjs");
const { closeLog } = await import("../../agent/src/log.mjs");

// 로그 파일 스트림이 열려 있으면 테스트 프로세스가 끝나지 않는다.
test.after(async () => { await closeLog(); });

const CONDITION = {
  departure: "동탄",
  arrival: "울산(통도사)",
  date: "2026-10-01",
  passengers: 1,
  seatPreference: "any",
  candidates: [
    { id: "c1", trainNumber: "SRT 305", departAt: "08:05", arriveAt: "10:31" },
    { id: "c2", trainNumber: "SRT 307", departAt: "09:05", arriveAt: "11:31" },
  ],
};

function makeLock() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "railflow-lock-")), "agent.lock");
  const lock = new AgentLock(file);
  lock.acquire();
  return lock;
}

/** 시나리오대로 값을 돌려주는 가짜 Provider. 호출 이력을 남긴다. */
function fakeProvider(script = {}) {
  const calls = [];
  return {
    calls,
    name: "live:SR-SRT@test.invalid",
    operator: "테스트",
    simulation: false,
    async openBookingSite() {
      calls.push("openBookingSite");
      return { url: "https://test.invalid/", host: "test.invalid" };
    },
    async waitForManualLogin({ isConfirmedByUser }) {
      calls.push("waitForManualLogin");
      while (!isConfirmedByUser()) await new Promise((r) => setTimeout(r, 10));
      return { loggedIn: true };
    },
    async searchTrain({ candidate }) {
      calls.push(`searchTrain:${candidate.trainNumber}`);
      if (script.searchTrain) return script.searchTrain(candidate);
      return { rowIndex: 0 };
    },
    async readSeatAvailability(args) {
      calls.push("readSeatAvailability");
      return script.readSeatAvailability
        ? script.readSeatAvailability(args, calls)
        : { status: "SOLD_OUT", screenText: "매진" };
    },
    async requestReservation(args) {
      calls.push("requestReservation");
      if (script.requestReservation) return script.requestReservation(args);
      return { clicked: true, clickedAt: new Date().toISOString() };
    },
    async verifyReservation(args) {
      calls.push("verifyReservation");
      return script.verifyReservation ? script.verifyReservation(args, calls) : { confirmed: false };
    },
    async readPaymentDeadline() {
      calls.push("readPaymentDeadline");
      return script.readPaymentDeadline
        ? script.readPaymentDeadline()
        : { found: false, iso: null, label: null, rawText: null };
    },
    async stop() {
      calls.push("stop");
    },
  };
}

async function runUntil(runner, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = runner.snapshot();
    if (snap.job && predicate(snap)) return snap;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`시간 안에 조건을 만족하지 못했습니다. 현재 상태: ${runner.snapshot().job?.state}`);
}

test("읽기 전용 모드는 좌석을 찾아도 예약 버튼을 누르지 않는다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({ status: "AVAILABLE_STANDARD", screenText: "일반실 예약가능" }),
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();

  const snap = await runUntil(runner, (s) => s.job.state === JobState.AWAITING_ARM_CONFIRMATION);
  assert.equal(snap.job.mode, RunMode.LIVE_READ_ONLY);
  assert.ok(!provider.calls.includes("requestReservation"), "읽기 전용인데 예약을 눌렀다");

  runner.requestStop();
  await runner.waitUntilIdle();
  assert.equal(runner.snapshot().job.state, JobState.STOPPED_BY_USER);
});

test("승인 후에만 예약하고, 예약내역에서 확인돼야 성공으로 본다", async () => {
  let verifyCount = 0;
  const provider = fakeProvider({
    readSeatAvailability: () => ({ status: "AVAILABLE_STANDARD", screenText: "일반실 예약가능" }),
    verifyReservation: () => {
      verifyCount += 1;
      // 1회차: 예약 전 기존 예약 확인 -> 없음. 2회차: 클릭 후 확인 -> 있음.
      if (verifyCount === 1) return { confirmed: false };
      return {
        confirmed: true,
        reservationNumber: "SRT99887766",
        evidence: { source: "reservationList", sawSuccessMarker: true, rowText: "예약완료" },
      };
    },
    readPaymentDeadline: () => ({
      found: true,
      iso: "2026-10-01T18:30",
      label: "결제기한",
      rawText: "결제기한 2026.10.01 18:30",
    }),
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();
  await runUntil(runner, (s) => s.job.state === JobState.AWAITING_ARM_CONFIRMATION);

  runner.confirmArm({
    date: CONDITION.date,
    departure: CONDITION.departure,
    arrival: CONDITION.arrival,
    passengers: "1",
    seatPreference: "any",
    trainNumbers: ["SRT 305", "SRT 307"],
  });

  const snap = await runUntil(runner, (s) => s.job.state === JobState.RESERVED_PAYMENT_REQUIRED);
  assert.equal(snap.job.reservation.confirmed, true);
  assert.equal(snap.job.reservation.paymentDeadline.iso, "2026-10-01T18:30");
  // 예약번호는 마스킹되어 나간다.
  assert.ok(snap.job.reservation.reservationNumber.endsWith("766"));
  assert.ok(!snap.job.reservation.reservationNumber.includes("SRT99887"));
  // 예약 클릭은 정확히 한 번.
  assert.equal(provider.calls.filter((c) => c === "requestReservation").length, 1);
  // 나머지 후보는 즉시 중단.
  const other = snap.job.candidates.find((c) => c.id === "c2");
  assert.equal(other.state, "STOPPED");
  await runner.waitUntilIdle();
});

test("승인 화면의 조건이 다르면 예약을 시작하지 않는다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({ status: "AVAILABLE_STANDARD", screenText: "일반실 예약가능" }),
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();
  await runUntil(runner, (s) => s.job.state === JobState.AWAITING_ARM_CONFIRMATION);

  assert.throws(
    () =>
      runner.confirmArm({
        date: "2026-12-25", // 화면이 보여준 것과 다른 날짜
        departure: CONDITION.departure,
        arrival: CONDITION.arrival,
        passengers: "1",
        seatPreference: "any",
        trainNumbers: ["SRT 305", "SRT 307"],
      }),
    /승인 화면의 조건이 실행 중인 작업과 다릅니다/,
  );
  assert.ok(!provider.calls.includes("requestReservation"));
  runner.requestStop();
  await runner.waitUntilIdle();
});

test("예약을 눌렀는데 예약내역에서 확인되지 않으면 재클릭하지 않고 사용자 확인을 요청한다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({ status: "AVAILABLE_STANDARD", screenText: "일반실 예약가능" }),
    verifyReservation: () => ({ confirmed: false, outcome: "NOT_FOUND" }),
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();
  await runUntil(runner, (s) => s.job.state === JobState.AWAITING_ARM_CONFIRMATION);
  runner.confirmArm({
    date: CONDITION.date,
    departure: CONDITION.departure,
    arrival: CONDITION.arrival,
    passengers: "1",
    seatPreference: "any",
    trainNumbers: ["SRT 305", "SRT 307"],
  });

  const snap = await runUntil(
    runner,
    (s) => s.job.state === JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED,
  );
  assert.equal(snap.job.haltReason, "RESERVATION_RESULT_UNCERTAIN");
  assert.equal(provider.calls.filter((c) => c === "requestReservation").length, 1);
  await runner.waitUntilIdle();
});

test("같은 조건의 기존 예약을 먼저 발견하면 예약하지 않고 중단한다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({ status: "AVAILABLE_STANDARD", screenText: "일반실 예약가능" }),
    verifyReservation: () => ({
      confirmed: true,
      reservationNumber: "OLD12345678",
      evidence: { source: "reservationList" },
    }),
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();
  await runUntil(runner, (s) => s.job.state === JobState.AWAITING_ARM_CONFIRMATION);
  runner.confirmArm({
    date: CONDITION.date,
    departure: CONDITION.departure,
    arrival: CONDITION.arrival,
    passengers: "1",
    seatPreference: "any",
    trainNumbers: ["SRT 305", "SRT 307"],
  });

  const snap = await runUntil(runner, (s) => s.job.state === JobState.RECONCILIATION_REQUIRED);
  assert.equal(snap.job.haltReason, "EXISTING_RESERVATION_FOUND");
  assert.ok(!provider.calls.includes("requestReservation"), "기존 예약이 있는데 또 예약했다");
  await runner.waitUntilIdle();
});

test("로그인 만료는 자동 재로그인 없이 중단한다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({ status: "AUTH_REQUIRED", screenText: "로그인이 필요합니다" }),
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();
  const snap = await runUntil(runner, (s) => s.job.state === JobState.AUTH_REQUIRED);
  assert.equal(snap.job.haltReason, "LOGIN_EXPIRED");
  await runner.waitUntilIdle();
});

test("화면 변경으로 열차를 식별하지 못하면 클릭 없이 중단한다", async () => {
  const provider = fakeProvider({
    searchTrain: () => {
      throw new ProviderHalt(
        "TRAIN_IDENTIFICATION_UNCERTAIN",
        "열차를 확실히 식별하지 못했습니다(PARTIAL).",
      );
    },
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();
  const snap = await runUntil(runner, (s) => s.job.state === JobState.PROVIDER_CHANGED);
  assert.equal(snap.job.haltReason, "TRAIN_IDENTIFICATION_UNCERTAIN");
  assert.ok(!provider.calls.includes("requestReservation"));
  await runner.waitUntilIdle();
});

test("좌석 상태를 읽지 못한 것을 매진으로 처리하지 않는다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({ status: "UNKNOWN", screenText: "" }),
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();
  const snap = await runUntil(runner, (s) => s.job.candidates[0].lastSeatStatus === "UNKNOWN");
  assert.match(snap.job.message, /매진으로 처리하지 않습니다/);
  runner.requestStop();
  await runner.waitUntilIdle();
});

test("예약 직전 재확인에서 조건을 만족하지 않으면 클릭하지 않는다", async () => {
  let reads = 0;
  const provider = fakeProvider({
    readSeatAvailability: () => {
      reads += 1;
      // 첫 확인은 예약 가능, 예약 직전 재확인에서는 매진.
      return reads === 1
        ? { status: "AVAILABLE_STANDARD", screenText: "일반실 예약가능" }
        : { status: "SOLD_OUT", screenText: "매진" };
    },
    verifyReservation: () => ({ confirmed: false }),
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();
  await runUntil(runner, (s) => s.job.state === JobState.AWAITING_ARM_CONFIRMATION);
  runner.confirmArm({
    date: CONDITION.date,
    departure: CONDITION.departure,
    arrival: CONDITION.arrival,
    passengers: "1",
    seatPreference: "any",
    trainNumbers: ["SRT 305", "SRT 307"],
  });
  // 예약 직전 재확인(두 번째 readSeatAvailability)이 일어날 때까지 기다린다.
  // 화면 문구는 다음 후보를 확인하면서 바로 바뀌므로 문구가 아니라
  // 실제 호출 이력으로 판정한다.
  await runUntil(
    runner,
    () => provider.calls.filter((call) => call === "readSeatAvailability").length >= 2,
  );
  assert.ok(!provider.calls.includes("requestReservation"), "재확인에서 매진인데 예약을 눌렀다");
  assert.equal(runner.snapshot().job.candidates[0].state, "WATCHING");
  runner.requestStop();
  await runner.waitUntilIdle();
});

test("상태 스냅샷에 비밀번호·쿠키가 새어나가지 않는다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({
      status: "SOLD_OUT",
      screenText: "매진 password=hunter2 cookie: SESSION=abc 010-1234-5678",
    }),
  });
  const runner = new JobRunner({ lock: makeLock(), provider });
  await runner.start(CONDITION);
  runner.confirmLogin();
  const snap = await runUntil(runner, (s) => s.job.candidates[0].lastScreenText != null);
  const dumped = JSON.stringify(snap);
  assert.ok(!dumped.includes("hunter2"));
  assert.ok(!dumped.includes("010-1234-5678"));
  runner.requestStop();
  await runner.waitUntilIdle();
});

test("실제 사이트 조회 주기는 하한 아래로 내려가지 않는다", () => {
  const runner = new JobRunner({
    config: { livePollingIntervalSeconds: 1 },
    lock: makeLock(),
    provider: fakeProvider(),
  });
  assert.ok(runner.snapshot().config.livePollingIntervalSeconds >= 30);
});
