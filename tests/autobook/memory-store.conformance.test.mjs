// Memory 저장소가 공통 계약을 만족하는지.
//
// 이 파일이 통과했다고 PostgreSQL 저장소가 검증된 것은 아니다. 그 검증은
// postgres-store.conformance.test.mjs 가 실제 DB 에 붙어서 한다.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";
import { makeJob, runStoreConformance } from "./store-conformance.mjs";

const { loadTs } = loader;
const { createMemoryAutobookStore, resetMemoryAutobookStore } = loadTs("lib/autobook/memory-store.ts");

runStoreConformance({
  label: "memory",
  async setup() {
    resetMemoryAutobookStore();
    return createMemoryAutobookStore();
  },
  helpers: {
    // 같은 프로세스 안에서 새 인스턴스를 만든다. 모듈 수준 Map 을 공유하므로
    // 데이터가 보인다 -- 다만 그것은 "프로세스 재시작을 견딘다"는 뜻이 아니다
    // (아래 테스트 참고).
    async newInstance() {
      return createMemoryAutobookStore();
    },
  },
});

test("[memory] 프로세스 재시작을 견디지 못한다는 사실 자체를 고정한다", async () => {
  // PostgreSQL 저장소가 필요한 이유가 이것이다. 메모리 저장소를 운영에
  // 쓰면 Serverless 인스턴스가 바뀌는 순간 감시 작업이 사라진다.
  // resetMemoryAutobookStore() 는 프로세스 재시작과 같은 상태를 만든다.
  const store = createMemoryAutobookStore();
  await store.createJob(makeJob({ id: "restart-1", dedupeKey: "d-r", reservationIdempotencyKey: "i-r" }));
  assert.ok(await store.getJob("restart-1"));

  resetMemoryAutobookStore();

  const afterRestart = createMemoryAutobookStore();
  assert.equal(
    await afterRestart.getJob("restart-1"),
    null,
    "메모리 저장소가 재시작을 견딘다면 이 테스트의 전제가 틀린 것이다",
  );
});
