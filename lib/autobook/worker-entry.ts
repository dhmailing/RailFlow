import "server-only";

import { auditPseudonym, safeAuditDetail } from "@/lib/autobook/audit";
import {
  getAutobookProviderFlag,
  getWorkerBatchSize,
  isAutobookEnabled,
  isKillSwitchOn,
} from "@/lib/autobook/feature-flags";
import { getSeatReservationProvider } from "@/lib/autobook/provider";
import { resolveAutobookStore } from "@/lib/autobook/store-selector";
import { runOnce, type WorkerResult } from "@/lib/autobook/worker";
import { AutobookError } from "@/lib/autobook/types";

// v0.10 Worker 실행 진입점.
//
// **이것은 HTTP 라우트가 아니다.** 공개 인터넷에서 부를 수 있는 Worker
// endpoint 를 만들지 않는다 -- 그런 주소가 하나 생기면 인증·속도 제한·재시도
// 폭주를 전부 그 자리에서 다시 풀어야 하고, 실수로 열려 있으면 남이 우리
// Worker 를 돌릴 수 있다.
//
// 대신 이 함수는 **서버 프로세스 안에서만** 불린다. 앞으로 Cron 또는 Queue
// 소비자가 이 함수를 부르게 된다. 그 배포는 아직 하지 않았다
// (docs/V0.10-POSTGRES-WORKER-READINESS.md).
//
// 여기서 멈추는 조건은 전부 "아무 것도 하지 않고 멈춘다"이다. 외부로 나가는
// 동작은 Provider 가 할 수 있다고 밝힌 경우에만 일어나고, 지금 운영 기본값의
// Provider 는 아무 것도 할 수 없다고 밝힌다.

export type WorkerRunOutcome = {
  /** 한 번 실행에서 실제로 진행한 작업들. */
  ran: WorkerResult[];
  /** 멈췄다면 그 이유. 진행했으면 null. */
  stopped: WorkerStopReason | null;
  /** 사람이 읽을 수 있는 설명. 연결 정보·자격증명을 담지 않는다. */
  detail: string | null;
  store: "memory" | "postgres" | "disabled";
  provider: string;
  batchLimit: number;
};

export type WorkerStopReason =
  | "KILL_SWITCH_ON"
  | "JOBS_DISABLED"
  | "STORE_UNAVAILABLE"
  | "PROVIDER_CANNOT_READ"
  | "OFFICIAL_INTEGRATION_REQUIRED";

/**
 * 한 번 실행한다. 배치 상한(최대 5, lib/autobook/feature-flags.ts)을 넘지
 * 않는다. 무한 루프를 돌지 않는 이유는 v0.9 와 같다: 함수 타임아웃과 폭주를
 * 동시에 피하기 위해서다.
 */
export async function runAutobookWorkerOnce(input: { workerId: string }): Promise<WorkerRunOutcome> {
  const batchLimit = getWorkerBatchSize();
  const provider = getSeatReservationProvider();
  const base = { ran: [] as WorkerResult[], provider: provider.name, batchLimit };

  // 1. 강제 중단 스위치가 모든 것보다 먼저다. DB 에 손도 대지 않는다.
  if (isKillSwitchOn()) {
    return { ...base, store: "disabled", stopped: "KILL_SWITCH_ON", detail: "강제 중단 스위치가 켜져 있습니다." };
  }

  // 2. 기능 자체가 꺼져 있으면 여기서 끝난다.
  if (!isAutobookEnabled()) {
    return { ...base, store: "disabled", stopped: "JOBS_DISABLED", detail: "자동예약 작업이 비활성화돼 있습니다." };
  }

  // 3. 저장소를 쓸 수 없으면 즉시 중단한다(memory 로 후퇴하지 않는다).
  const resolution = await resolveAutobookStore();
  if (!resolution.usable) {
    return { ...base, store: resolution.mode, stopped: "STORE_UNAVAILABLE", detail: resolution.reason };
  }

  // 4. Provider 가 할 수 있는 일이 없으면 외부로 아무 것도 보내지 않고 멈춘다.
  const capabilities = provider.capabilities();
  if (!capabilities.canReadAvailability) {
    // Provider 이름 문자열이 아니라 플래그를 본다. 표시용 이름은 바뀔 수 있다.
    const official = getAutobookProviderFlag() === "official-approved";
    return {
      ...base,
      store: resolution.mode,
      stopped: official ? "OFFICIAL_INTEGRATION_REQUIRED" : "PROVIDER_CANNOT_READ",
      detail: official
        ? "공식·승인된 좌석 조회·예약 연동이 아직 없습니다(Provider 는 Stub 입니다)."
        : "현재 Provider 는 좌석 조회를 수행하지 않습니다.",
    };
  }

  // 5. 여기서부터만 실제로 작업을 진행한다.
  const ran: WorkerResult[] = [];
  for (let i = 0; i < batchLimit; i += 1) {
    const result = await runOnce({ store: resolution.store, provider, workerId: input.workerId });
    if (result.kind === "IDLE") break;
    ran.push(result);
    await recordOutcome(resolution.store, input.workerId, result);
  }

  return { ...base, ran, store: resolution.mode, stopped: null, detail: null };
}

/**
 * 진행 결과를 감사로 남긴다.
 *
 * 사용자 식별자는 가명으로만 들어간다. Worker 가 만든 statusDetail 은
 * 금지어 검사를 거친다(lib/autobook/audit.ts).
 */
async function recordOutcome(
  store: Awaited<ReturnType<typeof resolveAutobookStore>>["store"],
  workerId: string,
  result: WorkerResult,
): Promise<void> {
  if (result.kind === "IDLE") return;
  try {
    const job = await store.getJob(result.jobId);
    await store.recordAudit({
      jobId: result.jobId,
      userPseudonym: job ? auditPseudonym(job.userId) : "unknown",
      event: result.kind,
      fromStatus: result.kind === "PROGRESSED" ? result.from : null,
      toStatus: result.kind === "PROGRESSED" ? result.to : null,
      workerId,
      fencingToken: job?.claim?.fencingToken ?? null,
      detail: safeAuditDetail(result.kind === "SKIPPED" ? result.reason : job?.statusDetail ?? null),
    });
  } catch (error) {
    // 감사 기록 실패가 Worker 를 멈추게 하지 않는다. 다만 삼키기만 하고
    // 원문을 로그로 흘리지도 않는다(연결 정보가 들어 있을 수 있다).
    if (!(error instanceof AutobookError)) return;
  }
}
