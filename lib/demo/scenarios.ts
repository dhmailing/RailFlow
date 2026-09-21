// Fixture data and pure scenario logic for the Demo Showcase. Every value
// here is fabricated for this showcase -- none of it comes from TAGO,
// KORAIL, SR, or any real timetable/fare source, and nothing in this file
// ever calls fetch/XHR/WebSocket. See lib/demo/types.ts's header for the
// module-boundary rules this file (like the rest of lib/demo/**) follows.
import type { DemoCandidate, DemoNotificationRecord, DemoSearchCondition } from "@/lib/demo/types";

// Same official 코레일 웹사이트 주소 this project already links to from
// v0.3's booking results and v0.5's "코레일+에서 예매하기" button
// (lib/watch/booking-launch-provider.ts). Duplicated here as a literal
// string -- deliberately *not* imported from lib/watch/** -- so the Demo
// Showcase module tree stays fully decoupled from operational code (§4.2).
// No private/undocumented deep link is guessed or fabricated.
export const OFFICIAL_BOOKING_URL = "https://www.korail.com/";

export function kstToday(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

export const DEFAULT_DEMO_ROUTE = { departure: "동탄", arrival: "울산(통도사)" } as const;

export function defaultDemoCondition(): DemoSearchCondition {
  return {
    departure: DEFAULT_DEMO_ROUTE.departure,
    arrival: DEFAULT_DEMO_ROUTE.arrival,
    // "가까운 미래 날짜": 오늘 KST 기준 내일. 실제 예매 가능 날짜 범위와는
    // 무관한, 화면 시연용 기본값일 뿐이다.
    date: kstToday(1),
    passengers: 1,
  };
}

export function swapDemoRoute(condition: DemoSearchCondition): DemoSearchCondition {
  return { ...condition, departure: condition.arrival, arrival: condition.departure };
}

// 오전 05:00~10:00 시간대의 데모 전용 후보 열차 3편. trainNumber에 "(데모)"를
// 붙여 화면과 코드 양쪽에서 실제 운행정보가 아님을 명시한다(§5.2).
export function demoCandidateFixtures(): DemoCandidate[] {
  return [
    { id: "demo-candidate-1", trainType: "KTX", trainNumber: "KTX 101(데모)", departAt: "05:12", arriveAt: "07:48", fareLabel: "₩53,500(데모 운임)", status: "watching" },
    { id: "demo-candidate-2", trainType: "KTX", trainNumber: "KTX 107(데모)", departAt: "06:40", arriveAt: "09:22", fareLabel: "₩53,500(데모 운임)", status: "watching" },
    { id: "demo-candidate-3", trainType: "SRT", trainNumber: "SRT 305(데모)", departAt: "08:05", arriveAt: "10:31", fareLabel: "₩49,800(데모 운임)", status: "watching" },
  ];
}

// 감시 진행 중 몇 번째 단계(tick)에서 좌석이 발견되는지 -- 결정론적, 랜덤
// 아님(§7). "선택된 후보 중 순서상 첫 번째"가 이 tick에서 좌석을 발견하고,
// 나머지 선택된 후보는 즉시 "감시 중단"으로 표시된다.
export const SEAT_FOUND_AT_TICK = 2;

export type WatchTickResult = {
  candidates: DemoCandidate[];
  foundCandidateId: string | null;
};

// 순수 함수: 다음 tick 번호와 현재 후보 목록·선택 목록을 받아 이번 tick에서
// 좌석이 발견됐는지, 발견됐다면 어떤 후보이고 나머지 후보 상태가 어떻게
// 바뀌는지를 계산한다. 실제 상태 전이(WATCHING -> SEAT_FOUND)는 이 결과를
// 사용하는 호출자(lib/demo/reducer.ts)의 책임이다.
export function resolveWatchTick(candidates: DemoCandidate[], selectedCandidateIds: readonly string[], nextTick: number): WatchTickResult {
  if (nextTick < SEAT_FOUND_AT_TICK || selectedCandidateIds.length === 0) {
    return { candidates, foundCandidateId: null };
  }
  const foundCandidateId = candidates.find((candidate) => selectedCandidateIds.includes(candidate.id))?.id ?? null;
  if (!foundCandidateId) {
    return { candidates, foundCandidateId: null };
  }
  const updated = candidates.map((candidate) => {
    if (!selectedCandidateIds.includes(candidate.id)) return candidate;
    return { ...candidate, status: candidate.id === foundCandidateId ? ("seat_found" as const) : ("stopped" as const) };
  });
  return { candidates: updated, foundCandidateId };
}

export function buildSeatFoundNotification(condition: DemoSearchCondition, candidate: DemoCandidate, at: string): DemoNotificationRecord {
  return {
    id: `demo-notification-${at}`,
    at,
    title: "가상 알림 · 좌석 발생",
    body: `${condition.departure} → ${condition.arrival} · ${candidate.trainNumber} · ${candidate.departAt} 출발 좌석이 발견된 것처럼 시연됩니다. 실제 알림은 발송되지 않았습니다.`,
  };
}
