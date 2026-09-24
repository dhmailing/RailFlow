import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.RAILFLOW_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "railflow-agent-home-"));
process.env.RAILFLOW_AGENT_QUIET = "1";

const { assertProviderContract, REQUIRED_PROVIDER_METHODS } = await import(
  "../../agent/src/providers/provider-contract.mjs"
);
const { SEAT_STATUSES, JOB_STATES } = await import("../../agent/src/status.mjs");

function validProvider(over = {}) {
  const provider = { name: "live:테스트사업자@example.test", simulation: false, ...over };
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (!(method in provider)) provider[method] = async () => {};
  }
  return provider;
}

test("실제 Provider는 이름으로 Mock과 구분된다", () => {
  assert.equal(assertProviderContract(validProvider()), true);
  assert.throws(() => assertProviderContract(validProvider({ name: "mock-browser" })), /live:/);
  assert.throws(() => assertProviderContract(validProvider({ simulation: true })), /simulation=false/);
});

test("차단 우회·결제 자동화 기능이 있으면 Provider 로드를 거부한다", () => {
  for (const forbidden of ["solveCaptcha", "bypassQueue", "rotateProxy", "exportCookies", "autoPay"]) {
    assert.throws(
      () => assertProviderContract(validProvider({ [forbidden]: () => {} })),
      /허용되지 않는 기능/,
      `${forbidden} 가 통과됐다`,
    );
  }
});

test("필수 메서드가 없으면 거부한다", () => {
  const provider = validProvider();
  delete provider.verifyReservation;
  assert.throws(() => assertProviderContract(provider), /verifyReservation/);
});

test("Agent와 웹 UI의 상태 어휘가 서로 어긋나지 않는다", () => {
  // lib/live/agent-protocol.ts 는 TypeScript 라 여기서 실행할 수 없으므로
  // 원문에서 배열 리터럴을 읽어 비교한다.
  const source = fs.readFileSync(
    new URL("../../lib/live/agent-protocol.ts", import.meta.url),
    "utf8",
  );
  const listOf = (name) => {
    const block = source.split(`export const ${name} = [`)[1]?.split("] as const;")[0];
    assert.ok(block, `${name} 를 찾지 못했습니다`);
    return [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  };
  assert.deepEqual(listOf("SEAT_STATUSES"), [...SEAT_STATUSES]);
  assert.deepEqual(listOf("JOB_STATES"), [...JOB_STATES]);

  // 화면 라벨이 모든 상태에 대해 준비되어 있어야 한다.
  const labelBlock = source.split("JOB_STATE_LABEL: Record<LiveJobState, string> = {")[1].split("};")[0];
  for (const state of JOB_STATES) {
    assert.ok(labelBlock.includes(`${state}:`), `${state} 의 화면 라벨이 없다`);
  }
});
