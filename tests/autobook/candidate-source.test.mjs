// 후보 출처 일관성 검사와, 두 등록 경로 사이의 좌석등급 대응.
//
// 값을 넣어 보고 결과를 본다. 문자열이 소스에 있는지는 보지 않는다.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";

const { loadTs } = loader;
const { checkSourceConsistency, parseCandidateSource, sourceForStationId, SOURCE_LABEL } = loadTs(
  "lib/rail/candidate-source.ts",
);
const { mapToWatchSeatClass } = loadTs("lib/autobook/handoff.ts");

// --- 역 ID 가 가리키는 출처 ------------------------------------------------

test("역 ID 형태로 출처를 읽는다", () => {
  assert.equal(sourceForStationId("demo-0"), "demo");
  assert.equal(sourceForStationId("demo-12"), "demo");
  assert.equal(sourceForStationId("NAT010000"), "tago");
  for (const bad of ["", "demo-", "demo-x", "nat010000", "NAT", "서울", "demo-1x"]) {
    assert.equal(sourceForStationId(bad), null, `${bad} 를 받아들였다`);
  }
});

test("출처 문자열을 좁게 받는다", () => {
  assert.equal(parseCandidateSource("demo"), "demo");
  assert.equal(parseCandidateSource("tago"), "tago");
  for (const bad of ["korail", "DEMO", "", null, undefined, 1, {}, ["demo"]]) {
    assert.equal(parseCandidateSource(bad), null, `${JSON.stringify(bad)} 를 받아들였다`);
  }
});

// --- 작업 하나의 출처 일관성 ----------------------------------------------

const demoJob = { departureId: "demo-0", arrivalId: "demo-1" };
const realJob = { departureId: "NAT010000", arrivalId: "NAT014445" };

test("데모 역 + 데모 후보는 통과한다", () => {
  const result = checkSourceConsistency({ ...demoJob, candidateSources: ["demo", "demo"] });
  assert.equal(result.ok, true);
  assert.equal(result.source, "demo");
});

test("실제 역 + 실제 후보는 통과한다", () => {
  const result = checkSourceConsistency({ ...realJob, candidateSources: ["tago"] });
  assert.equal(result.ok, true);
  assert.equal(result.source, "tago");
});

test("출처를 섞으면 거부한다", () => {
  const result = checkSourceConsistency({ ...demoJob, candidateSources: ["demo", "tago"] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /섞을 수 없습니다/);
});

test("역 ID 의 출처와 후보의 출처가 다르면 거부한다", () => {
  const a = checkSourceConsistency({ ...demoJob, candidateSources: ["tago"] });
  assert.equal(a.ok, false);
  const b = checkSourceConsistency({ ...realJob, candidateSources: ["demo"] });
  assert.equal(b.ok, false);
});

test("출처가 없거나 알 수 없으면 거부한다 — 기본값으로 메우지 않는다", () => {
  for (const bad of [undefined, null, "", "korail", 0]) {
    const result = checkSourceConsistency({ ...demoJob, candidateSources: [bad] });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} 를 받아들였다`);
  }
});

test("출발역과 도착역의 출처가 다르면 거부한다", () => {
  const result = checkSourceConsistency({
    departureId: "demo-0",
    arrivalId: "NAT014445",
    candidateSources: ["demo"],
  });
  assert.equal(result.ok, false);
});

test("역 ID 형태를 모르면 거부한다", () => {
  const result = checkSourceConsistency({
    departureId: "seoul",
    arrivalId: "busan",
    candidateSources: ["demo"],
  });
  assert.equal(result.ok, false);
});

test("후보가 없으면 거부한다", () => {
  assert.equal(checkSourceConsistency({ ...demoJob, candidateSources: [] }).ok, false);
});

test("출처 라벨이 데모를 가상으로 적는다", () => {
  assert.match(SOURCE_LABEL.demo, /가상/);
  assert.ok(!SOURCE_LABEL.tago.includes("가상"));
});

// --- 좌석등급 대응 --------------------------------------------------------

test("대응되는 좌석등급은 뜻이 같은 값으로 옮긴다", () => {
  const only = mapToWatchSeatClass("standard_only");
  assert.equal(only.ok, true);
  assert.equal(only.value, "standard_only");

  const any = mapToWatchSeatClass("any");
  assert.equal(any.ok, true);
  assert.equal(any.value, "any");
});

test("특실만은 조용히 대체되지 않고 막힌다", () => {
  const mapped = mapToWatchSeatClass("first_only");
  assert.equal(mapped.ok, false, "특실만이 다른 값으로 바뀌어 통과했다");
  assert.equal(mapped.value, undefined, "막혔는데 대체 값을 내놨다");
  assert.match(mapped.reason, /특실만/);
});

test("일반실만이 특실을 허용하는 값으로 넓어지지 않는다", () => {
  const mapped = mapToWatchSeatClass("standard_only");
  assert.equal(mapped.value, "standard_only");
  assert.notEqual(mapped.value, "any");
  assert.notEqual(mapped.value, "standard_preferred");
});
