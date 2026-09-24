import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.RAILFLOW_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "railflow-agent-home-"));
process.env.RAILFLOW_AGENT_QUIET = "1";

const { assertProviderContract, REQUIRED_PROVIDER_METHODS } = await import(
  "../../agent/src/providers/provider-contract.mjs"
);
const { emptyProfile, assertProfileUsable, classifyScreenText, ProfileError } = await import(
  "../../agent/src/profile.mjs"
);
const { SEAT_STATUSES, JOB_STATES } = await import("../../agent/src/status.mjs");

function validProvider(over = {}) {
  const provider = { name: "live:SR-SRT@example.test", simulation: false, ...over };
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (!(method in provider)) provider[method] = async () => {};
  }
  return provider;
}

test("실제 Provider는 이름으로 Mock과 구분된다", () => {
  assert.equal(assertProviderContract(validProvider()), true);
  assert.throws(() => assertProviderContract(validProvider({ name: "mock-browser" })), /live:/);
  assert.throws(() => assertProviderContract(validProvider({ simulation: true })), /simulation=false/);
});

test("차단 우회·결제 자동화 기능이 있으면 Provider 로드를 거부한다", () => {
  for (const forbidden of ["solveCaptcha", "bypassQueue", "rotateProxy", "exportCookies", "autoPay"]) {
    assert.throws(
      () => assertProviderContract(validProvider({ [forbidden]: () => {} })),
      /허용되지 않는 기능/,
      `${forbidden} 가 통과됐다`,
    );
  }
});

test("필수 메서드가 없으면 거부한다", () => {
  const provider = validProvider();
  delete provider.verifyReservation;
  assert.throws(() => assertProviderContract(provider), /verifyReservation/);
});

test("확인되지 않은 프로필로는 아무 것도 실행하지 않는다", () => {
  const profile = emptyProfile({ operator: "SR", host: "example.test" });
  assert.throws(() => assertProfileUsable(profile), ProfileError);
  assert.throws(() => assertProfileUsable(profile), /확인되지 않았습니다/);
});

test("어휘가 비어 있으면 거부한다", () => {
  const profile = emptyProfile({ operator: "SR", host: "example.test" });
  profile.verified = true;
  assert.throws(() => assertProfileUsable(profile), /비어 있습니다/);
});

function completeProfile() {
  const profile = emptyProfile({ operator: "SR", host: "example.test" });
  profile.verified = true;
  profile.vocabulary.soldOut = ["매진"];
  profile.vocabulary.availableStandard = ["일반실"];
  profile.vocabulary.availableFirst = ["특실"];
  profile.vocabulary.reserveControl = ["예약하기"];
  profile.vocabulary.reservationListLink = ["예약내역"];
  profile.formFields = {
    departure: "출발역",
    arrival: "도착역",
    date: "출발일",
    passengers: "인원",
    submit: "조회하기",
  };
  profile.urls.searchEntry = "https://example.test/search";
  profile.urls.reservationList = "https://example.test/reservations";
  return profile;
}

test("완성된 프로필은 통과한다", () => {
  assert.equal(assertProfileUsable(completeProfile()), true);
});

test("프로필의 주소가 대상 호스트 밖이면 거부한다", () => {
  const profile = completeProfile();
  profile.urls.reservationList = "https://other.invalid/reservations";
  assert.throws(() => assertProfileUsable(profile), /대상 호스트/);
});

test("화면 문구 분류는 프로필 문구가 화면에 포함될 때만 인정한다", () => {
  const profile = completeProfile();
  assert.deepEqual(classifyScreenText(profile, "SRT 305 08:05 매진"), { key: "soldOut", phrase: "매진" });
  assert.equal(classifyScreenText(profile, "SRT 305 08:05"), null);
  assert.equal(classifyScreenText(profile, ""), null);
});

test("Agent와 웹 UI의 상태 어휘가 서로 어긋나지 않는다", () => {
  // lib/live/agent-protocol.ts 는 TypeScript 라 여기서 실행할 수 없으므로
  // 원문에서 배열 리터럴을 읽어 비교한다.
  const source = fs.readFileSync(
    new URL("../../lib/live/agent-protocol.ts", import.meta.url),
    "utf8",
  );
  const listOf = (name) => {
    const block = source.split(`export const ${name} = [`)[1]?.split("] as const;")[0];
    assert.ok(block, `${name} 를 찾지 못했습니다`);
    return [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  };
  assert.deepEqual(listOf("SEAT_STATUSES"), [...SEAT_STATUSES]);
  assert.deepEqual(listOf("JOB_STATES"), [...JOB_STATES]);

  // 화면 라벨이 모든 상태에 대해 준비되어 있어야 한다.
  const labelBlock = source.split("JOB_STATE_LABEL: Record<LiveJobState, string> = {")[1].split("};")[0];
  for (const state of JOB_STATES) {
    assert.ok(labelBlock.includes(`${state}:`), `${state} 의 화면 라벨이 없다`);
  }
});
