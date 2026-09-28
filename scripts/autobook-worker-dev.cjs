#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- 다른 scripts/*.cjs 와 같은 CommonJS 스크립트다. */
// 개발용 Worker 실행기.
//
// **이것은 운영 배포가 아니다.** 운영에서 Worker 를 주기적으로 돌리려면
// Cron 또는 Queue 소비자가 lib/autobook/worker-entry.ts 의
// runAutobookWorkerOnce() 를 부르게 해야 한다. 그 배포는 아직 하지 않았다
// (docs/V0.10-POSTGRES-WORKER-READINESS.md §5).
//
// 이 스크립트가 있는 이유는 하나다: 실행 진입점이 실제로 불리는지, 그리고
// 어떤 조건에서 멈추는지를 개발자가 직접 확인할 수 있어야 하기 때문이다.
//
// 안전장치
//  - NODE_ENV=production 에서는 실행을 거부한다.
//  - 한 번 실행하고 끝난다. 루프를 돌지 않는다.
//  - 외부 철도 사이트로 나가지 않는다(Provider 가 그럴 능력이 없다고 밝힌다).

const { load } = require("../tests/e2e/load-ts.cjs");

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error(
      JSON.stringify({
        result: "REFUSED",
        reason: "PRODUCTION",
        note: "개발용 스크립트입니다. 운영에서는 Cron·Queue 가 worker-entry 를 직접 부르도록 배포하세요.",
      }),
    );
    process.exit(1);
  }

  const { runAutobookWorkerOnce } = load("lib/autobook/worker-entry.ts");
  const workerId = process.env.AUTOBOOK_WORKER_ID || `dev-${process.pid}`;
  const outcome = await runAutobookWorkerOnce({ workerId });

  // 연결 문자열·자격증명은 outcome 에 담기지 않는다(worker-entry 의 detail 은
  // 사람이 읽을 문구이며 값이 없다).
  console.log(
    JSON.stringify({
      result: outcome.stopped ? "STOPPED" : "RAN",
      workerId,
      store: outcome.store,
      provider: outcome.provider,
      batchLimit: outcome.batchLimit,
      stopped: outcome.stopped,
      detail: outcome.detail,
      progressed: outcome.ran.length,
      note: "실제 좌석 조회·예약은 수행하지 않습니다. 공식 Provider 는 Stub 입니다.",
    }),
  );
}

main().catch((error) => {
  // 원문에 연결 정보가 들어 있을 수 있으므로 코드만 남긴다.
  const code = error && typeof error.code === "string" ? error.code : "UNKNOWN";
  console.error(JSON.stringify({ result: "ERROR", code }));
  process.exit(1);
});
