import "server-only";

import { assertTransition, isTerminal } from "@/lib/autobook/state-machine";
import { getRateLimitPolicy, nextCheckAt, retryAfterToNextCheck } from "@/lib/autobook/rate-limit";
import type { AutobookStore } from "@/lib/autobook/store";
import {
  AutobookError,
  type AutobookCandidate,
  type AutobookJob,
  type AutobookJobStatus,
  type SeatReservationProvider,
} from "@/lib/autobook/types";

// Worker. 한 번 호출하면 작업 하나를 한 단계 진행한다.
//
// 이 파일의 규칙이 v0.9의 전부다:
//
//  1. 작업을 원자적으로 claim 하고, 쓰기는 전부 fencing token 을 거친다.
//     오래된 Worker 는 아무 것도 쓰지 못한다.
//  2. 예약 요청 **직전에** claim 을 갱신해 자기가 아직 최신인지 확인한다.
//  3. 예약 요청은 멱등키와 함께 나간다. 같은 키로 두 번 나가도 예약은 하나다.
//  4. 응답이 불명확하면 **절대 재요청하지 않는다.** 예약내역을 재조회해
//     확정하고, 확정할 수 없으면 AMBIGUOUS_RESULT 로 멈춘다.
//  5. 한 후보가 확정되면 같은 작업의 나머지 후보를 즉시 중단한다.
//  6. Provider 가 예약 결과를 재확인할 수 없으면(canVerifyReservation=false)
//     애초에 예약을 시도하지 않는다.

export type WorkerResult =
  | { kind: "IDLE" }
  | { kind: "PROGRESSED"; jobId: string; from: AutobookJobStatus; to: AutobookJobStatus }
  | { kind: "SKIPPED"; jobId: string; reason: string };

const LEASE_MS = 30_000;

function activeCandidates(job: AutobookJob): AutobookCandidate[] {
  return job.candidates.filter((c) => c.state !== "STOPPED" && c.state !== "RESERVED");
}

/** 한 후보가 확정되면 나머지는 멈춘다. */
function stopOtherCandidates(job: AutobookJob, keepId: string): AutobookCandidate[] {
  return job.candidates.map((candidate) =>
    candidate.id === keepId
      ? { ...candidate, state: "RESERVED" as const }
      : candidate.state === "RESERVED"
        ? candidate
        : { ...candidate, state: "STOPPED" as const },
  );
}

export async function runOnce(input: {
  store: AutobookStore;
  provider: SeatReservationProvider;
  workerId: string;
  now?: string;
}): Promise<WorkerResult> {
  const { store, provider, workerId } = input;
  const now = input.now ?? new Date().toISOString();

  const job = await store.claimNext({ workerId, now, leaseMs: LEASE_MS });
  if (!job) return { kind: "IDLE" };

  const token = job.claim!.fencingToken;
  const policy = getRateLimitPolicy(provider.name);
  const from = job.status;

  const write = async (patch: Partial<AutobookJob>) =>
    store.updateJob({ jobId: job.id, workerId, fencingToken: token, patch });

  try {
    // 작업 자체가 만료됐으면 더 진행하지 않는다.
    if (job.expiresAt <= now) {
      await write({ status: assertTransition(from, "EXPIRED"), statusDetail: "출발 시각이 지났습니다." });
      return { kind: "PROGRESSED", jobId: job.id, from, to: "EXPIRED" };
    }

    const capabilities = provider.capabilities();
    if (!capabilities.canReadAvailability) {
      await write({
        status: assertTransition(from, "PROVIDER_UNAVAILABLE"),
        statusDetail: "공식·승인된 좌석 조회 연동이 아직 없습니다.",
        nextCheckAt: nextCheckAt(policy, 0, Date.parse(now)),
      });
      return { kind: "PROGRESSED", jobId: job.id, from, to: "PROVIDER_UNAVAILABLE" };
    }

    const candidates = activeCandidates(job);
    if (candidates.length === 0) {
      await write({ status: assertTransition(from, "CANCELLED"), statusDetail: "확인할 후보가 없습니다." });
      return { kind: "PROGRESSED", jobId: job.id, from, to: "CANCELLED" };
    }

    // --- 좌석 조회 ---------------------------------------------------------
    const status = from === "SCHEDULED" ? assertTransition(from, "WATCHING") : from;
    let found: { candidate: AutobookCandidate } | null = null;

    for (const candidate of candidates) {
      const availability = await provider.checkAvailability({ job, candidate });
      candidate.lastCheckedAt = availability.observedAt;
      candidate.checkCount += 1;

      if (availability.kind === "AVAILABLE") {
        candidate.state = "SEAT_FOUND";
        found = { candidate };
        break;
      }
      if (availability.kind === "SOLD_OUT") {
        candidate.state = "WATCHING";
        continue;
      }
      // UNKNOWN. 이유에 따라 중단 상태가 달라진다. 절대 매진으로 처리하지 않는다.
      const halt = mapUnknownReason(availability.reason);
      if (halt) {
        await write({
          status: assertTransition(status, halt),
          statusDetail: availability.reason,
          candidates: job.candidates,
          nextCheckAt: nextCheckAt(policy, job.attempts + 1, Date.parse(now)),
          attempts: job.attempts + 1,
        });
        return { kind: "PROGRESSED", jobId: job.id, from, to: halt };
      }
      candidate.state = "WATCHING";
    }

    if (!found) {
      const next = nextCheckAt(policy, 0, Date.parse(now));
      await write({
        status: status === from ? from : assertTransition(from, status),
        candidates: job.candidates,
        nextCheckAt: next,
        attempts: 0,
        statusDetail: null,
      });
      return { kind: "PROGRESSED", jobId: job.id, from, to: status };
    }

    // --- 좌석 발견 ---------------------------------------------------------
    await write({ status: assertTransition(status, "SEAT_FOUND"), candidates: job.candidates });

    // 예약 결과를 재확인할 수 없는 Provider 로는 예약을 시도하지 않는다.
    // "눌렀는지 모르겠다"를 만들지 않기 위해서다.
    if (!capabilities.canCreateReservation || !capabilities.canVerifyReservation) {
      await write({
        status: assertTransition("SEAT_FOUND", "PROVIDER_UNAVAILABLE"),
        statusDetail: "좌석을 찾았지만 예약을 생성·확인할 수 있는 승인된 연동이 없습니다.",
      });
      return { kind: "PROGRESSED", jobId: job.id, from, to: "PROVIDER_UNAVAILABLE" };
    }

    // --- 예약 요청 ---------------------------------------------------------
    // 되돌릴 수 없는 동작 직전. 내가 아직 최신 Worker 인지 확인한다.
    await store.renewClaim({ jobId: job.id, workerId, fencingToken: token, leaseMs: LEASE_MS });
    await write({ status: assertTransition("SEAT_FOUND", "RESERVATION_CLAIMING") });

    const attempt = await provider.createReservation({
      job,
      candidate: found.candidate,
      idempotencyKey: job.reservationIdempotencyKey,
    });

    switch (attempt.kind) {
      case "HELD": {
        const held = await write({
          status: assertTransition("RESERVATION_CLAIMING", "RESERVATION_HELD"),
          hold: attempt.hold,
          candidates: stopOtherCandidates(job, found.candidate.id),
          statusDetail: null,
          nextCheckAt: null,
        });
        void held;
        return { kind: "PROGRESSED", jobId: job.id, from, to: "RESERVATION_HELD" };
      }

      case "GONE": {
        // 경쟁에서 졌다. 이건 명확한 실패이므로 감시로 돌아가도 안전하다.
        found.candidate.state = "WATCHING";
        await write({
          status: assertTransition("RESERVATION_CLAIMING", "WATCHING"),
          candidates: job.candidates,
          statusDetail: "좌석을 확보하기 전에 사라졌습니다.",
          nextCheckAt: nextCheckAt(policy, 0, Date.parse(now)),
        });
        return { kind: "PROGRESSED", jobId: job.id, from, to: "WATCHING" };
      }

      case "AMBIGUOUS": {
        // 여기가 핵심이다. 재요청하지 않는다. 예약내역으로 확정한다.
        const existing = await provider.findExistingReservation({
          job,
          idempotencyKey: job.reservationIdempotencyKey,
        });
        if (existing) {
          await write({
            status: assertTransition("RESERVATION_CLAIMING", "RESERVATION_HELD"),
            hold: existing,
            candidates: stopOtherCandidates(job, existing.candidateId),
            statusDetail: "응답은 확인하지 못했지만 예약내역에서 예약을 확인했습니다.",
            nextCheckAt: null,
          });
          return { kind: "PROGRESSED", jobId: job.id, from, to: "RESERVATION_HELD" };
        }
        await write({
          status: assertTransition("RESERVATION_CLAIMING", "AMBIGUOUS_RESULT"),
          statusDetail:
            "예약 요청의 결과를 확정하지 못했습니다. 중복 예약을 피하기 위해 다시 시도하지 않습니다. 공식 예매 서비스에서 직접 확인해 주세요.",
          nextCheckAt: null,
        });
        return { kind: "PROGRESSED", jobId: job.id, from, to: "AMBIGUOUS_RESULT" };
      }

      case "AUTH_REQUIRED":
        await write({
          status: assertTransition("RESERVATION_CLAIMING", "AUTH_REQUIRED"),
          statusDetail: "계정 연결이 만료됐습니다. 다시 연결한 뒤 재개해 주세요.",
          nextCheckAt: null,
        });
        return { kind: "PROGRESSED", jobId: job.id, from, to: "AUTH_REQUIRED" };

      case "RATE_LIMITED":
        await write({
          status: assertTransition("RESERVATION_CLAIMING", "RATE_LIMITED"),
          statusDetail: "요청 제한에 걸렸습니다. 잠시 뒤 다시 확인합니다.",
          attempts: job.attempts + 1,
          nextCheckAt: retryAfterToNextCheck(policy, attempt.retryAfterSeconds, Date.parse(now)),
        });
        return { kind: "PROGRESSED", jobId: job.id, from, to: "RATE_LIMITED" };

      case "BLOCKED_BY_OPERATOR":
        // 우회하지 않는다. 종료 상태다.
        await write({
          status: assertTransition("RESERVATION_CLAIMING", "BLOCKED_BY_OPERATOR"),
          statusDetail: attempt.reason,
          nextCheckAt: null,
        });
        return { kind: "PROGRESSED", jobId: job.id, from, to: "BLOCKED_BY_OPERATOR" };
    }
  } catch (error) {
    if (error instanceof AutobookError && error.code === "STALE_CLAIM") {
      // 내가 오래된 Worker 였다. 아무 것도 쓰지 않고 물러난다.
      return { kind: "SKIPPED", jobId: job.id, reason: "STALE_CLAIM" };
    }
    const failures = job.attempts + 1;
    const next = nextCheckAt(policy, failures, Date.parse(now));
    try {
      await write({
        status: next === null && !isTerminal(job.status) ? assertTransition(job.status, "CANCELLED") : job.status,
        attempts: failures,
        nextCheckAt: next,
        statusDetail: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    } catch {
      // 쓰기조차 실패하면(대개 STALE_CLAIM) 조용히 물러난다.
    }
    return { kind: "SKIPPED", jobId: job.id, reason: "ERROR" };
  } finally {
    await store.releaseClaim({ jobId: job.id, workerId, fencingToken: token }).catch(() => {});
  }
}

/** 조회에서 UNKNOWN 이 왔을 때 어떤 중단 상태로 갈지. 매진은 여기 없다. */
function mapUnknownReason(reason: string): AutobookJobStatus | null {
  if (reason === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (reason === "RATE_LIMITED") return "RATE_LIMITED";
  if (reason === "BLOCKED_BY_OPERATOR") return "BLOCKED_BY_OPERATOR";
  return null;
}
