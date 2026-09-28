import "server-only";

import { getWorkerBatchSize, isAutobookEnabled, isKillSwitchOn } from "@/lib/autobook/feature-flags";
import { getSeatReservationProvider } from "@/lib/autobook/provider";
import type { AutobookStore } from "@/lib/autobook/store";
import { runOnce, type WorkerResult } from "@/lib/autobook/worker";

// Queue 실행기.
//
// Vercel 함수 안에서 무한 루프를 돌리지 않는다. 외부 스케줄러(cron)가
// 이 함수를 주기적으로 부르고, 한 번에 소수의 작업만 진행한다.
// 그래야 함수 타임아웃과 폭주를 동시에 피할 수 있다.

export async function drainOnce(input: {
  store: AutobookStore;
  workerId: string;
}): Promise<{ ran: WorkerResult[]; stopped: string | null }> {
  // 강제 중단 스위치가 모든 것보다 우선한다.
  if (isKillSwitchOn()) return { ran: [], stopped: "KILL_SWITCH_ON" };
  if (!isAutobookEnabled()) return { ran: [], stopped: "JOBS_DISABLED" };

  const provider = getSeatReservationProvider();
  const batch = getWorkerBatchSize();
  const ran: WorkerResult[] = [];

  for (let i = 0; i < batch; i += 1) {
    const result = await runOnce({ store: input.store, provider, workerId: input.workerId });
    if (result.kind === "IDLE") break;
    ran.push(result);
  }
  return { ran, stopped: null };
}
