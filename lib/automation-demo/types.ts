// RailFlow "자동 좌석조회·예약 매크로" 공개 시연 (/demo/booking-automation).
//
// This module (and everything else under lib/automation-demo/**) is
// deliberately self-contained, mirroring lib/demo/**'s isolation rule: zero
// imports from lib/auth/**, lib/watch/**, lib/reservation/**, or
// lib/automation/** (the real job-store/worker/provider module that
// requireAuth gates), and no "server-only" import anywhere in this tree.
// The whole thing runs entirely inside the browser tab that opens
// /demo/booking-automation, with state living only in that tab's
// sessionStorage (see lib/automation-demo/storage.ts). This exists because
// signup/login themselves are blocked on Vercel Preview today (AUTH_STORE's
// isAuthStoreUsable() is keyed on NODE_ENV, and Vercel Preview builds run
// with NODE_ENV=production) -- see docs/V0.7-PREVIEW-DEMO-AUDIT.md §1. This
// page never calls /api/auth/**, /api/automation-jobs/**,
// /api/automation/mock-site/**, or any real railway/notification API.

export type AutomationDemoStatus =
  | "READY"
  | "WATCHING"
  | "SEAT_FOUND"
  | "PURCHASE_CLICKING"
  | "RESERVING"
  | "PAYMENT_PENDING"
  | "COMPLETED"
  | "PAYMENT_EXPIRED"
  | "CANCELLED";

// "waiting": not yet checked this journey. "checking": selected but not yet
// found. "sold_out": this candidate's own always_sold_out scenario reported
// (never reopens in this fixture). "insufficient": the scenario's checksRequired
// was reached and a seat exists, but the fixture's seat count (always 1) is
// below the requested passenger count -- 결함 수정(1단계): 요청 인원보다
// 적은 좌석을 예약 성공으로 처리하면 안 된다(§3). "seat_found"/"stopped":
// set together, the instant one selected candidate reports a *sufficient*
// seat (see scenarios.ts's resolveCheckTick) -- mirrors the real Worker's
// single-state-machine design: once the job leaves WATCHING it simply never
// checks the other candidates again, so "stopped" is a display label, not a
// separate FSM.
export type AutomationDemoCandidateStatus = "waiting" | "checking" | "sold_out" | "insufficient" | "seat_found" | "stopped";

export type AutomationDemoIntervalSeconds = 1 | 2 | 3 | 4 | 5;

// Mirrors lib/automation/types.ts's SeatClassPreference exactly (same three
// values, same meaning) so this demo's UI reflects the same real-world
// choice, even though it never imports that module (see header comment
// above). "standard_only" excludes any candidate whose scenario can only
// ever produce a "special" seat (candidate-3 in this fixture's scenario).
export type AutomationDemoSeatClassPreference = "standard_only" | "standard_preferred" | "any";

export type AutomationDemoScenario =
  | { kind: "always_sold_out" }
  | { kind: "seat_after_n_checks"; checksRequired: number; seatClass: "standard" | "special"; seatCount: number };

export type AutomationDemoCandidate = {
  id: string;
  trainType: string;
  trainNumber: string;
  departAt: string; // "HH:mm" 24h, demo fixture only
  arriveAt: string; // "HH:mm" 24h, demo fixture only
  fareLabel: string;
  status: AutomationDemoCandidateStatus;
  checkCount: number;
  scenario: AutomationDemoScenario;
};

export type AutomationDemoHistoryEntry = {
  at: string; // ISO timestamp
  from: AutomationDemoStatus | null;
  to: AutomationDemoStatus;
};

export type AutomationDemoCondition = {
  departure: string;
  arrival: string;
  date: string; // yyyy-MM-dd
  timeRangeStart: string; // "HH:mm"
  timeRangeEnd: string; // "HH:mm"
  passengers: number; // 1~4, mirrors lib/automation/types.ts's AutomationJobInput.passengers range
  seatClassPreference: AutomationDemoSeatClassPreference;
};

// The entire journey is one object, exactly like lib/demo/types.ts's
// DemoJobState. While status is "READY" the user may still edit
// condition/selectedCandidateIds/intervalSeconds; once START_WATCHING moves
// it past READY those fields are locked for that job -- "다시 감시" always
// produces a brand-new READY-derived object rather than mutating a running
// one (see reducer.ts's RESTART_WATCH).
export type AutomationDemoState = {
  condition: AutomationDemoCondition;
  candidates: AutomationDemoCandidate[];
  selectedCandidateIds: string[];
  status: AutomationDemoStatus;
  intervalSeconds: AutomationDemoIntervalSeconds;
  watchTick: number;
  foundCandidateId: string | null;
  reservationNumber: string | null;
  paymentDeadline: string | null; // ISO
  history: AutomationDemoHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  // 경과 시간 계산 전용 필드(lib/demo/types.ts와 동일한 원칙). startedAt은
  // "자동 감시 시작" 순간(READY -> WATCHING)에만 설정되고, endedAt은
  // COMPLETED/CANCELLED/PAYMENT_EXPIRED로 전이하는 순간에만 고정된다.
  startedAt: string | null;
  endedAt: string | null;
};

export const AUTOMATION_DEMO_STORAGE_KEY = "railflow-automation-demo-v1";
