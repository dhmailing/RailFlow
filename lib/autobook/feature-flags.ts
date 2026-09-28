import "server-only";

// v0.9 기능 플래그. 모두 fail-closed 다 -- 값이 없거나 이상하면 항상 가장
// 안전한 쪽(비활성)으로 떨어진다.
//
// 이 모듈이 지키는 것:
//  - 운영 기본값은 `unavailable`. 실제 Provider가 저절로 켜지지 않는다.
//  - `official-approved` 는 **공개 명세와 사용 권한이 확인된 경우에만**
//    쓸 수 있다. 지금은 명세를 확보하지 못했으므로 선택해도 Stub이 동작하며
//    OFFICIAL_INTEGRATION_REQUIRED 로 정직하게 거부한다.
//  - Production 에서는 Mock Provider와 메모리 저장소를 값과 무관하게 막는다.
//  - 강제 중단 스위치(kill switch)가 모든 것보다 우선한다.

export type AutobookProviderFlag = "unavailable" | "mock-server" | "official-approved";
export type AutobookStoreMode = "disabled" | "memory" | "postgres";

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim().toLowerCase();
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * 강제 중단 스위치. 이 값이 켜지면 작업 생성·진행·알림이 전부 멈춘다.
 * 사고가 났을 때 코드 배포 없이 멈출 수 있어야 하기 때문에 존재한다.
 */
export function isKillSwitchOn(): boolean {
  return readEnv("AUTOBOOK_KILL_SWITCH") === "on";
}

export function getAutobookProviderFlag(): AutobookProviderFlag {
  if (isKillSwitchOn()) return "unavailable";
  const value = readEnv("AUTOBOOK_PROVIDER");
  if (value === "official-approved") return "official-approved";
  // Mock 은 운영에서 절대 선택될 수 없다. 운영 화면에 가짜 좌석이 보이면
  // 안 되기 때문이다.
  if (value === "mock-server" && !isProduction()) return "mock-server";
  return "unavailable";
}

export function getAutobookStoreMode(): AutobookStoreMode {
  if (isKillSwitchOn()) return "disabled";
  const value = readEnv("AUTOBOOK_STORE");
  if (value === "postgres") return "postgres";
  if (value === "memory") return "memory";
  return "disabled";
}

/**
 * 저장소를 실제로 쓸 수 있는가.
 *
 * memory 는 개발·테스트 전용이다. Vercel Serverless 는 인스턴스마다 별도
 * 메모리를 가지므로, 서버형 감시 작업을 메모리에 두면 다음 요청에서 사라진다
 * -- 그건 "서버형"이 아니다. postgres 어댑터는 이 PR에 아직 없다
 * (db/postgres/ 에 스키마 설계만 있다).
 */
export function isAutobookStoreUsable(): boolean {
  return getAutobookStoreMode() === "memory" && !isProduction();
}

/** 작업 생성·진행 기능 자체의 스위치. */
export function isAutobookEnabled(): boolean {
  if (isKillSwitchOn()) return false;
  return readEnv("ENABLE_AUTOBOOK_JOBS") === "true";
}

/**
 * Worker가 한 번에 처리할 작업 수. 폭주를 막기 위해 상한이 있다.
 */
export function getWorkerBatchSize(): number {
  const raw = Number(process.env.AUTOBOOK_WORKER_BATCH ?? 1);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(Math.floor(raw), 5);
}

/** 현재 설정 요약. 화면과 진단이 같은 값을 본다. */
export function autobookRuntimeStatus() {
  const provider = getAutobookProviderFlag();
  return {
    killSwitch: isKillSwitchOn(),
    provider,
    store: getAutobookStoreMode(),
    storeUsable: isAutobookStoreUsable(),
    jobsEnabled: isAutobookEnabled(),
    // 실제 예약이 일어날 수 있는 조합인지. 지금은 항상 false 다
    // (official-approved 가 Stub 이므로).
    liveReservationPossible: false,
    simulation: provider === "mock-server",
  };
}
