import "server-only";

import { describePostgresConfig } from "@/lib/autobook/postgres/config";

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
 * -- 그건 "서버형"이 아니다.
 *
 * postgres 는 v0.10 에서 **어댑터 코드가 생겼다**
 * (lib/autobook/postgres-store.ts). 다만 "코드가 있다"와 "이 환경에서 쓸 수
 * 있다"는 다르다. 연결 설정이 없으면 여기서 false 다 -- 그리고 그때
 * **memory 로 후퇴하지 않는다.** 자동 후퇴는 서버형인 줄 알았던 작업이
 * 조용히 휘발되게 만든다.
 */
export function isAutobookStoreUsable(): boolean {
  const mode = getAutobookStoreMode();
  if (mode === "memory") return !isProduction();
  if (mode === "postgres") return isPostgresStoreConfigured();
  return false;
}

/** postgres 어댑터 코드가 이 저장소에 있는가. 배포·연결 여부와 별개다. */
export function hasPostgresStoreImplementation(): boolean {
  return true;
}

/** 이 환경에 연결 설정이 있는가. 실제 연결 성공 여부와 별개다. */
export function isPostgresStoreConfigured(): boolean {
  return describePostgresConfig().configured;
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

/**
 * Worker 가 운영에 배포돼 주기적으로 돌고 있는가.
 *
 * **코드가 있다는 것과 운영에서 돌고 있다는 것은 다르다.** v0.10 은 실행
 * 진입점(lib/autobook/worker-entry.ts)까지 만들었고, 그것을 부를 Cron·Queue 는
 * 아직 배포하지 않았다. 배포한 뒤 이 값을 켜는 것이 순서다.
 */
export function isWorkerScheduleConfigured(): boolean {
  return readEnv("AUTOBOOK_WORKER_SCHEDULE") === "configured";
}

/** 현재 설정 요약. 화면과 진단이 같은 값을 본다. */
export function autobookRuntimeStatus() {
  const provider = getAutobookProviderFlag();
  const store = getAutobookStoreMode();
  const postgres = describePostgresConfig();
  return {
    killSwitch: isKillSwitchOn(),
    provider,
    store,
    storeUsable: isAutobookStoreUsable(),
    jobsEnabled: isAutobookEnabled(),
    // 실제 예약이 일어날 수 있는 조합인지. 지금은 항상 false 다
    // (official-approved 가 Stub 이므로).
    liveReservationPossible: false,
    simulation: provider === "mock-server",
    // --- v0.10: "코드가 있다" 와 "운영에서 켜져 있다" 를 나눠서 보여준다 ---
    postgres: {
      /** 어댑터 코드가 저장소에 있는가. */
      implemented: hasPostgresStoreImplementation(),
      /** 이 환경에 연결 설정이 있는가. 연결 문자열 자체는 절대 담지 않는다. */
      configured: postgres.configured,
      /** 설정이 없거나 형식이 틀렸다면 그 이유(값은 담지 않는다). */
      problem: postgres.problem,
    },
    worker: {
      /** 실행 진입점 코드가 있는가. */
      entrypointImplemented: true,
      /** Cron·Queue 가 실제로 이 진입점을 부르도록 배포됐는가. */
      scheduleConfigured: isWorkerScheduleConfigured(),
    },
  };
}
