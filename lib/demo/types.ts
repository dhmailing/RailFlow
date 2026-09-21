// RailFlow v0.6 "Demo Showcase" domain types.
//
// This module (and everything else under lib/demo/**) is deliberately
// self-contained: it has zero imports from lib/auth/**, lib/watch/**,
// lib/reservation/**, or lib/rail/**, and no "server-only" import anywhere
// in the tree -- the whole Demo Showcase runs entirely inside the browser
// tab that opens /demo, with state living only in that tab's sessionStorage
// (see lib/demo/storage.ts). It never calls /api/auth/**, /api/watch-jobs/**,
// /api/reservations/**, or any real railway/notification API. See
// docs/V0.6-OPERATIONS-PLAN.md for how a *real* watch/notification pipeline
// would eventually be built as a separate, later effort.

export type DemoStatus =
  | "READY"
  | "REGISTERED"
  | "WATCHING"
  | "SEAT_FOUND"
  | "NOTIFIED"
  | "FINISHED"
  | "CANCELLED";

// Per-candidate watch status inside a single demo job. "seat_found" and
// "stopped" only ever apply after the job itself has left WATCHING -- see
// lib/demo/scenarios.ts's resolveWatchTick for the one place that sets them.
export type DemoCandidateStatus = "watching" | "seat_found" | "stopped";

export type DemoIntervalSeconds = 1 | 2 | 3 | 4 | 5;

// A single fixture candidate train. Every field here is explicitly demo
// data -- trainNumber/departAt/arriveAt/fareLabel are fabricated for this
// showcase and never come from TAGO, KORAIL, or SR.
export type DemoCandidate = {
  id: string;
  trainType: string;
  trainNumber: string;
  departAt: string; // "HH:mm" 24h, demo fixture only
  arriveAt: string; // "HH:mm" 24h, demo fixture only
  fareLabel: string;
  status: DemoCandidateStatus;
};

export type DemoNotificationRecord = {
  id: string;
  at: string; // ISO timestamp
  title: string;
  body: string;
};

export type DemoHistoryEntry = {
  at: string; // ISO timestamp
  from: DemoStatus | null;
  to: DemoStatus;
};

export type DemoSearchCondition = {
  departure: string;
  arrival: string;
  date: string; // yyyy-MM-dd
  passengers: number;
};

// The entire Demo Showcase journey is one object. While status is "READY"
// the user may still edit condition/selectedCandidateIds/intervalSeconds;
// once REGISTER moves it past READY those fields are locked for that job
// (a "처음부터 다시 시작" always produces a brand-new READY object rather
// than mutating a running one -- see lib/demo/reducer.ts).
export type DemoJobState = {
  condition: DemoSearchCondition;
  candidates: DemoCandidate[];
  selectedCandidateIds: string[];
  status: DemoStatus;
  intervalSeconds: DemoIntervalSeconds;
  watchTick: number;
  foundCandidateId: string | null;
  history: DemoHistoryEntry[];
  notifications: DemoNotificationRecord[];
  createdAt: string;
  updatedAt: string;
};

export const DEMO_STORAGE_KEY = "railflow-demo-showcase-v1";
