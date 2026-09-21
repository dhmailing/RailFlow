import "server-only";

export type SeatProviderFlag = "disabled" | "mock";
export type WatchStoreMode = "disabled" | "memory" | "postgres";

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim().toLowerCase();
}

// Fail-closed: unrecognized or missing values always fall back to the
// safest option (disabled/false), never to something more permissive.
export function getSeatAvailabilityProviderFlag(): SeatProviderFlag {
  return readEnv("SEAT_AVAILABILITY_PROVIDER") === "mock" ? "mock" : "disabled";
}

// §1 검토사항과 동일한 이유(lib/auth/feature-flags.ts 참고): Vercel
// Serverless는 인스턴스(및 콜드스타트)마다 별도 프로세스 메모리를 가지므로,
// 메모리 기반 WatchJob/Device 저장소는 운영 환경에서 실제 영속 저장소처럼
// 동작할 수 없다 -- 한 인스턴스에 등록한 감시 작업이 다음 요청에서 사라질 수
// 있다. AUTH_STORE와 별개로 독립적으로 차단한다: 계정 저장소가 언젠가
// Postgres로 바뀌어도 Watch Store가 여전히 memory라면 이 게이트가 따로
// 막아야 한다.
export function getWatchStoreMode(): WatchStoreMode {
  const value = readEnv("WATCH_STORE");
  return value === "memory" || value === "postgres" ? value : "disabled";
}

// "postgres"는 향후 실제 어댑터가 생기면 이 플래그의 모양을 다시 바꾸지
// 않아도 되도록 선택 가능한 값으로만 받아들인다 -- 이번 PR에는
// Postgres-backed 구현이 없으므로(db/postgres/는 설계 문서일 뿐) 아직은
// 절대 usable하지 않는다.
export function isWatchStoreUsable(): boolean {
  return getWatchStoreMode() === "memory" && process.env.NODE_ENV !== "production";
}

export function isSeatWatchJobsEnabled(): boolean {
  return readEnv("ENABLE_SEAT_WATCH_JOBS") === "true";
}

export function isMockSeatSimulationEnabled(): boolean {
  return readEnv("ENABLE_MOCK_SEAT_SIMULATION") === "true";
}
