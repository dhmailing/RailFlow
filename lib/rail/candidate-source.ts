// 후보 열차가 **어디서 온 값인지**를 한 곳에서 정의한다.
//
// 검색 결과(실제 시간표 / 데모) → 후보 선택 → 저장 → 두 등록 화면 → 등록
// 요청까지 같은 어휘를 쓴다. 화면마다 다른 이름으로 들고 있으면 한 단계에서
// 조용히 사라지고, 데모 열차가 실제 작업처럼 보인다.
//
// server-only 를 붙이지 않는다 — 클라이언트 컴포넌트와 API 라우트가 함께 쓴다.
//
// **중요한 한계.** 여기 있는 함수들은 **입력값의 일관성**만 본다. 클라이언트가
// 보낸 `"tago"` 라는 문자열은 그 열차가 실제로 운행한다는 증거가 아니다. 실제
// 열차의 진위는 승인된 연동으로 조회해 봐야 알 수 있고 그 경로는 아직 없다
// (`docs/V0.12-LIVE-SEAT-QUERY-GATE.md`). 이 모듈을 "진위 검증"이라고 부르지
// 않는다.

/** `tago` = 공공데이터 실제 시간표에서 온 값. `demo` = 데모 운행정보. */
export type CandidateSource = "demo" | "tago";

export function parseCandidateSource(value: unknown): CandidateSource | null {
  return value === "demo" || value === "tago" ? value : null;
}

/**
 * 역 ID 형태가 가리키는 출처.
 *
 * 공공데이터 역 ID 는 `NAT...`, 데모 역 ID 는 `demo-N` 이다
 * (`app/api/watch-jobs/route.ts` 의 `stationIdSchema`). 둘 중 어느 쪽도 아니면
 * null 을 돌려주고, 호출자가 거부한다.
 */
export function sourceForStationId(stationId: string): CandidateSource | null {
  if (/^demo-\d+$/.test(stationId)) return "demo";
  if (/^NAT[A-Z0-9]+$/.test(stationId)) return "tago";
  return null;
}

export type SourceConsistency = { ok: true; source: CandidateSource } | { ok: false; reason: string };

/**
 * 한 작업 안의 출처가 서로 맞는지 본다.
 *
 * 작업 하나는 구간·날짜·Provider 가 하나다. 그래서 후보들의 출처도 하나여야
 * 하고, 역 ID 가 가리키는 출처와도 같아야 한다.
 */
export function checkSourceConsistency(args: {
  departureId: string;
  arrivalId: string;
  candidateSources: unknown[];
}): SourceConsistency {
  const { departureId, arrivalId, candidateSources } = args;

  const fromDeparture = sourceForStationId(departureId);
  const fromArrival = sourceForStationId(arrivalId);
  if (!fromDeparture || !fromArrival) {
    return { ok: false, reason: "역 ID 형태를 알 수 없습니다." };
  }
  if (fromDeparture !== fromArrival) {
    return { ok: false, reason: "출발역과 도착역의 출처가 다릅니다." };
  }

  if (candidateSources.length === 0) {
    return { ok: false, reason: "후보 열차가 없습니다." };
  }

  const parsed: CandidateSource[] = [];
  for (const value of candidateSources) {
    const source = parseCandidateSource(value);
    if (!source) return { ok: false, reason: "후보 열차의 출처가 없거나 알 수 없는 값입니다." };
    parsed.push(source);
  }

  if (new Set(parsed).size > 1) {
    return { ok: false, reason: "한 작업에 실제 시간표 후보와 데모 후보를 섞을 수 없습니다." };
  }
  if (parsed[0] !== fromDeparture) {
    return { ok: false, reason: "후보 열차의 출처가 역 ID 의 출처와 다릅니다." };
  }

  return { ok: true, source: parsed[0] };
}

export const SOURCE_LABEL: Record<CandidateSource, string> = {
  demo: "가상 열차",
  tago: "실제 시간표",
};
