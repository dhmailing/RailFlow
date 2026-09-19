import "server-only";

import { isMockSimulationEnabled } from "@/lib/reservation/feature-flags";
import { ReservationProviderError } from "@/lib/reservation/types";

export const ALLOWED_SIMULATION_INTERVALS = [1, 2, 3, 4, 5] as const;
export type SimulationIntervalSeconds = (typeof ALLOWED_SIMULATION_INTERVALS)[number];

export type SimulationGuardInput = {
  intervalSeconds: unknown;
  provider: "mock" | "official";
};

// This guard exists to keep "Mock 작업 시뮬레이션 간격" from ever being read as a
// click-interval or anti-detection knob against a real railway site. It is
// deliberately re-checked on the server on every call, never trusted from the
// client, and it hard-fails outside NODE_ENV!=="production" + provider==="mock",
// regardless of what the UI sent.
//
// `intervalSeconds` is typed `unknown` and checked with `typeof` here (not
// `Number(intervalSeconds)`/z.coerce) on purpose: this function must reject a
// numeric *string* ("1", "01", " 1 ") exactly like it rejects "abc" -- only a
// genuine JSON number 1-5 may pass. The caller (the simulate route) already
// enforces this at the schema level with z.number().int().min(1).max(5), but
// this function does not rely on that -- it performs the same type, integer,
// and allowed-value checks independently, so it stays correct even if called
// from somewhere that skips or weakens the route's own schema.
export function assertSimulationAllowed({ intervalSeconds, provider }: SimulationGuardInput): SimulationIntervalSeconds {
  const isAllowedValue =
    typeof intervalSeconds === "number" &&
    Number.isInteger(intervalSeconds) &&
    (ALLOWED_SIMULATION_INTERVALS as readonly number[]).includes(intervalSeconds);

  if (
    !isAllowedValue ||
    provider !== "mock" ||
    process.env.NODE_ENV === "production" ||
    !isMockSimulationEnabled()
  ) {
    throw new ReservationProviderError(
      "SIMULATION_INTERVAL_NOT_ALLOWED",
      "Mock 작업 시뮬레이션 간격은 개발 환경의 mock Provider에서 1~5 중 하나인 JSON 숫자로만 사용할 수 있습니다.",
    );
  }

  return intervalSeconds as SimulationIntervalSeconds;
}
