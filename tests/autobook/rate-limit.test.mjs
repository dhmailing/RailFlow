// lib/autobook/rate-limit.ts 경계값.
//
// T4. 이 모듈은 직접 테스트가 없었다 — 기존 테스트가 건드리는 nextCheckAt 은
// 작업의 **필드**이고, 여기 있는 함수들이 아니다.
//
// 경계가 세 곳에 있다.
//  1. nextCheckAt(): consecutiveFailures 가 0 / 1 / 한도-1 / 한도 / 한도+1
//     에서 무엇을 돌려주는가. 특히 "한도"에서 null 이 아니어야 한다(> 비교).
//  2. retryAfterToNextCheck(): Provider 가 알려준 값이 최소 간격 아래로
//     내려가지 않는가.
//  3. 창 경계: 계산된 nextCheckAt 직전·그 시각·직후에 작업이 집히는가.
//     판정은 memory-store 의 isClaimable 에 있는 `nextCheckAt > now` 다.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";
import { makeJob } from "./store-conformance.mjs";

const { loadTs } = loader;
const { getRateLimitPolicy, nextCheckAt, retryAfterToNextCheck } = loadTs("lib/autobook/rate-limit.ts");

const FIXED_NOW = Date.parse("2026-10-06T00:00:00.000Z");
const at = (seconds) => new Date(FIXED_NOW + seconds * 1000).toISOString();

// --- 정책 선택 -------------------------------------------------------------

test("Provider 이름별 정책을 돌려준다", () => {
  assert.equal(getRateLimitPolicy("mock-server").minIntervalSeconds, 1);
  assert.equal(getRateLimitPolicy("official-approved (stub)").minIntervalSeconds, 60);
  assert.equal(getRateLimitPolicy("unavailable").minIntervalSeconds, 3600);
});

test("모르는 Provider 는 보수적인 기본값으로 떨어진다", () => {
  const fallback = getRateLimitPolicy("무언가-새로운-provider");
  assert.equal(fallback.minIntervalSeconds, 300);
  assert.equal(fallback.basis, "conservative_default");
  // 모르는 이름이 Mock 의 1초를 물려받으면 실수로 폭주한다.
  assert.notEqual(fallback.minIntervalSeconds, getRateLimitPolicy("mock-server").minIntervalSeconds);
});

test("모든 정책이 최소 불변식을 지킨다", () => {
  const names = ["mock-server", "official-approved (stub)", "unavailable", "알 수 없는 이름"];
  for (const name of names) {
    const policy = getRateLimitPolicy(name);
    assert.ok(policy.minIntervalSeconds >= 1, `${name}: 최소 간격이 1초 미만이다`);
    assert.ok(policy.backoffSeconds.length >= 1, `${name}: 백오프 단계가 없다`);
    assert.ok(policy.maxConsecutiveFailures >= 1, `${name}: 실패 허용 횟수가 0이다`);
    // 백오프는 줄어들지 않아야 한다.
    for (let i = 1; i < policy.backoffSeconds.length; i += 1) {
      assert.ok(
        policy.backoffSeconds[i] >= policy.backoffSeconds[i - 1],
        `${name}: 백오프가 역주행한다 (${policy.backoffSeconds.join(",")})`,
      );
    }
    // 상한 없는 재시도를 막는 것이 이 모듈의 목적이다.
    assert.ok(Number.isFinite(policy.backoffSeconds.at(-1)), `${name}: 백오프 상한이 유한하지 않다`);
  }
});

test("반환된 정책은 완전히 불변이다(F3 수정 검증)", () => {
  // T9. 이전에는 POLICIES 가 **얕은** freeze 여서, getRateLimitPolicy 가 돌려준
  // 공유 참조를 호출자가 고치면 프로세스 전체의 요청 제한이 영구히 바뀌었다
  // (최소 간격을 1초로 낮추는 것까지 가능했다). 지금은 정책 객체와
  // backoffSeconds 배열까지 freeze 한다.
  //
  // 사본을 돌려주지 않는다 -- 완전히 불변이면 공유 참조로 충분하다.
  //
  // **이 테스트를 지우지 말고 뒤집어라.** 성능 때문에 freeze 를 빼고 싶어지면,
  // 그 전에 호출자 전부가 읽기만 한다는 것을 증명해야 한다.
  const first = getRateLimitPolicy("unavailable");
  assert.equal(Object.isFrozen(first), true, "정책 객체가 freeze 되지 않았다");
  assert.equal(Object.isFrozen(first.backoffSeconds), true, "backoffSeconds 배열이 freeze 되지 않았다");
  assert.equal(first, getRateLimitPolicy("unavailable"), "불필요하게 사본을 만든다");

  // 변경 시도는 조용히 무시되거나 던진다. 어느 쪽이든 정책은 그대로여야 한다.
  for (const mutate of [
    () => { first.minIntervalSeconds = 1; },
    () => { first.maxConsecutiveFailures = 999; },
    () => { first.basis = "official_documented"; },
    () => { first.backoffSeconds[0] = 1; },
    () => { first.backoffSeconds.push(1); },
    () => { delete first.minIntervalSeconds; },
    () => { Object.assign(first, { minIntervalSeconds: 1 }); },
  ]) {
    try {
      mutate();
    } catch {
      // strict mode 에서는 TypeError 가 난다. 그것도 통과다.
    }
  }

  const after = getRateLimitPolicy("unavailable");
  assert.equal(after.minIntervalSeconds, 3600, "최소 간격이 변조됐다 — 요청 폭주로 이어진다");
  assert.equal(after.maxConsecutiveFailures, 1, "연속 실패 상한이 변조됐다");
  assert.equal(after.basis, "conservative_default", "근거 표시가 변조됐다");
  assert.deepEqual([...after.backoffSeconds], [3600], "backoffSeconds 가 변조됐다");
});

test("확인되지 않은 Provider 의 기본 정책도 불변이다", () => {
  const fallback = getRateLimitPolicy("알 수 없는 provider");
  assert.equal(Object.isFrozen(fallback), true, "FALLBACK 이 freeze 되지 않았다");
  assert.equal(Object.isFrozen(fallback.backoffSeconds), true, "FALLBACK 배열이 freeze 되지 않았다");
  try {
    fallback.minIntervalSeconds = 1;
  } catch {
    /* 무시 */
  }
  assert.equal(getRateLimitPolicy("알 수 없는 provider").minIntervalSeconds, 300, "기본 정책이 변조됐다");
});

test("모든 정책이 빠짐없이 불변이다", () => {
  for (const name of ["mock-server", "official-approved (stub)", "unavailable", "없는-이름"]) {
    const policy = getRateLimitPolicy(name);
    assert.equal(Object.isFrozen(policy), true, `${name}: 정책이 freeze 되지 않았다`);
    assert.equal(Object.isFrozen(policy.backoffSeconds), true, `${name}: backoffSeconds 가 freeze 되지 않았다`);
  }
});

test("앞 테스트가 정책을 오염시키지 않았다(실행 순서 독립성)", () => {
  // 위 테스트는 공유 정책 객체를 일부러 변조한다. finally 로 되돌리지만,
  // 되돌리기가 빠지거나 try 블록이 중간에 터지면 이후 테스트가 조용히
  // 오염된 값을 본다. 그 회귀를 여기서 잡는다.
  const policy = getRateLimitPolicy("unavailable");
  assert.equal(policy.minIntervalSeconds, 3600, "앞 테스트의 변조가 남아 있다");
  assert.deepEqual(policy.backoffSeconds, [3600], "backoffSeconds 가 오염됐다");
  assert.equal(policy.maxConsecutiveFailures, 1);
  // 다른 정책도 함께 본다.
  assert.equal(getRateLimitPolicy("mock-server").minIntervalSeconds, 1);
  assert.equal(getRateLimitPolicy("official-approved (stub)").minIntervalSeconds, 60);
});

// --- nextCheckAt 경계값 ---------------------------------------------------

const policy = {
  minIntervalSeconds: 10,
  backoffSeconds: [100, 200, 400],
  maxConsecutiveFailures: 5,
  basis: "conservative_default",
};

test("실패가 없으면 최소 간격만 띄운다", () => {
  assert.equal(nextCheckAt(policy, 0, FIXED_NOW), at(10));
});

test("실패 횟수가 음수여도 최소 간격으로 처리한다", () => {
  assert.equal(nextCheckAt(policy, -1, FIXED_NOW), at(10));
  assert.equal(nextCheckAt(policy, -100, FIXED_NOW), at(10));
});

test("첫 실패는 백오프 1단계를 쓴다(0단계가 아니다)", () => {
  // index = failures - 1 이므로 1회 실패 -> backoffSeconds[0].
  assert.equal(nextCheckAt(policy, 1, FIXED_NOW), at(100));
  assert.notEqual(nextCheckAt(policy, 1, FIXED_NOW), at(10), "실패인데 최소 간격만 띄웠다");
});

test("백오프 단계가 실패 횟수를 따라 올라간다", () => {
  assert.equal(nextCheckAt(policy, 2, FIXED_NOW), at(200));
  assert.equal(nextCheckAt(policy, 3, FIXED_NOW), at(400));
});

test("백오프 단계를 다 쓰면 마지막 값에서 멈춘다", () => {
  // 단계가 3개인데 실패는 4·5회 -> 마지막 값(400)으로 고정.
  assert.equal(nextCheckAt(policy, 4, FIXED_NOW), at(400));
  assert.equal(nextCheckAt(policy, 5, FIXED_NOW), at(400));
});

test("한도 -1 / 한도 / 한도 +1", () => {
  const max = policy.maxConsecutiveFailures; // 5
  // 한도 -1: 아직 진행한다.
  assert.ok(nextCheckAt(policy, max - 1, FIXED_NOW), `한도-1(${max - 1})에서 멈췄다`);
  // 한도: **여기서도 아직 진행한다.** `>` 가 `>=` 로 바뀌면 여기서 null 이 된다.
  assert.ok(nextCheckAt(policy, max, FIXED_NOW), `한도(${max})에서 멈췄다 — 비교가 >= 로 바뀌었나`);
  assert.equal(nextCheckAt(policy, max, FIXED_NOW), at(400));
  // 한도 +1: 중단한다.
  assert.equal(nextCheckAt(policy, max + 1, FIXED_NOW), null, `한도+1(${max + 1})에서 멈추지 않았다`);
  assert.equal(nextCheckAt(policy, max + 100, FIXED_NOW), null);
});

test("단계가 하나뿐인 정책도 한도에서만 멈춘다", () => {
  const single = { ...policy, backoffSeconds: [50], maxConsecutiveFailures: 1 };
  assert.equal(nextCheckAt(single, 1, FIXED_NOW), at(50));
  assert.equal(nextCheckAt(single, 2, FIXED_NOW), null);
});

test("now 를 넘기지 않으면 현재 시각을 기준으로 삼는다", () => {
  const before = Date.now();
  const iso = nextCheckAt(policy, 0);
  const after = Date.now();
  const value = Date.parse(iso);
  assert.ok(value >= before + 10_000 && value <= after + 10_000, `기준 시각이 어긋났다: ${iso}`);
});

// --- retryAfterToNextCheck 경계값 -----------------------------------------

test("Provider 가 알려준 값이 최소 간격보다 작으면 최소 간격을 쓴다", () => {
  assert.equal(retryAfterToNextCheck(policy, 9, FIXED_NOW), at(10));
  assert.equal(retryAfterToNextCheck(policy, 1, FIXED_NOW), at(10));
});

test("최소 간격과 같으면 그대로 쓴다", () => {
  assert.equal(retryAfterToNextCheck(policy, 10, FIXED_NOW), at(10));
});

test("최소 간격보다 크면 알려준 값을 존중한다", () => {
  assert.equal(retryAfterToNextCheck(policy, 11, FIXED_NOW), at(11));
  assert.equal(retryAfterToNextCheck(policy, 3600, FIXED_NOW), at(3600));
});

test("0·음수·NaN·소수도 최소 간격 아래로 내려가지 않는다", () => {
  for (const value of [0, -1, -3600, Number.NaN, 0.9, 9.9]) {
    const iso = retryAfterToNextCheck(policy, value, FIXED_NOW);
    assert.ok(
      Date.parse(iso) >= FIXED_NOW + policy.minIntervalSeconds * 1000,
      `retryAfter=${value} 가 최소 간격 아래로 내려갔다: ${iso}`,
    );
  }
});

test("소수는 내림한 뒤 최소 간격과 비교한다", () => {
  assert.equal(retryAfterToNextCheck(policy, 11.9, FIXED_NOW), at(11));
});

// --- 창 경계: 계산한 시각 직전·그 시각·직후 ------------------------------

test("창 경계 직전·그 시각·직후에 작업이 집히는지", async () => {
  const { createMemoryAutobookStore, resetMemoryAutobookStore } = loadTs("lib/autobook/memory-store.ts");

  // rate-limit 가 계산한 값을 그대로 작업에 넣는다.
  const scheduled = nextCheckAt(policy, 0, FIXED_NOW); // FIXED_NOW + 10초
  const scheduledMs = Date.parse(scheduled);

  const tryClaimAt = async (nowMs) => {
    resetMemoryAutobookStore();
    const store = createMemoryAutobookStore();
    await store.createJob(makeJob({ id: "job-window", nextCheckAt: scheduled }));
    return store.claimNext({ workerId: "w-1", now: new Date(nowMs).toISOString(), leaseMs: 30_000 });
  };

  // 1ms 전 — 아직 집으면 안 된다.
  assert.equal(await tryClaimAt(scheduledMs - 1), null, "예정 시각 1ms 전인데 집었다");
  // 정확히 그 시각 — 집혀야 한다(판정이 `>` 이므로 같으면 통과).
  assert.ok(await tryClaimAt(scheduledMs), "예정 시각에 집지 못했다 — 비교가 >= 로 바뀌었나");
  // 1ms 후 — 집혀야 한다.
  assert.ok(await tryClaimAt(scheduledMs + 1), "예정 시각 1ms 후에 집지 못했다");
});

test("백오프로 밀린 시각도 같은 창 경계를 따른다", async () => {
  const { createMemoryAutobookStore, resetMemoryAutobookStore } = loadTs("lib/autobook/memory-store.ts");

  const scheduled = nextCheckAt(policy, 3, FIXED_NOW); // FIXED_NOW + 400초
  const scheduledMs = Date.parse(scheduled);
  assert.equal(scheduled, at(400));

  const tryClaimAt = async (nowMs) => {
    resetMemoryAutobookStore();
    const store = createMemoryAutobookStore();
    await store.createJob(makeJob({ id: "job-backoff", nextCheckAt: scheduled }));
    return store.claimNext({ workerId: "w-1", now: new Date(nowMs).toISOString(), leaseMs: 30_000 });
  };

  assert.equal(await tryClaimAt(scheduledMs - 1), null, "백오프 시각 1ms 전인데 집었다");
  assert.ok(await tryClaimAt(scheduledMs), "백오프 시각에 집지 못했다");
});
