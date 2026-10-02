// 검색 결과 → [자동예약] → 등록 화면으로 넘기는 조건의 순수 로직.
//
// **server-only 를 붙이지 않는다.** 이 모듈은 클라이언트 컴포넌트가 함께
// 쓴다. 대신 외부로 나가는 요청도, 저장소 접근도 하지 않는다.
//
// 여기 있는 이유는 하나다: 후보의 **출처**(실제 시간표 / 데모)와 사용자가
// 고른 **좌석등급**이 화면 사이를 오가며 조용히 사라지거나 바뀌면, 데모
// 열차가 실제 작업으로 들어가고 "일반실만" 고른 사용자가 특실을 받는다.
// 그 경계를 문자열 검사가 아니라 함수로 못박고 테스트한다.

import type { SeatClassPreference } from "@/lib/autobook/types";
import { parseCandidateSource, type CandidateSource } from "@/lib/rail/candidate-source";

export type { CandidateSource };

/**
 * 좌석등급. `lib/autobook/types.ts` 의 `SeatClassPreference` 와 **같은 값
 * 집합**이어야 한다. 아래 `_seatClassMatchesDomain` 이 컴파일 시점에
 * 확인한다 — 한쪽에 값을 추가하면 타입 검사가 깨진다.
 */
export type AutobookSeatClass = "standard_only" | "first_only" | "any";

type AssertSameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _seatClassMatchesDomain: AssertSameUnion<AutobookSeatClass, SeatClassPreference> = true;
void _seatClassMatchesDomain;

/** 기본값은 일반실만. 특실 허용은 사용자가 명시적으로 고르게 한다. */
export const DEFAULT_SEAT_CLASS: AutobookSeatClass = "standard_only";

export const SEAT_CLASS_LABEL: Record<AutobookSeatClass, string> = {
  standard_only: "일반실만",
  any: "일반실·특실 모두 허용",
  first_only: "특실만",
};

export function parseSeatClass(value: unknown): AutobookSeatClass | null {
  return value === "standard_only" || value === "first_only" || value === "any" ? value : null;
}

/** 예매 탭에서 고른 후보. 서버 작업이 아니다. */
export type StoredCandidate = {
  id: string;
  number: string;
  trainType: string;
  depart: string;
  arrive: string;
  fare: string;
  departure: string;
  arrival: string;
  date: string;
  source: CandidateSource;
};

export type AutobookHandoffTrain = {
  number: string;
  trainType: string;
  depart: string;
  arrive: string;
  source: CandidateSource;
};

export type AutobookHandoff = {
  departure: string;
  arrival: string;
  date: string;
  passengers: string;
  seatClass: AutobookSeatClass;
  trains: AutobookHandoffTrain[];
};

export type RestoredCandidates = {
  candidates: StoredCandidate[];
  /**
   * 출처를 확인할 수 없어 버린 항목 수. **실제 후보로 추정하지 않는다.**
   * 0 보다 크면 화면이 재선택을 안내해야 한다.
   */
  droppedUnknownSource: number;
  /** 모델이 아예 맞지 않아 버린 항목 수(구버전 "가짜 예약" 등). */
  droppedInvalid: number;
};

/**
 * localStorage 에서 읽은 값을 후보 목록으로 되살린다.
 *
 * 출처가 없는 항목은 **버린다.** 데모였는지 실제였는지 알 수 없는 값을
 * 실제 후보로 되살리면, 나중에 등록 경로가 열렸을 때 데모 열차가 실제
 * 작업으로 들어간다. 추정하지 않고 사용자에게 다시 고르게 한다.
 */
export function restoreCandidates(raw: unknown): RestoredCandidates {
  if (!Array.isArray(raw)) return { candidates: [], droppedUnknownSource: 0, droppedInvalid: 0 };

  const candidates: StoredCandidate[] = [];
  let droppedUnknownSource = 0;
  let droppedInvalid = 0;

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      droppedInvalid += 1;
      continue;
    }
    const row = item as Record<string, unknown>;
    const strings = ["id", "number", "trainType", "depart", "arrive", "fare", "departure", "arrival", "date"];
    if (!strings.every((key) => typeof row[key] === "string")) {
      droppedInvalid += 1;
      continue;
    }
    const source = parseCandidateSource(row.source);
    if (!source) {
      droppedUnknownSource += 1;
      continue;
    }
    candidates.push({
      id: row.id as string,
      number: row.number as string,
      trainType: row.trainType as string,
      depart: row.depart as string,
      arrive: row.arrive as string,
      fare: row.fare as string,
      departure: row.departure as string,
      arrival: row.arrival as string,
      date: row.date as string,
      source,
    });
  }

  return { candidates, droppedUnknownSource, droppedInvalid };
}

/** 후보와 사용자 조건을 등록 화면이 쓰는 모양으로 묶는다. 출처를 보존한다. */
export function buildAutobookHandoff(args: {
  candidates: StoredCandidate[];
  passengers: string;
  seatClass: AutobookSeatClass;
}): AutobookHandoff | null {
  const { candidates, passengers, seatClass } = args;
  const first = candidates[0];
  if (!first) return null;

  return {
    departure: first.departure,
    arrival: first.arrival,
    date: first.date,
    passengers,
    seatClass,
    trains: candidates.map((candidate) => ({
      number: candidate.number,
      trainType: candidate.trainType,
      depart: candidate.depart,
      arrive: candidate.arrive,
      source: candidate.source,
    })),
  };
}

export function simulatedTrains(handoff: AutobookHandoff | null): AutobookHandoffTrain[] {
  return (handoff?.trains ?? []).filter((train) => train.source === "demo");
}

export type RegistrationGate = { ok: false; reason: string } | { ok: true };

/**
 * 데모 후보를 실제 작업에서 걸러내기 위한 판정 함수.
 *
 * **지금 아무 등록 경로에도 적용되어 있지 않다.** 호출자가 없는 준비 코드다.
 * 서버형 자동예약에는 작업 생성 경로 자체가 없고(`app/api/autobook/` 는 읽기
 * 전용), 이 함수가 어떤 요청도 막고 있지 않다. "이 함수를 지나지 않고는
 * 작업을 만들 수 없다"고 말할 수 있는 상태가 아니다.
 *
 * 그럼에도 먼저 두는 이유는 판정 기준을 테스트와 함께 고정해 두려는 것이다.
 * 등록 경로를 만드는 변경에서 **호출을 추가해야** 효력이 생긴다.
 *
 * 실제로 지금 적용되고 있는 출처 검증은 다른 곳에 있다:
 * `app/api/watch-jobs/route.ts` 가 `checkSourceConsistency()` 로 요청을 거부한다.
 */
export function gateHandoffForRealRegistration(handoff: AutobookHandoff | null): RegistrationGate {
  if (!handoff || handoff.trains.length === 0) {
    return { ok: false, reason: "선택된 열차가 없습니다." };
  }
  const simulated = simulatedTrains(handoff);
  if (simulated.length > 0) {
    const names = simulated.map((train) => `${train.trainType} ${train.number}`).join(", ");
    return {
      ok: false,
      reason: `데모(가상) 열차는 실제 작업으로 등록할 수 없습니다: ${names}. 실제 시간표로 다시 검색해 주세요.`,
    };
  }
  return { ok: true };
}


// --- 기존 감시(v0.5) 경로와의 좌석등급 대응 -------------------------------

/**
 * `lib/watch/types.ts` 의 `SeatClassPreference`. 값 집합이 서버형과 다르다.
 *  - 서버형(autobook): `standard_only` | `first_only` | `any`
 *  - 감시(watch):     `standard_only` | `standard_preferred` | `any`
 */
export type WatchSeatClass = "standard_only" | "standard_preferred" | "any";

export type WatchSeatClassMapping =
  | { ok: true; value: WatchSeatClass }
  | { ok: false; reason: string };

/**
 * 서버형 좌석등급을 감시 경로의 값으로 옮긴다.
 *
 * **조건을 넓히지 않는다.** `first_only`(특실만)에 대응하는 감시 값이 없다 —
 * `any` 로 바꾸면 사용자가 허용하지 않은 일반실까지 허용하는 것이고,
 * `standard_preferred` 로 바꾸면 일반실을 우선하게 되어 뜻이 뒤집힌다. 그래서
 * 조용히 바꾸지 않고 **대응 불가로 알리고 등록을 막는다.**
 */
export function mapToWatchSeatClass(value: AutobookSeatClass): WatchSeatClassMapping {
  switch (value) {
    case "standard_only":
      return { ok: true, value: "standard_only" };
    case "any":
      return { ok: true, value: "any" };
    case "first_only":
      return {
        ok: false,
        reason:
          "취소표 감시 경로에는 '특실만' 조건이 없습니다. 조건을 넓히지 않기 위해 등록을 막습니다. 좌석등급을 '일반실만' 또는 '일반실·특실 모두 허용'으로 바꾸거나, 서버형 자동예약 경로를 사용하세요.",
      };
  }
}
