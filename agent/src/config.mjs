// Agent 실행 설정.
//
// 반복 조회 주기(지침 §9)에 대한 중요한 결정:
//  - 시뮬레이터가 쓰던 1~5초 옵션은 여기 연결하지 않는다. 실제 사이트용
//    주기는 `livePollingIntervalSeconds` 라는 별도 이름을 쓴다.
//  - 기본값은 보수적으로 잡는다. 하한을 코드로 강제하고, 그보다 짧은 값은
//    설정으로도 내릴 수 없다.
//  - 주기는 고정이다. 탐지 회피 목적의 무작위화는 하지 않는다.

import os from "node:os";
import path from "node:path";

/** 실제 사이트 조회 주기의 하한(초). 설정으로 더 내릴 수 없다. */
export const MIN_LIVE_POLLING_INTERVAL_SECONDS = 30;

/** 기본 조회 주기(초). 보수적으로 잡았다. */
export const DEFAULT_LIVE_POLLING_INTERVAL_SECONDS = 60;

/** 네트워크 장애 백오프: 상한이 있고, 이 횟수를 넘으면 중단한다. */
export const NETWORK_BACKOFF_SECONDS = Object.freeze([30, 60, 120, 240]);

/** 사용자가 수동 로그인을 마칠 때까지 기다리는 최대 시간(분). */
export const MANUAL_LOGIN_TIMEOUT_MINUTES = 15;

/** 한 사용자당 동시에 실행되는 실제 작업 수. 1로 고정한다. */
export const MAX_CONCURRENT_LIVE_JOBS = 1;

/** Agent 로컬 IPC 기본 포트. 127.0.0.1 에만 바인딩한다. */
export const DEFAULT_AGENT_PORT = 4319;

export function agentHomeDir() {
  return process.env.RAILFLOW_AGENT_HOME || path.join(os.homedir(), ".railflow-agent");
}

export function logDir() {
  return path.join(agentHomeDir(), "logs");
}

export function profileDir() {
  return path.join(agentHomeDir(), "profiles");
}

export function stateFilePath() {
  return path.join(agentHomeDir(), "job-state.json");
}

export function lockFilePath() {
  return path.join(agentHomeDir(), "agent.lock");
}

/**
 * 브라우저 사용자 데이터 디렉터리.
 * 첫 실증에서는 임시 프로필을 쓴다(지침 §6). 브라우저를 닫으면 로그인이
 * 남지 않으며, 쿠키·세션을 파일로 내보내지 않는다.
 */
export function tempBrowserProfileDir() {
  return path.join(os.tmpdir(), `railflow-agent-profile-${process.pid}-${Date.now()}`);
}

function clampInterval(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_LIVE_POLLING_INTERVAL_SECONDS;
  return Math.max(MIN_LIVE_POLLING_INTERVAL_SECONDS, Math.floor(seconds));
}

/**
 * 설정을 읽고 안전한 범위로 정리한다.
 * `livePollingIntervalSeconds` 는 항상 하한 위로 올라온다 -- 사용자가 5초를
 * 넣어도 30초가 된다. 이건 의도된 동작이며 조용히 넘어가지 않고 경고를 남긴다.
 */
export function resolveConfig(overrides = {}) {
  const requested = overrides.livePollingIntervalSeconds ?? process.env.RAILFLOW_LIVE_POLL_SECONDS;
  const livePollingIntervalSeconds = clampInterval(requested ?? DEFAULT_LIVE_POLLING_INTERVAL_SECONDS);
  const warnings = [];
  if (requested != null && clampInterval(requested) !== Math.floor(Number(requested))) {
    warnings.push(
      `요청한 조회 주기 ${requested}초는 하한(${MIN_LIVE_POLLING_INTERVAL_SECONDS}초)보다 짧아 ${livePollingIntervalSeconds}초로 올렸습니다.`,
    );
  }
  return {
    livePollingIntervalSeconds,
    port: Number(overrides.port ?? process.env.RAILFLOW_AGENT_PORT ?? DEFAULT_AGENT_PORT),
    headless: false, // 항상 화면이 보이는 브라우저. 설정으로 끌 수 없다.
    manualLoginTimeoutMinutes: MANUAL_LOGIN_TIMEOUT_MINUTES,
    maxConcurrentJobs: MAX_CONCURRENT_LIVE_JOBS,
    warnings,
  };
}
