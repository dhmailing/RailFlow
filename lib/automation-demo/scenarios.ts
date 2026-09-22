// Fixture data and pure scenario logic for the public automation macro demo
// (/demo/booking-automation). Every value here is fabricated for this
// showcase and never calls fetch/XHR/WebSocket. Mirrors the exact scenario
// numbers RailFlow's real Mock booking site uses
// (lib/automation/mock-booking-site/seed.ts) purely for narrative
// consistency between the two -- this file never imports from
// lib/automation/** (see types.ts's header).
import type { AutomationDemoCandidate, AutomationDemoCondition, AutomationDemoScenario, AutomationDemoSeatClassPreference } from "@/lib/automation-demo/types";

export function kstToday(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

export function defaultAutomationDemoCondition(): AutomationDemoCondition {
  return {
    departure: "동탄",
    arrival: "울산(통도사)",
    date: kstToday(1),
    timeRangeStart: "05:00",
    timeRangeEnd: "10:00",
    passengers: 1,
    seatClassPreference: "any",
  };
}

// 3편의 데모 전용 후보 열차. candidate-1은 항상 매진, candidate-2는 (선택된
// 후보 내에서) 자신의 3번째 조회에서 일반실 1석, candidate-3은 5번째
// 조회에서 특실 1석을 발견한다 -- RailFlow 실제 Mock 예매 사이트의 시나리오
// 숫자와 동일하게 맞췄다(문서·시연상 일관성일 뿐, 코드 의존성은 없다).
// 두 시나리오 모두 seatCount는 항상 1이다 -- 요청 인원이 2명 이상이면
// resolveCheckTick이 이 좌석을 "부족"으로 처리하고 예약 성공으로 넘어가지
// 않는다(§3 결함 수정: "표시된 좌석 수가 요청 인원보다 적을 때는 예약
// 성공으로 처리하지 않는다").
export function automationDemoCandidateFixtures(): AutomationDemoCandidate[] {
  return [
    {
      id: "auto-demo-candidate-1",
      trainType: "KTX",
      trainNumber: "KTX 00101(데모)",
      departAt: "05:12",
      arriveAt: "07:48",
      fareLabel: "₩53,500(데모 운임)",
      status: "waiting",
      checkCount: 0,
      scenario: { kind: "always_sold_out" },
    },
    {
      id: "auto-demo-candidate-2",
      trainType: "KTX",
      trainNumber: "KTX 00305(데모)",
      departAt: "07:11",
      arriveAt: "09:07",
      fareLabel: "₩45,800(데모 운임)",
      status: "waiting",
      checkCount: 0,
      scenario: { kind: "seat_after_n_checks", checksRequired: 3, seatClass: "standard", seatCount: 1 },
    },
    {
      id: "auto-demo-candidate-3",
      trainType: "SRT",
      trainNumber: "SRT 00305(데모)",
      departAt: "08:05",
      arriveAt: "10:31",
      fareLabel: "₩49,800(데모 운임)",
      status: "waiting",
      checkCount: 0,
      scenario: { kind: "seat_after_n_checks", checksRequired: 5, seatClass: "special", seatCount: 1 },
    },
  ];
}

function parseHHMM(value: string): number {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return hours * 60 + minutes;
}

// §3 결함 수정: "입력한 시간대... 가 실제 후보 선정에 반영되는지" -- 후보의
// 출발 시각이 희망 시간대(timeRangeStart~timeRangeEnd) 안에 있어야
// 선택(및 자동 감시 대상)이 될 수 있다.
export function isCandidateWithinTimeRange(candidate: Pick<AutomationDemoCandidate, "departAt">, condition: Pick<AutomationDemoCondition, "timeRangeStart" | "timeRangeEnd">): boolean {
  const depart = parseHHMM(candidate.departAt);
  const start = parseHHMM(condition.timeRangeStart);
  const end = parseHHMM(condition.timeRangeEnd);
  if (start <= end) return depart >= start && depart <= end;
  // 자정을 넘어가는 범위(예: 23:00~02:00)도 다룰 수 있도록 대비한다.
  return depart >= start || depart <= end;
}

// §3 결함 수정: "입력한... 좌석등급이 실제 후보 선정에 반영되는지" --
// standard_only를 선택하면 특실만 나오는 후보(candidate-3)는 선택할 수
// 없다. 매진 후보는 좌석 등급이 없으므로 이 필터의 영향을 받지 않는다.
export function isCandidateCompatibleWithSeatClass(candidate: Pick<AutomationDemoCandidate, "scenario">, preference: AutomationDemoSeatClassPreference): boolean {
  if (preference !== "standard_only") return true;
  if (candidate.scenario.kind !== "seat_after_n_checks") return true;
  return candidate.scenario.seatClass === "standard";
}

export function isCandidateEligible(candidate: AutomationDemoCandidate, condition: AutomationDemoCondition): boolean {
  return isCandidateWithinTimeRange(candidate, condition) && isCandidateCompatibleWithSeatClass(candidate, condition.seatClassPreference);
}

export type CheckTickResult = {
  candidates: AutomationDemoCandidate[];
  foundCandidateId: string | null;
};

function computeSeatForCheck(scenario: AutomationDemoScenario, checkCount: number): { hasSeat: boolean; seatClass: "standard" | "special" | null; seatCount: number } {
  if (scenario.kind === "always_sold_out") return { hasSeat: false, seatClass: null, seatCount: 0 };
  const reached = checkCount >= scenario.checksRequired;
  return { hasSeat: reached, seatClass: reached ? scenario.seatClass : null, seatCount: reached ? scenario.seatCount : 0 };
}

// 순수 함수: 선택된 후보를 라운드로빈으로 한 번에 하나씩 확인한다(실제
// lib/automation/worker.ts의 `candidates[attempts % candidates.length]`와
// 동일한 방식) -- 이번 tick에서 확인 대상이 된 후보 하나의 checkCount만
// 증가한다. 그 후보가 이번 확인에서 "요청 인원(passengers)을 충족하는"
// 좌석을 보고하면 SEAT_FOUND로 이어지는 foundCandidateId를 반환하고, 선택된
// 나머지 후보는 "중단"으로 표시한다(실제로는 "이 job이 더 이상 WATCHING이
// 아니라서 다시 확인하지 않는다"는 뜻의 표시일 뿐, 그 후보 자체가 실패한
// 것은 아니다). 좌석이 있어도 요청 인원보다 적으면(이 fixture는 항상 1석)
// "insufficient"로만 표시하고 절대 예약 성공으로 이어가지 않는다(§3).
export function resolveCheckTick(candidates: AutomationDemoCandidate[], selectedCandidateIds: readonly string[], tickIndex: number, passengers: number): CheckTickResult {
  if (selectedCandidateIds.length === 0) return { candidates, foundCandidateId: null };
  const targetId = selectedCandidateIds[tickIndex % selectedCandidateIds.length];
  const target = candidates.find((candidate) => candidate.id === targetId);
  if (!target) return { candidates, foundCandidateId: null };

  const nextCheckCount = target.checkCount + 1;
  const { hasSeat, seatCount } = computeSeatForCheck(target.scenario, nextCheckCount);

  if (target.scenario.kind === "always_sold_out") {
    const updated = candidates.map((candidate) => (candidate.id === targetId ? { ...candidate, checkCount: nextCheckCount, status: "sold_out" as const } : candidate));
    return { candidates: updated, foundCandidateId: null };
  }

  if (hasSeat && seatCount >= passengers) {
    const updated = candidates.map((candidate) => {
      if (candidate.id === targetId) return { ...candidate, checkCount: nextCheckCount, status: "seat_found" as const };
      if (selectedCandidateIds.includes(candidate.id)) return { ...candidate, status: candidate.status === "seat_found" ? candidate.status : ("stopped" as const) };
      return candidate;
    });
    return { candidates: updated, foundCandidateId: targetId };
  }

  if (hasSeat) {
    // 좌석은 있지만 요청 인원에 못 미친다 -- 이 후보를 "발견"으로 잘못
    // 표시하지 않고 계속 라운드로빈 대상에 남겨둔다(이 fixture는 좌석 수가
    // 더 늘지 않으므로 이후로도 계속 "insufficient"로만 남는다는 것을
    // 화면에 정직하게 보여준다).
    const updated = candidates.map((candidate) => (candidate.id === targetId ? { ...candidate, checkCount: nextCheckCount, status: "insufficient" as const } : candidate));
    return { candidates: updated, foundCandidateId: null };
  }

  const updated = candidates.map((candidate) => (candidate.id === targetId ? { ...candidate, checkCount: nextCheckCount, status: "checking" as const } : candidate));
  return { candidates: updated, foundCandidateId: null };
}

export function generateVirtualReservationNumber(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 8; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `RF-${suffix}`;
}

// 결제기한(§4: "감시 기한과 결제기한은 구분한다") -- 가상 예약 성공 시점
// 기준 +10분. RailFlow의 실제 Mock 예매 사이트(lib/automation/mock-booking-site/store.ts)와
// 같은 값을 문서·시연상 일관성을 위해 그대로 썼다(코드 의존성은 없다).
export function computeVirtualPaymentDeadline(fromMs: number = Date.now()): string {
  return new Date(fromMs + 10 * 60 * 1000).toISOString();
}
