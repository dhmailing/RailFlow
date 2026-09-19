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
export function assertSimulationAllowed({ intervalSeconds, provider }: SimulationGuardInput): SimulationIntervalSeconds {
  const value = typeof intervalSeconds === "number" ? intervalSeconds : Number(intervalSeconds);
  const isAllowedValue =
    Number.isInteger(value) && (ALLOWED_SIMULATION_INTERVALS as readonly number[]).includes(value);

  if (
    !isAllowedValue ||
    provider !== "mock" ||
    process.env.NODE_ENV === "production" ||
    !isMockSimulationEnabled()
  ) {
    throw new ReservationProviderError(
      "SIMULATION_INTERVAL_NOT_ALLOWED",
      "Mock 작업 시뮬레이션 간격은 개발 환경의 mock Provider에서만 1~5초 값으로 사용할 수 있습니다.",
    );
  }

  return value as SimulationIntervalSeconds;
}
