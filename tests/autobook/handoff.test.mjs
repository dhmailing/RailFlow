// 검색 결과 → [자동예약] → 등록 화면 사이에서 **값이 실제로 옮겨지는지**.
//
// 문자열이 화면에 있는지가 아니라, 함수가 어떤 값을 내놓는지를 본다.
// 여기서 지키려는 것은 두 가지다.
//  1. 후보의 출처(실제 시간표 / 데모)가 어느 단계에서도 사라지지 않는다.
//  2. 사용자가 고른 좌석등급이 조용히 다른 값으로 바뀌지 않는다.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";

const { loadTs } = loader;
const {
  DEFAULT_SEAT_CLASS,
  SEAT_CLASS_LABEL,
  buildAutobookHandoff,
  gateHandoffForRealRegistration,
  parseSeatClass,
  restoreCandidates,
  simulatedTrains,
} = loadTs("lib/autobook/handoff.ts");

function candidate(overrides = {}) {
  return {
    id: "t-1",
    number: "KTX 101",
    trainType: "KTX",
    depart: "08:00",
    arrive: "10:30",
    fare: "59,800원",
    departure: "서울",
    arrival: "부산",
    date: "2026-10-20",
    source: "tago",
    ...overrides,
  };
}

// --- 출처 보존 -------------------------------------------------------------

test("기본 좌석등급은 일반실만이다", () => {
  assert.equal(DEFAULT_SEAT_CLASS, "standard_only");
});

test("데모 후보의 출처가 등록 화면까지 그대로 간다", () => {
  const handoff = buildAutobookHandoff({
    candidates: [candidate({ id: "d-1", source: "demo" }), candidate({ id: "t-2", source: "tago" })],
    passengers: "2",
    seatClass: "standard_only",
  });

  assert.deepEqual(
    handoff.trains.map((train) => train.source),
    ["demo", "tago"],
    "출처가 바뀌거나 사라졌다",
  );
  assert.equal(simulatedTrains(handoff).length, 1);
  assert.equal(handoff.passengers, "2");
  assert.equal(handoff.departure, "서울");
  assert.equal(handoff.arrival, "부산");
  assert.equal(handoff.date, "2026-10-20");
});

test("후보가 없으면 넘길 조건도 없다", () => {
  assert.equal(buildAutobookHandoff({ candidates: [], passengers: "1", seatClass: "standard_only" }), null);
  assert.equal(simulatedTrains(null).length, 0);
});

test("저장된 후보의 출처가 복원된다", () => {
  const raw = [candidate({ id: "a", source: "demo" }), candidate({ id: "b", source: "tago" })];
  const restored = restoreCandidates(JSON.parse(JSON.stringify(raw)));

  assert.equal(restored.droppedUnknownSource, 0);
  assert.equal(restored.droppedInvalid, 0);
  assert.deepEqual(
    restored.candidates.map((row) => [row.id, row.source]),
    [
      ["a", "demo"],
      ["b", "tago"],
    ],
  );
});

test("출처가 없는 옛 저장 데이터를 실제 후보로 추정하지 않는다", () => {
  const legacy = candidate();
  delete legacy.source;

  const restored = restoreCandidates([legacy]);
  assert.equal(restored.candidates.length, 0, "출처 없는 항목이 후보로 되살아났다");
  assert.equal(restored.droppedUnknownSource, 1, "재선택을 안내할 근거가 없다");
});

test("출처가 엉뚱한 값이면 버린다", () => {
  for (const bad of ["korail", "", null, 0, true, { source: "demo" }]) {
    const restored = restoreCandidates([candidate({ source: bad })]);
    assert.equal(restored.candidates.length, 0, `source=${JSON.stringify(bad)} 를 받아들였다`);
    assert.equal(restored.droppedUnknownSource, 1);
  }
});

test("모델이 아예 다른 옛 항목과 출처 없는 항목을 따로 센다", () => {
  const legacy = candidate();
  delete legacy.source;
  const restored = restoreCandidates([{ reservationNumber: "X" }, legacy, candidate({ id: "ok" })]);

  assert.equal(restored.droppedInvalid, 1);
  assert.equal(restored.droppedUnknownSource, 1);
  assert.deepEqual(restored.candidates.map((row) => row.id), ["ok"]);
});

test("저장값이 배열이 아니면 빈 결과를 낸다", () => {
  for (const bad of [null, undefined, "[]", 3, { a: 1 }]) {
    const restored = restoreCandidates(bad);
    assert.equal(restored.candidates.length, 0);
  }
});

// --- 실제 등록 경계 --------------------------------------------------------

test("데모 후보는 실제 등록 경계를 통과하지 못한다", () => {
  const handoff = buildAutobookHandoff({
    candidates: [candidate({ source: "demo" })],
    passengers: "1",
    seatClass: "standard_only",
  });
  const gate = gateHandoffForRealRegistration(handoff);

  assert.equal(gate.ok, false);
  assert.match(gate.reason, /데모/);
});

test("데모가 한 편만 섞여도 전체가 막힌다", () => {
  const handoff = buildAutobookHandoff({
    candidates: [candidate({ id: "a" }), candidate({ id: "b", source: "demo" }), candidate({ id: "c" })],
    passengers: "1",
    seatClass: "standard_only",
  });
  assert.equal(gateHandoffForRealRegistration(handoff).ok, false);
});

test("실제 시간표 후보만 있으면 경계를 통과한다", () => {
  const handoff = buildAutobookHandoff({
    candidates: [candidate()],
    passengers: "1",
    seatClass: "standard_only",
  });
  assert.equal(gateHandoffForRealRegistration(handoff).ok, true);
});

test("후보가 없으면 경계를 통과하지 못한다", () => {
  assert.equal(gateHandoffForRealRegistration(null).ok, false);
  assert.equal(gateHandoffForRealRegistration({ trains: [] }).ok, false);
});

// --- 좌석등급 --------------------------------------------------------------

test("고른 좌석등급이 그대로 전달된다", () => {
  for (const seatClass of ["standard_only", "any", "first_only"]) {
    const handoff = buildAutobookHandoff({ candidates: [candidate()], passengers: "1", seatClass });
    assert.equal(handoff.seatClass, seatClass, "좌석등급이 바뀌었다");
  }
});

test("일반실만 선택이 특실 허용으로 올라가지 않는다", () => {
  const handoff = buildAutobookHandoff({
    candidates: [candidate()],
    passengers: "1",
    seatClass: "standard_only",
  });
  assert.equal(handoff.seatClass, "standard_only");
  assert.notEqual(handoff.seatClass, "any");
  assert.notEqual(handoff.seatClass, "first_only");
});

test("저장된 좌석등급이 깨졌으면 기본값(일반실만)으로 돌아간다", () => {
  for (const bad of ["standard_preferred", "special", "", null, undefined, 1, {}]) {
    assert.equal(parseSeatClass(bad), null, `${JSON.stringify(bad)} 를 받아들였다`);
  }
  // 화면은 parseSeatClass() ?? DEFAULT_SEAT_CLASS 로 복원한다.
  assert.equal(parseSeatClass("nonsense") ?? DEFAULT_SEAT_CLASS, "standard_only");
});

test("저장된 좌석등급이 올바르면 그대로 복원된다", () => {
  for (const good of ["standard_only", "any", "first_only"]) {
    assert.equal(parseSeatClass(good), good);
  }
});

test("좌석등급 라벨이 세 값 모두에 있고 '일반실만'이 특실을 뜻하지 않는다", () => {
  assert.equal(SEAT_CLASS_LABEL.standard_only, "일반실만");
  assert.ok(!SEAT_CLASS_LABEL.standard_only.includes("특실"));
  assert.ok(SEAT_CLASS_LABEL.any.includes("특실"));
  assert.ok(SEAT_CLASS_LABEL.first_only.includes("특실"));
});
