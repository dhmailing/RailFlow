// 열차 식별.
//
// 지침 §7: "열차번호·날짜·출발시각·출발역·도착역을 함께 비교해 정확한
// 열차를 찾는다." 하나라도 확실하지 않으면 클릭하지 않는다.
//
// 이 모듈은 DOM을 모른다. Provider가 화면에서 읽어 온 "행(row) 요약"만 받아
// 판정한다. 그래서 브라우저 없이 그대로 테스트할 수 있다.

/**
 * @typedef {object} ObservedRow
 * @property {string} trainNumber   화면에서 읽은 열차번호
 * @property {string} departAt      화면에서 읽은 출발시각 (HH:MM)
 * @property {string} arriveAt      화면에서 읽은 도착시각 (HH:MM)
 * @property {string} departure     화면에서 읽은 출발역
 * @property {string} arrival       화면에서 읽은 도착역
 * @property {number} index         화면상의 행 번호(0부터)
 */

/** 열차번호 비교용 정규화: 공백·하이픈 제거, 대문자화. "KTX 101" == "ktx-101" */
export function normalizeTrainNumber(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[\s\-_]/g, "");
}

/** 시각 정규화: "05:12", "5:12", "0512", "05시 12분" -> "05:12" */
export function normalizeTime(value) {
  const text = String(value ?? "").trim();
  const hhmm = text.match(/(\d{1,2})\s*[:시]\s*(\d{2})/);
  if (hhmm) return `${hhmm[1].padStart(2, "0")}:${hhmm[2]}`;
  const digits = text.match(/^(\d{2})(\d{2})$/);
  if (digits) return `${digits[1]}:${digits[2]}`;
  return "";
}

/**
 * 역 이름 정규화. 괄호 안 부기역명은 보존한다 -- "울산(통도사)"과 "울산"을
 * 같은 것으로 취급하면 안 되는 구간이 있을 수 있기 때문에, 괄호를 지우는
 * 대신 공백만 정리한다.
 */
export function normalizeStation(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

/**
 * 역 이름이 일치하는지. 완전 일치를 기본으로 하되, 화면이 부기역명을
 * 생략한 경우("울산" vs "울산(통도사)")만 한쪽이 다른 쪽의 괄호 앞부분과
 * 같을 때 일치로 본다. 그 외의 부분 일치는 인정하지 않는다.
 */
export function stationMatches(expected, observed) {
  const a = normalizeStation(expected);
  const b = normalizeStation(observed);
  if (!a || !b) return false;
  if (a === b) return true;
  const baseOf = (s) => s.replace(/\(.*\)$/, "");
  return baseOf(a) === b || a === baseOf(b);
}

/**
 * 후보(사용자가 RailFlow에서 고른 열차) 하나와 화면에서 읽은 행들을 맞춰본다.
 *
 * 반환:
 *  - { outcome: "MATCHED", row }            정확히 하나만 모든 항목이 일치
 *  - { outcome: "NOT_FOUND" }               일치하는 행이 없음
 *  - { outcome: "AMBIGUOUS", rows }         모든 항목이 일치하는 행이 둘 이상
 *  - { outcome: "PARTIAL", row, mismatches } 열차번호는 같은데 다른 항목이 다름
 *
 * MATCHED 가 아니면 절대 클릭하지 않는다. PARTIAL/AMBIGUOUS 는 화면이
 * 바뀌었거나 잘못된 열차를 볼 위험이 있다는 뜻이므로 호출자가
 * TRAIN_IDENTIFICATION_UNCERTAIN 으로 중단한다.
 */
export function matchCandidateRow(candidate, rows) {
  const wantNumber = normalizeTrainNumber(candidate.trainNumber);
  const wantDepart = normalizeTime(candidate.departAt);
  const wantArrive = normalizeTime(candidate.arriveAt);

  const numberMatches = rows.filter((row) => normalizeTrainNumber(row.trainNumber) === wantNumber);
  if (numberMatches.length === 0) return { outcome: "NOT_FOUND" };

  const fieldChecks = (row) => {
    const mismatches = [];
    if (wantDepart && normalizeTime(row.departAt) !== wantDepart) mismatches.push("departAt");
    // 도착시각은 화면에 없을 수도 있다. 값이 있을 때만 비교한다.
    if (wantArrive && normalizeTime(row.arriveAt) && normalizeTime(row.arriveAt) !== wantArrive) {
      mismatches.push("arriveAt");
    }
    if (!stationMatches(candidate.departure, row.departure)) mismatches.push("departure");
    if (!stationMatches(candidate.arrival, row.arrival)) mismatches.push("arrival");
    return mismatches;
  };

  const exact = numberMatches.filter((row) => fieldChecks(row).length === 0);
  if (exact.length === 1) return { outcome: "MATCHED", row: exact[0] };
  if (exact.length > 1) return { outcome: "AMBIGUOUS", rows: exact };

  const first = numberMatches[0];
  return { outcome: "PARTIAL", row: first, mismatches: fieldChecks(first) };
}

/**
 * 사용자가 허용한 좌석등급과 화면에서 읽은 좌석 상태가 맞는지.
 * @param {"standard_only"|"first_only"|"any"} preference
 * @param {string} seatStatus SeatStatus 값
 */
export function seatStatusSatisfies(preference, seatStatus) {
  if (seatStatus === "AVAILABLE_ANY") return true;
  if (preference === "any") {
    return seatStatus === "AVAILABLE_STANDARD" || seatStatus === "AVAILABLE_FIRST";
  }
  if (preference === "standard_only") return seatStatus === "AVAILABLE_STANDARD";
  if (preference === "first_only") return seatStatus === "AVAILABLE_FIRST";
  return false;
}

/**
 * 중복 예약 방지용 작업 키(지침 §10: 동일 사용자·날짜·구간·인원에 활성
 * 작업 하나만). 후보 열차는 키에 넣지 않는다 -- 같은 구간·날짜를 여러
 * 열차로 동시에 노리는 것이 곧 중복 예약 위험이기 때문이다.
 */
export function activeJobKey({ userId, date, departure, arrival, passengers }) {
  return [
    String(userId ?? "local"),
    String(date ?? ""),
    normalizeStation(departure),
    normalizeStation(arrival),
    String(passengers ?? ""),
  ].join("|");
}
