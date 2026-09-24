import assert from "node:assert/strict";
import test from "node:test";

import {
  activeJobKey,
  matchCandidateRow,
  normalizeTime,
  normalizeTrainNumber,
  seatStatusSatisfies,
  stationMatches,
} from "../../agent/src/match.mjs";

const candidate = {
  trainNumber: "SRT 305",
  departAt: "08:05",
  arriveAt: "10:31",
  departure: "동탄",
  arrival: "울산(통도사)",
};

const row = (over = {}) => ({
  index: 0,
  trainNumber: "SRT 305",
  departAt: "08:05",
  arriveAt: "10:31",
  departure: "동탄",
  arrival: "울산(통도사)",
  ...over,
});

test("열차번호·시각 표기 차이를 흡수한다", () => {
  assert.equal(normalizeTrainNumber("srt-305"), "SRT305");
  assert.equal(normalizeTime("8:05"), "08:05");
  assert.equal(normalizeTime("0805"), "08:05");
  assert.equal(normalizeTime("08시 05분"), "08:05");
  assert.equal(normalizeTime("없음"), "");
});

test("부기역명이 생략된 경우만 같은 역으로 본다", () => {
  assert.equal(stationMatches("울산(통도사)", "울산"), true);
  assert.equal(stationMatches("울산", "울산(통도사)"), true);
  // 부분 문자열이라고 아무거나 같게 보면 안 된다.
  assert.equal(stationMatches("동탄", "동대구"), false);
  assert.equal(stationMatches("서울", "서울역앞"), false);
});

test("모든 항목이 맞는 행 하나만 MATCHED 다", () => {
  const result = matchCandidateRow(candidate, [row()]);
  assert.equal(result.outcome, "MATCHED");
});

test("열차번호가 같아도 시각이 다르면 클릭하지 않는다(PARTIAL)", () => {
  const result = matchCandidateRow(candidate, [row({ departAt: "09:05" })]);
  assert.equal(result.outcome, "PARTIAL");
  assert.deepEqual(result.mismatches, ["departAt"]);
});

test("같은 조건의 행이 둘이면 AMBIGUOUS 로 멈춘다", () => {
  const result = matchCandidateRow(candidate, [row({ index: 0 }), row({ index: 1 })]);
  assert.equal(result.outcome, "AMBIGUOUS");
  assert.equal(result.rows.length, 2);
});

test("열차번호가 없으면 NOT_FOUND", () => {
  assert.equal(matchCandidateRow(candidate, [row({ trainNumber: "SRT 999" })]).outcome, "NOT_FOUND");
  assert.equal(matchCandidateRow(candidate, []).outcome, "NOT_FOUND");
});

test("도착시각이 화면에 없으면 그 항목은 비교하지 않는다", () => {
  const result = matchCandidateRow(candidate, [row({ arriveAt: "" })]);
  assert.equal(result.outcome, "MATCHED");
});

test("좌석등급 조건을 좁게 지키면 다른 등급은 통과하지 않는다", () => {
  assert.equal(seatStatusSatisfies("standard_only", "AVAILABLE_STANDARD"), true);
  assert.equal(seatStatusSatisfies("standard_only", "AVAILABLE_FIRST"), false);
  assert.equal(seatStatusSatisfies("first_only", "AVAILABLE_FIRST"), true);
  assert.equal(seatStatusSatisfies("any", "AVAILABLE_FIRST"), true);
  assert.equal(seatStatusSatisfies("any", "SOLD_OUT"), false);
  // 읽기 실패는 절대 예약 조건을 만족하지 않는다.
  assert.equal(seatStatusSatisfies("any", "UNKNOWN"), false);
  assert.equal(seatStatusSatisfies("any", "PROVIDER_CHANGED"), false);
});

test("중복 방지 키는 후보 열차가 아니라 구간·날짜·인원으로 만든다", () => {
  const base = { userId: "u1", date: "2026-10-01", departure: "동탄", arrival: "울산(통도사)", passengers: 1 };
  assert.equal(activeJobKey(base), activeJobKey({ ...base }));
  assert.notEqual(activeJobKey(base), activeJobKey({ ...base, passengers: 2 }));
  assert.notEqual(activeJobKey(base), activeJobKey({ ...base, date: "2026-10-02" }));
});
