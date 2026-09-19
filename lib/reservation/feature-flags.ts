import "server-only";

export type ScheduleProviderFlag = "tago" | "mock";
export type ReservationProviderFlag = "disabled" | "mock" | "official";

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim().toLowerCase();
}

export function getScheduleProviderFlag(): ScheduleProviderFlag {
  return readEnv("RAIL_SCHEDULE_PROVIDER") === "mock" ? "mock" : "tago";
}

export function getReservationProviderFlag(): ReservationProviderFlag {
  const value = readEnv("RAIL_RESERVATION_PROVIDER");
  if (value === "mock" || value === "official") return value;
  return "disabled";
}

export function isReservationJobsEnabled(): boolean {
  return readEnv("ENABLE_RESERVATION_JOBS") === "true";
}

export function isMockSimulationEnabled(): boolean {
  return readEnv("ENABLE_MOCK_SIMULATION") === "true";
}

// Hardcoded regardless of environment value: v0.4 never sends a real
// reservation request. Enabling live reservation requires a future PR that
// removes this constant, not an env var flip.
export function isLiveReservationAllowed(): false {
  return false;
}
