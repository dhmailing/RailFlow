// 읽기 전용 단계의 안전장치 테스트.
//
// 가짜 Provider를 쓰는 테스트다. 실제 사이트 연동 검증이 아니다 --
// 그건 사용자의 PC에서 실제 화면으로 해야 한다.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.RAILFLOW_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "railflow-ro-"));
process.env.RAILFLOW_AGENT_QUIET = "1";

const { ReadOnlyProbe } = await import("../../agent/src/readonly-probe.mjs");
const { createLiveBookingProvider } = await import("../../agent/src/providers/live-booking-provider.mjs");
const { assertProviderContract } = await import("../../agent/src/providers/provider-contract.mjs");
const { ProviderHalt } = await import("../../agent/src/providers/provider-halt.mjs");
const { JobState } = await import("../../agent/src/status.mjs");
const { closeLog } = await import("../../agent/src/log.mjs");

test.after(async () => { await closeLog(); });

const PROFILE = {
  schemaVersion: 2,
  host: "example.test",
  operator: "테스트사업자",
  allowedHosts: ["example.test"],
  pages: {
    search: { url: "https://example.test/search", kind: "searchResult" },
    reservationList: { url: "https://example.test/reservations", kind: "reservationList" },
  },
  row: { containerTag: "tr", containerRole: "", cellCount: 5, fieldPaths: {} },
  form: { departure: "출발", arrival: "도착", date: "날짜", passengers: "", submit: "조회" },
  detectors: { soldOut: ["가짜매진"], availableStandard: ["가짜가능"] },
  guardMarkers: { paymentScreen: [], reservationScreen: [] },
  fingerprint: "deadbeef",
};

const fakePlaywright = { chromium: { launchPersistentContext: async () => { throw new Error("이 테스트는 브라우저를 열지 않는다"); } } };
const fakeLock = { assertFencingToken: () => true };

test("읽기 전용 Provider는 예약 동작을 수행할 수 없다", async () => {
  const provider = createLiveBookingProvider({
    profile: PROFILE,
    playwright: fakePlaywright,
    lock: fakeLock,
    allowReservation: false,
  });
  assert.equal(provider.reservationEnabled, false);
  await assert.rejects(() => provider.requestReservation({ rowIndex: 0 }), (error) => {
    assert.ok(error instanceof ProviderHalt);
    assert.equal(error.code, "RESERVATION_NOT_ARMED");
    return true;
  });
});

test("예약 가능으로 만든 Provider도 이번 단계에서는 예약까지 가지 않는다", async () => {
  const provider = createLiveBookingProvider({
    profile: PROFILE,
    playwright: fakePlaywright,
    lock: fakeLock,
    allowReservation: true,
  });
  await assert.rejects(() => provider.requestReservation({ rowIndex: 0 }), /RESERVATION_NOT_ARMED|별도 승인/);
});

test("Provider 이름에 대상 사업자와 호스트가 들어간다", () => {
  const provider = createLiveBookingProvider({ profile: PROFILE, playwright: fakePlaywright, lock: fakeLock });
  assert.equal(provider.name, "live:테스트사업자@example.test");
  assert.equal(provider.simulation, false);
  assert.equal(assertProviderContract(provider), true);
});

test("사업자 이름이 비어 있어도 Mock 과 헷갈리지 않는 이름이 된다", () => {
  const provider = createLiveBookingProvider({
    profile: { ...PROFILE, operator: "" },
    playwright: fakePlaywright,
    lock: fakeLock,
  });
  assert.ok(provider.name.startsWith("live:"));
  assert.ok(provider.name.includes("example.test"));
});

// --- ReadOnlyProbe ---------------------------------------------------------

function fakeProvider(script = {}) {
  const calls = [];
  return {
    calls,
    name: "live:테스트@example.test",
    operator: "테스트",
    host: "example.test",
    simulation: false,
    reservationEnabled: false,
    async openBookingSite() { calls.push("open"); return {}; },
    async waitForManualLogin({ isConfirmedByUser }) {
      calls.push("login");
      while (!isConfirmedByUser()) await new Promise((r) => setTimeout(r, 10));
      return { loggedIn: true };
    },
    async searchTrain() {
      calls.push("search");
      if (script.searchTrain) return script.searchTrain();
      return { rowIndex: 0 };
    },
    async readSeatAvailability(args) {
      calls.push("read");
      return script.readSeatAvailability
        ? script.readSeatAvailability(args, calls)
        : {
            status: "SOLD_OUT",
            standard: { status: "SOLD_OUT", screenText: "가짜매진" },
            first: null,
            screenText: "가짜매진",
            trainNumber: "T305",
            departAt: "08:05",
            arriveAt: "10:31",
            readAt: new Date().toISOString(),
            sourceHost: "example.test",
          };
    },
    async requestReservation() { calls.push("reserve"); throw new Error("호출되면 안 된다"); },
    async verifyReservation() { calls.push("verify"); return { confirmed: false }; },
    async readPaymentDeadline() { calls.push("deadline"); return { found: false }; },
    async stop() { calls.push("stop"); },
  };
}

const CONDITION = {
  departure: "동탄",
  arrival: "울산(통도사)",
  date: "2026-10-01",
  passengers: 1,
  seatPreference: "any",
  candidate: { id: "probe-1", trainNumber: "T305", departAt: "08:05", arriveAt: "10:31" },
};

async function runUntil(probe, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = probe.snapshot();
    if (predicate(snap)) return snap;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`시간 안에 조건을 만족하지 못했습니다. 현재: ${probe.snapshot().state}/${probe.snapshot().phase}`);
}

test("예약이 가능한 Provider로는 읽기 전용 실증을 시작조차 못한다", () => {
  assert.throws(
    () => new ReadOnlyProbe({ provider: { ...fakeProvider(), reservationEnabled: true } }),
    /예약이 가능한 Provider/,
  );
});

test("단건 조회 -> 재조회 -> 고정 주기 순서로 진행한다", async () => {
  const provider = fakeProvider();
  const probe = new ReadOnlyProbe({ provider });
  await probe.start(CONDITION);
  probe.confirmLogin();

  // 1·2회차를 읽고 POLLING 단계로 넘어간다.
  const snap = await runUntil(probe, (s) => s.phase === "POLLING");
  assert.equal(snap.readings.length, 2);
  assert.deepEqual(snap.readings.map((r) => r.label), ["1회차", "2회차"]);
  assert.equal(snap.pollingIntervalSeconds >= 30, true);
  // 예약 관련 호출은 한 번도 없다.
  assert.ok(!provider.calls.includes("reserve"));
  assert.ok(!provider.calls.includes("deadline"));

  probe.requestStop();
  await probe.waitUntilIdle();
  assert.equal(probe.snapshot().state, JobState.STOPPED_BY_USER);
});

test("읽은 좌석 문구를 원문 그대로 보존한다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({
      status: "AVAILABLE_STANDARD",
      standard: { status: "AVAILABLE_STANDARD", screenText: "가짜 일반실 표시" },
      first: { status: "SOLD_OUT", screenText: "가짜 특실 표시" },
      screenText: "가짜 일반실 표시 / 가짜 특실 표시",
      trainNumber: "T305",
      departAt: "08:05",
      arriveAt: "10:31",
      readAt: new Date().toISOString(),
      sourceHost: "example.test",
    }),
  });
  const probe = new ReadOnlyProbe({ provider });
  await probe.start(CONDITION);
  probe.confirmLogin();
  const snap = await runUntil(probe, (s) => s.readings.length >= 1);
  const reading = snap.readings[0];
  assert.equal(reading.standardScreenText, "가짜 일반실 표시");
  assert.equal(reading.firstScreenText, "가짜 특실 표시");
  assert.equal(reading.sourceHost, "example.test");
  assert.equal(reading.departure, "동탄");
  assert.equal(reading.arrival, "울산(통도사)");
  assert.ok(reading.readAt);
  probe.requestStop();
  await probe.waitUntilIdle();
});

test("두 번 모두 해석하지 못하면 매진이 아니라 중단이다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({
      status: "UNKNOWN",
      standard: { status: "UNKNOWN", screenText: "" },
      first: null,
      screenText: "",
      trainNumber: "T305",
      departAt: "08:05",
      readAt: new Date().toISOString(),
    }),
  });
  const probe = new ReadOnlyProbe({ provider });
  await probe.start(CONDITION);
  probe.confirmLogin();
  const snap = await runUntil(probe, (s) => s.state === JobState.PROVIDER_CHANGED);
  assert.match(snap.message, /매진으로 처리하지 않습니다/);
  await probe.waitUntilIdle();
});

test("두 조회의 열차가 다르면 일관성 실패로 중단한다", async () => {
  let n = 0;
  const provider = fakeProvider({
    readSeatAvailability: () => {
      n += 1;
      return {
        status: "SOLD_OUT",
        standard: { status: "SOLD_OUT", screenText: "가짜매진" },
        first: null,
        screenText: "가짜매진",
        trainNumber: n === 1 ? "T305" : "T999",
        departAt: "08:05",
        readAt: new Date().toISOString(),
      };
    },
  });
  const probe = new ReadOnlyProbe({ provider });
  await probe.start(CONDITION);
  probe.confirmLogin();
  const snap = await runUntil(probe, (s) => s.state === JobState.PROVIDER_CHANGED);
  assert.match(snap.message, /열차번호가 다릅니다/);
  await probe.waitUntilIdle();
});

test("로그인 만료는 자동 재로그인 없이 중단한다", async () => {
  const provider = fakeProvider({
    readSeatAvailability: () => ({
      status: "AUTH_REQUIRED",
      standard: { status: "AUTH_REQUIRED", screenText: "가짜 로그인 안내" },
      first: null,
      screenText: "가짜 로그인 안내",
      trainNumber: "T305",
      departAt: "08:05",
      readAt: new Date().toISOString(),
    }),
  });
  const probe = new ReadOnlyProbe({ provider });
  await probe.start(CONDITION);
  probe.confirmLogin();
  const snap = await runUntil(probe, (s) => s.state === JobState.AUTH_REQUIRED);
  assert.equal(snap.haltReason, "LOGIN_EXPIRED");
  await probe.waitUntilIdle();
});

test("화면 구조가 바뀌면 클릭 없이 중단한다", async () => {
  const provider = fakeProvider({
    searchTrain: () => {
      throw new ProviderHalt("PROFILE_FINGERPRINT_MISMATCH", "화면 구조가 프로필과 다릅니다.");
    },
  });
  const probe = new ReadOnlyProbe({ provider });
  await probe.start(CONDITION);
  probe.confirmLogin();
  const snap = await runUntil(probe, (s) => s.state === JobState.PROVIDER_CHANGED);
  assert.equal(snap.haltReason, "PROFILE_FINGERPRINT_MISMATCH");
  await probe.waitUntilIdle();
});

test("스냅샷에 예약 가능 여부가 false 로 드러난다", async () => {
  const probe = new ReadOnlyProbe({ provider: fakeProvider() });
  const snap = probe.snapshot();
  assert.equal(snap.mode, "LIVE_READ_ONLY");
  assert.equal(snap.reservationEnabled, false);
  assert.equal(snap.provider.simulation, false);
});

test("조회 주기는 하한 아래로 내려가지 않는다", () => {
  const probe = new ReadOnlyProbe({ provider: fakeProvider(), pollingIntervalSeconds: 1 });
  assert.ok(probe.snapshot().pollingIntervalSeconds >= 30);
});

test("중단은 주기가 끝나기를 기다리지 않는다", async () => {
  const provider = fakeProvider();
  const probe = new ReadOnlyProbe({ provider, pollingIntervalSeconds: 3600 });
  await probe.start(CONDITION);
  probe.confirmLogin();
  await runUntil(probe, (s) => s.phase === "POLLING");
  const startedAt = Date.now();
  probe.requestStop();
  await probe.waitUntilIdle();
  assert.ok(Date.now() - startedAt < 3000, "중단이 한 주기만큼 늦게 먹혔다");
  assert.equal(probe.snapshot().state, JobState.STOPPED_BY_USER);
});
