import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransition,
  assertTransition,
  isTerminal,
  resolveUserStopTarget,
} from "../../agent/src/machine.mjs";
import { JobState, RunMode } from "../../agent/src/status.mjs";

test("읽기 전용 모드에서는 예약 단계로 갈 수 없다", () => {
  assert.equal(canTransition(JobState.SEAT_FOUND, JobState.RESERVING, RunMode.LIVE_READ_ONLY), false);
  assert.equal(
    canTransition(JobState.AWAITING_ARM_CONFIRMATION, JobState.RESERVING, RunMode.LIVE_READ_ONLY),
    false,
  );
  assert.throws(
    () => assertTransition(JobState.SEAT_FOUND, JobState.RESERVING, RunMode.LIVE_READ_ONLY),
    /허용되지 않는 상태 전이/,
  );
});

test("승인된 모드에서만 예약 단계가 열린다", () => {
  assert.equal(
    canTransition(JobState.SEAT_FOUND, JobState.RESERVING, RunMode.LIVE_RESERVATION_ARMED),
    true,
  );
  assert.equal(
    canTransition(JobState.AWAITING_ARM_CONFIRMATION, JobState.RESERVING, RunMode.LIVE_RESERVATION_ARMED),
    true,
  );
});

test("중단 상태는 활성 상태 어디서든 도달할 수 있다", () => {
  const active = [
    JobState.LAUNCHING_BROWSER,
    JobState.WAITING_MANUAL_LOGIN,
    JobState.CONNECTED,
    JobState.SEARCHING_TRAIN,
    JobState.TRAIN_CONFIRMED,
    JobState.WATCHING_SOLD_OUT,
    JobState.SEAT_FOUND,
    JobState.RESERVING,
    JobState.VERIFYING_RESERVATION,
  ];
  for (const from of active) {
    for (const to of [
      JobState.AUTH_REQUIRED,
      JobState.ADDITIONAL_VERIFICATION_REQUIRED,
      JobState.QUEUE_OR_ACCESS_RESTRICTED,
      JobState.PROVIDER_CHANGED,
      JobState.FAILED,
    ]) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to} 가 막혀 있다`);
    }
  }
});

test("종료 상태에서는 어떤 전이도 일어나지 않는다", () => {
  for (const state of [
    JobState.RESERVED_PAYMENT_REQUIRED,
    JobState.STOPPED_BY_USER,
    JobState.RECONCILIATION_REQUIRED,
    JobState.RESULT_UNCERTAIN_USER_CHECK_REQUIRED,
    JobState.FAILED,
  ]) {
    assert.equal(isTerminal(state), true);
    assert.equal(canTransition(state, JobState.WATCHING_SOLD_OUT), false);
    assert.equal(canTransition(state, JobState.FAILED), false);
  }
});

test("예약 요청을 누른 뒤 중단하면 곧바로 '중단'이 아니라 결과 확인으로 간다", () => {
  assert.equal(resolveUserStopTarget(JobState.RESERVING), JobState.VERIFYING_RESERVATION);
  assert.equal(resolveUserStopTarget(JobState.VERIFYING_RESERVATION), JobState.VERIFYING_RESERVATION);
  // 아직 누르기 전이라면 그냥 중단이다.
  assert.equal(resolveUserStopTarget(JobState.WATCHING_SOLD_OUT), JobState.STOPPED_BY_USER);
  // 이미 끝난 작업은 그대로 둔다.
  assert.equal(
    resolveUserStopTarget(JobState.RESERVED_PAYMENT_REQUIRED),
    JobState.RESERVED_PAYMENT_REQUIRED,
  );
});
