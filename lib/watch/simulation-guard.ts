import "server-only";

import { isMockSeatSimulationEnabled } from "@/lib/watch/feature-flags";
import { WatchError } from "@/lib/watch/types";

export const ALLOWED_SIMULATION_TICKS = [1, 2, 3, 4, 5] as const;
export type SimulationTick = (typeof ALLOWED_SIMULATION_TICKS)[number];

export type SimulationGuardInput = {
  tick: unknown;
  seatProvider: "unavailable" | "mock";
};

// Carries over the exact fix from v0.4's PR #7 review: `tick` is typed
// `unknown` and checked with `typeof` (never `Number(tick)`/z.coerce), so a
// numeric *string* ("1", "01", " 1 ") is rejected exactly like "abc" is --
// only a genuine JSON number 1-5 may pass. This value is a Worker-tick
// verification value for the Mock Seat Availability Provider; it is never a
// real request interval and never reaches any external URL.
export function assertSimulationAllowed({ tick, seatProvider }: SimulationGuardInput): SimulationTick {
  const isAllowedValue =
    typeof tick === "number" && Number.isInteger(tick) && (ALLOWED_SIMULATION_TICKS as readonly number[]).includes(tick);

  if (
    !isAllowedValue ||
    seatProvider !== "mock" ||
    process.env.NODE_ENV === "production" ||
    !isMockSeatSimulationEnabled()
  ) {
    throw new WatchError(
      "SIMULATION_NOT_ALLOWED",
      "Mock 취소표 시뮬레이션 검증값은 개발 환경의 mock Provider에서 1~5 중 하나인 JSON 숫자로만 사용할 수 있습니다.",
    );
  }

  return tick as SimulationTick;
}
