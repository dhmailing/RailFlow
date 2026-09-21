import "server-only";

import { WatchError, type TrainCandidateInput, type WatchJobInput } from "@/lib/watch/types";

const SEOUL_TZ = "Asia/Seoul";

// 열차 시각은 항상 한국 철도 운행 기준(Asia/Seoul)으로 비교한다 -- departAt은
// offset이 포함된 ISO 문자열이라 어떤 로컬 오프셋으로 오든 결과는 같다.
function toSeoulDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: SEOUL_TZ });
}

function toSeoulClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: SEOUL_TZ, hour: "2-digit", minute: "2-digit" });
}

// §7 검토사항: 후보 열차와 감시 작업 조건(날짜/시간범위)의 정합성 검증.
// 클라이언트가 무엇을 보내든, 저장하기 전에 서버가 직접 재검증한다 --
// candidate.id는 이 시점에는 아직 존재하지 않으므로(서버가 나중에 생성)
// externalKey로만 중복을 판단한다.
export function validateCandidates(
  input: Pick<WatchJobInput, "date" | "timeRangeStart" | "timeRangeEnd"> & { candidates: TrainCandidateInput[] },
): void {
  const seenExternalKeys = new Set<string>();

  for (const candidate of input.candidates) {
    if (seenExternalKeys.has(candidate.externalKey)) {
      throw new WatchError("INVALID_CANDIDATE", `중복된 후보 열차(${candidate.externalKey})가 포함되어 있습니다.`);
    }
    seenExternalKeys.add(candidate.externalKey);

    const departTime = new Date(candidate.departAt).getTime();
    const arriveTime = new Date(candidate.arriveAt).getTime();
    if (!Number.isFinite(departTime) || !Number.isFinite(arriveTime)) {
      throw new WatchError("INVALID_CANDIDATE", `후보 열차(${candidate.trainNumber})의 시간 값이 올바르지 않습니다.`);
    }
    if (arriveTime <= departTime) {
      throw new WatchError("INVALID_CANDIDATE", `후보 열차(${candidate.trainNumber})의 도착시간이 출발시간보다 앞설 수 없습니다.`);
    }

    const departDate = toSeoulDate(candidate.departAt);
    if (departDate !== input.date) {
      throw new WatchError(
        "INVALID_CANDIDATE",
        `후보 열차(${candidate.trainNumber})의 출발일(${departDate})이 감시 작업의 날짜(${input.date})와 다릅니다.`,
      );
    }

    const departClock = toSeoulClock(candidate.departAt);
    if (departClock < input.timeRangeStart || departClock > input.timeRangeEnd) {
      throw new WatchError(
        "INVALID_CANDIDATE",
        `후보 열차(${candidate.trainNumber})의 출발시각(${departClock})이 요청한 시간범위(${input.timeRangeStart}~${input.timeRangeEnd})를 벗어났습니다.`,
      );
    }
  }
}
