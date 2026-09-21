// Fixture data and pure scenario logic for the public automation macro demo
// (/demo/booking-automation). Every value here is fabricated for this
// showcase and never calls fetch/XHR/WebSocket. Mirrors the exact scenario
// numbers RailFlow's real Mock booking site uses
// (lib/automation/mock-booking-site/seed.ts) purely for narrative
// consistency between the two -- this file never imports from
// lib/automation/** (see types.ts's header).
import type { AutomationDemoCandidate, AutomationDemoCondition, AutomationDemoScenario } from "@/lib/automation-demo/types";

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
  };
}

// 3편의 데모 전용 후보 열차. candidate-1은 항상 매진, candidate-2는 (선택된
// 후보 내에서) 자신의 3번째 조회에서 일반실 1석, candidate-3은 5번째
// 조회에서 특실 1석을 발견한다 -- RailFlow 실제 Mock 예매 사이트의 시나리오
// 숫자와 동일하게 맞췄다(문서·시연상 일관성일 뿐, 코드 의존성은 없다).
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
      scenario: { kind: "seat_after_n_checks", checksRequired: 3, seatClass: "standard" },
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
      scenario: { kind: "seat_after_n_checks", checksRequired: 5, seatClass: "special" },
    },
  ];
}

export type CheckTickResult = {
  candidates: AutomationDemoCandidate[];
  foundCandidateId: string | null;
};

function computeSeatForCheck(scenario: AutomationDemoScenario, checkCount: number): { hasSeat: boolean; seatClass: "standard" | "special" | null } {
  if (scenario.kind === "always_sold_out") return { hasSeat: false, seatClass: null };
  return checkCount >= scenario.checksRequired ? { hasSeat: true, seatClass: scenario.seatClass } : { hasSeat: false, seatClass: null };
}

// 순수 함수: 선택된 후보를 라운드로빈으로 한 번에 하나씩 확인한다(실제
// lib/automation/worker.ts의 `candidates[attempts % candidates.length]`와
// 동일한 방식) -- 이번 tick에서 확인 대상이 된 후보 하나의 checkCount만
// 증가한다. 그 후보가 이번 확인에서 좌석을 보고하면 SEAT_FOUND로 이어지는
// foundCandidateId를 반환하고, 선택된 나머지 후보는 "중단"으로 표시한다
// (실제로는 "이 job이 더 이상 WATCHING이 아니라서 다시 확인하지 않는다"는
// 뜻의 표시일 뿐, 그 후보 자체가 실패한 것은 아니다).
export function resolveCheckTick(candidates: AutomationDemoCandidate[], selectedCandidateIds: readonly string[], tickIndex: number): CheckTickResult {
  if (selectedCandidateIds.length === 0) return { candidates, foundCandidateId: null };
  const targetId = selectedCandidateIds[tickIndex % selectedCandidateIds.length];
  const target = candidates.find((candidate) => candidate.id === targetId);
  if (!target) return { candidates, foundCandidateId: null };

  const nextCheckCount = target.checkCount + 1;
  const { hasSeat } = computeSeatForCheck(target.scenario, nextCheckCount);

  if (target.scenario.kind === "always_sold_out") {
    const updated = candidates.map((candidate) => (candidate.id === targetId ? { ...candidate, checkCount: nextCheckCount, status: "sold_out" as const } : candidate));
    return { candidates: updated, foundCandidateId: null };
  }

  if (hasSeat) {
    const updated = candidates.map((candidate) => {
      if (candidate.id === targetId) return { ...candidate, checkCount: nextCheckCount, status: "seat_found" as const };
      if (selectedCandidateIds.includes(candidate.id)) return { ...candidate, status: candidate.status === "seat_found" ? candidate.status : ("stopped" as const) };
      return candidate;
    });
    return { candidates: updated, foundCandidateId: targetId };
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

export function computeVirtualPaymentDeadline(fromMs: number = Date.now()): string {
  return new Date(fromMs + 10 * 60 * 1000).toISOString();
}
