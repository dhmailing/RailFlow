import "server-only";

export type SeatProviderFlag = "disabled" | "mock";

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim().toLowerCase();
}

// Fail-closed: unrecognized or missing values always fall back to the
// safest option (disabled/false), never to something more permissive.
export function getSeatAvailabilityProviderFlag(): SeatProviderFlag {
  return readEnv("SEAT_AVAILABILITY_PROVIDER") === "mock" ? "mock" : "disabled";
}

export function isSeatWatchJobsEnabled(): boolean {
  return readEnv("ENABLE_SEAT_WATCH_JOBS") === "true";
}

export function isMockSeatSimulationEnabled(): boolean {
  return readEnv("ENABLE_MOCK_SEAT_SIMULATION") === "true";
}
