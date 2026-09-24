// 프로필 서명·지문 테스트.
//
// 핵심 질문: 사용자가 JSON을 손으로 고쳐서 "검증됨"을 켤 수 있는가?
// 답은 아니오여야 한다.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.RAILFLOW_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "railflow-sign-"));
process.env.RAILFLOW_AGENT_QUIET = "1";

const { emptyProfile, finalizeProfile, checkProfile, saveProfile, loadProfile, isHostAllowed, classifyScreenText } =
  await import("../../agent/src/profile.mjs");
const { computeFingerprint, signProfile, verifySignature, canonicalize, VERIFIER_VERSION } = await import(
  "../../agent/src/profile-signing.mjs"
);

/** 검증을 통과할 만큼 채워진 프로필. 값은 전부 가짜이며 실제 사이트와 무관하다. */
function filledProfile() {
  const profile = emptyProfile({ host: "example.test", operator: "테스트사업자" });
  profile.capturedAt = new Date().toISOString();
  profile.allowedHosts = ["example.test", "static.example.test"];
  profile.pages.search = { url: "https://example.test/search", kind: "searchResult" };
  profile.pages.reservationList = { url: "https://example.test/reservations", kind: "reservationList" };
  profile.row = {
    containerTag: "tr",
    containerRole: "",
    cellCount: 5,
    fieldPaths: {
      trainNumber: { path: [0], cellIndex: 0, tag: "td", role: "", name: "" },
      departAt: { path: [1], cellIndex: 1, tag: "td", role: "", name: "" },
      arriveAt: { path: [2], cellIndex: 2, tag: "td", role: "", name: "" },
      standardSeat: { path: [3], cellIndex: 3, tag: "td", role: "", name: "" },
      firstSeat: { path: [4], cellIndex: 4, tag: "td", role: "", name: "" },
    },
  };
  profile.form = { departure: "출발", arrival: "도착", date: "날짜", passengers: "인원", submit: "조회" };
  profile.detectors.soldOut = ["가짜매진문구"];
  profile.detectors.availableStandard = ["가짜가능문구"];
  profile.fingerprint = computeFingerprint({ formLabels: ["a"], controlNames: ["b"], rowCellCount: 5, rowContainerTag: "tr" });
  return profile;
}

const PASSING_CHECKS = [
  { name: "열차 행을 다시 찾음", ok: true },
  { name: "일반실 상태 자리에서 문구를 읽음", ok: true },
];

test("검증 절차를 거치지 않은 프로필은 쓸 수 없다", () => {
  const result = checkProfile(filledProfile());
  assert.equal(result.ok, false);
  assert.match(result.problem, /검증되지 않은/);
});

test("검증에 실패한 항목이 있으면 서명하지 않는다", () => {
  assert.throws(
    () => finalizeProfile(filledProfile(), [{ name: "열차 행을 다시 찾음", ok: false }]),
    /자동 검증에 실패/,
  );
});

test("검증을 통과하면 서명이 붙고 사용 가능해진다", () => {
  const signed = finalizeProfile(filledProfile(), PASSING_CHECKS);
  assert.equal(typeof signed.verification.signature, "string");
  assert.equal(signed.verification.signature.length, 64);
  assert.equal(signed.verification.verifierVersion, VERIFIER_VERSION);
  assert.equal(checkProfile(signed).ok, true);
});

test("손으로 verified 를 켜는 방법이 없다 -- 내용을 고치면 서명이 깨진다", () => {
  const signed = finalizeProfile(filledProfile(), PASSING_CHECKS);

  // 사용자가 흔히 시도할 법한 편집들.
  const tampered = [
    { ...signed, host: "evil.test" },
    { ...signed, allowedHosts: [...signed.allowedHosts, "evil.test"] },
    { ...signed, pages: { ...signed.pages, search: { url: "https://evil.test/x", kind: "searchResult" } } },
    { ...signed, detectors: { ...signed.detectors, soldOut: ["다른문구"] } },
    { ...signed, verification: { ...signed.verification, verifiedAt: "2099-01-01T00:00:00.000Z" } },
  ];
  for (const profile of tampered) {
    const result = checkProfile(profile);
    assert.equal(result.ok, false, `변조를 잡지 못했다: ${JSON.stringify(profile).slice(0, 60)}`);
    assert.equal(result.code, "PROFILE_TAMPERED");
  }

  // 서명 자체를 지우거나 바꾸는 것도 통하지 않는다.
  assert.equal(checkProfile({ ...signed, verification: { ...signed.verification, signature: "0".repeat(64) } }).ok, false);
  assert.equal(checkProfile({ ...signed, verification: null }).ok, false);
});

test("빈 프로필에 서명만 흉내내도 통과하지 않는다", () => {
  const fake = emptyProfile({ host: "example.test" });
  fake.verification = { verifiedAt: new Date().toISOString(), verifierVersion: VERIFIER_VERSION, checks: [], signature: "a".repeat(64) };
  assert.equal(checkProfile(fake).ok, false);
});

test("검증 규칙 버전이 다르면 다시 만들게 한다", () => {
  const signed = finalizeProfile(filledProfile(), PASSING_CHECKS);
  const stale = { ...signed, verification: { ...signed.verification, verifierVersion: VERIFIER_VERSION - 1 } };
  const result = checkProfile(stale);
  assert.equal(result.ok, false);
    assert.equal(result.code, "PROFILE_VERIFICATION_STALE");
});

test("다른 PC의 키로 만든 서명은 통하지 않는다", () => {
  const signed = finalizeProfile(filledProfile(), PASSING_CHECKS);
  const otherKey = "f".repeat(64);
  assert.equal(verifySignature(signed, otherKey), false);
  // 그 키로 다시 서명하면 그 키로만 맞는다.
  const resigned = { ...signed, verification: { ...signed.verification } };
  resigned.verification.signature = signProfile(resigned, otherKey);
  assert.equal(verifySignature(resigned, otherKey), true);
  assert.equal(checkProfile(resigned).ok, false, "이 PC 키로는 통과하면 안 된다");
});

test("서명 대상은 키 순서에 좌우되지 않는다", () => {
  assert.equal(canonicalize({ a: 1, b: [2, { c: 3 }] }), canonicalize({ b: [2, { c: 3 }], a: 1 }));
});

test("화면 구조가 바뀌면 지문이 달라진다", () => {
  const base = { formLabels: ["출발", "도착"], controlNames: ["조회"], rowCellCount: 5, rowContainerTag: "tr" };
  const same = { ...base, formLabels: ["도착", "출발"] }; // 순서만 다름 -> 같아야 한다
  assert.equal(computeFingerprint(base), computeFingerprint(same));
  assert.notEqual(computeFingerprint(base), computeFingerprint({ ...base, rowCellCount: 6 }));
  assert.notEqual(computeFingerprint(base), computeFingerprint({ ...base, controlNames: ["조회", "예매"] }));
});

test("저장과 불러오기가 서명을 보존한다", () => {
  const signed = finalizeProfile(filledProfile(), PASSING_CHECKS);
  saveProfile(signed);
  const loaded = loadProfile("example.test");
  assert.equal(checkProfile(loaded).ok, true);
});

test("허용 호스트 밖은 거부한다", () => {
  const signed = finalizeProfile(filledProfile(), PASSING_CHECKS);
  assert.equal(isHostAllowed(signed, "example.test"), true);
  assert.equal(isHostAllowed(signed, "static.example.test"), true);
  assert.equal(isHostAllowed(signed, "evil.test"), false);
  // 하위 도메인이라고 자동으로 허용되지 않는다.
  assert.equal(isHostAllowed(signed, "login.example.test"), false);
});

test("상태 문구는 긴 것부터 맞춰 오판을 줄인다", () => {
  const profile = emptyProfile({ host: "example.test" });
  profile.detectors.soldOut = ["매진"];
  profile.detectors.waitlist = ["예약대기"];
  assert.equal(classifyScreenText(profile, "예약대기 가능").key, "waitlist");
  assert.equal(classifyScreenText(profile, "매진").key, "soldOut");
  assert.equal(classifyScreenText(profile, "좌석"), null);
});
