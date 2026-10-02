// lib/autobook/outbox.ts 의 flushOutboxOnce — 전송 실패·재시도 경로.
//
// T3. safety.test.mjs 가 이미 다루는 것(큐 멱등, 보낸 뒤에만 sent 표시,
// 1회 실패 후 claim 해제, payload 에 자격증명 없음)은 반복하지 않는다.
// 여기서 채우는 공백은 **실패 다음에 무엇이 일어나는가**다.
//  - 실패한 알림을 다음 차례에 실제로 다시 집어 보내는가
//  - 연속 실패에서 failedAttempts 가 누적되는가
//  - 이미 보낸 알림을 두 번 보내지 않는가
//  - 한 번 호출이 몇 건을 처리하는가
//  - 다른 Worker 가 집은 알림을 가져가지 않는가
//  - 보낸 뒤 상태 기록이 실패하면 어떻게 되는가(중복 전송 창)

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";

const { loadTs } = loader;
const { buildNotification, createInMemoryChannel, flushOutboxOnce } = loadTs("lib/autobook/outbox.ts");
const { createMemoryAutobookStore, resetMemoryAutobookStore } = loadTs("lib/autobook/memory-store.ts");

const JOB_ID = "job-outbox";

function makeJob(over = {}) {
  return {
    id: JOB_ID,
    userId: "user-1",
    status: "RESERVATION_HELD",
    condition: {
      departure: "동탄",
      arrival: "울산(통도사)",
      date: "2026-10-10",
      passengers: 1,
      seatClass: "any",
      timeFrom: null,
      timeTo: null,
    },
    candidates: [],
    providerName: "mock-server",
    simulation: true,
    dedupeKey: "d-outbox",
    reservationIdempotencyKey: "i-outbox",
    hold: {
      reservationRef: "SIM-AAAA1111",
      trainNumber: "T101",
      departAt: "08:05",
      seatClass: "standard",
      paymentDueAt: "2026-10-10T09:00:00+09:00",
    },
    statusDetail: null,
    attempts: 0,
    nextCheckAt: null,
    expiresAt: "2026-10-10T23:59:00+09:00",
    createdAt: "2026-10-01T00:00:00+09:00",
    updatedAt: "2026-10-01T00:00:00+09:00",
    claim: null,
    ...over,
  };
}

/** 항상 실패하는 채널. reject 와 동기 throw 를 구분해서 만들 수 있다. */
function failingChannel({ sync = false } = {}) {
  let attempts = 0;
  return {
    name: "failing",
    get attempts() {
      return attempts;
    },
    send() {
      attempts += 1;
      if (sync) throw new Error("동기 오류");
      return Promise.reject(new Error("네트워크 오류"));
    },
  };
}

/** n 번째 호출까지 실패하고 그 뒤 성공하는 채널. */
function flakyChannel(failTimes) {
  const sent = [];
  let attempts = 0;
  return {
    name: "flaky",
    sent,
    get attempts() {
      return attempts;
    },
    async send(notification) {
      attempts += 1;
      if (attempts <= failTimes) throw new Error("일시 오류");
      sent.push(notification);
    },
  };
}

async function seed(id = "n1", kind = "SEAT_HELD") {
  resetMemoryAutobookStore();
  const store = createMemoryAutobookStore();
  await store.enqueueNotification(buildNotification({ job: makeJob(), kind, id }));
  return store;
}

const flush = (store, channel, over = {}) =>
  flushOutboxOnce({ store, channel, workerId: "w1", fencingToken: 1, ...over });

// --- 빈 Outbox -------------------------------------------------------------

test("보낼 알림이 없으면 아무 것도 세지 않는다", async () => {
  resetMemoryAutobookStore();
  const store = createMemoryAutobookStore();
  const channel = createInMemoryChannel();

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0 });
  assert.equal(channel.sent.length, 0);
});

// --- 재시도 경로 (핵심 공백) ----------------------------------------------

test("실패한 알림을 다음 차례에 다시 집어 보낸다", async () => {
  const store = await seed();
  const channel = flakyChannel(1); // 첫 번째만 실패

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 1 });
  assert.equal(channel.sent.length, 0, "실패했는데 보낸 것으로 기록됐다");

  // 두 번째 차례 — 같은 알림을 다시 집어야 한다.
  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0 });
  assert.equal(channel.attempts, 2, `재시도가 일어나지 않았다(시도 ${channel.attempts}회)`);
  assert.equal(channel.sent.length, 1);

  const [notification] = await store.listNotifications(JOB_ID);
  assert.ok(notification.sentAt, "성공했는데 sentAt 이 비어 있다");
  assert.equal(notification.failedAttempts, 1, "실패 기록이 사라졌다");
  assert.equal(notification.claimedBy, "w1");
});

test("연속 실패에서 failedAttempts 가 누적된다", async () => {
  const store = await seed();
  const channel = failingChannel();

  for (const expected of [1, 2, 3]) {
    const result = await flush(store, channel);
    assert.deepEqual(result, { sent: 0, failed: 1 });
    const [notification] = await store.listNotifications(JOB_ID);
    assert.equal(notification.failedAttempts, expected, `${expected}회차 누적이 틀렸다`);
    assert.equal(notification.claimedBy, null, "실패 후 claim 이 풀리지 않았다");
  }
  assert.equal(channel.attempts, 3);
});

test("채널이 동기적으로 throw 해도 같게 처리된다", async () => {
  const store = await seed();
  const channel = failingChannel({ sync: true });

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 1 });
  const [notification] = await store.listNotifications(JOB_ID);
  assert.equal(notification.failedAttempts, 1);
  assert.equal(notification.sentAt, null);
});

// --- 중복 전송 방지 --------------------------------------------------------

test("이미 보낸 알림은 다시 집지 않는다", async () => {
  const store = await seed();
  const channel = createInMemoryChannel();

  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0 });
  // 두 번째 호출은 집을 것이 없어야 한다.
  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0 });
  assert.equal(channel.sent.length, 1, "같은 알림을 두 번 보냈다");
});

test("보낸 알림은 claim 이 풀려도 다시 집히지 않는다", async () => {
  // 위 테스트만으로는 부족하다. 전송 성공 뒤에도 claimedBy 가 남아 있어서
  // "claim 이 있으면 건너뛴다" 규칙만으로 재전송이 막힐 수 있다. 그래서
  // claim 을 직접 풀고, sentAt 기준의 방어가 실제로 동작하는지 확인한다.
  const store = await seed();
  const channel = createInMemoryChannel();

  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0 });
  const [sentOne] = await store.listNotifications(JOB_ID);
  assert.ok(sentOne.sentAt);

  // claim 만 떼어 낸다(Worker 가 죽고 lease 가 풀린 상황 상당).
  const released = await store.claimNotification({
    workerId: "w1",
    fencingToken: 1,
    now: new Date().toISOString(),
  });
  assert.equal(released, null, "보낸 알림이 다시 집혔다");
  await store.markNotificationFailed({ id: sentOne.id, workerId: "w1", fencingToken: 1 });

  // 이제 claimedBy 가 null 이다. 그래도 다시 집히면 안 된다.
  const afterRelease = (await store.listNotifications(JOB_ID))[0];
  assert.equal(afterRelease.claimedBy, null, "준비 단계에서 claim 이 풀리지 않았다");
  assert.ok(afterRelease.sentAt, "sentAt 이 사라졌다");

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0 });
  assert.equal(channel.sent.length, 1, "claim 이 풀린 뒤 이미 보낸 알림을 또 보냈다");
});

test("한 번 호출은 한 건만 처리한다", async () => {
  resetMemoryAutobookStore();
  const store = createMemoryAutobookStore();
  const channel = createInMemoryChannel();
  await store.enqueueNotification(buildNotification({ job: makeJob(), kind: "SEAT_HELD", id: "n1" }));
  await store.enqueueNotification(
    buildNotification({ job: makeJob({ status: "EXPIRED" }), kind: "EXPIRED", id: "n2" }),
  );

  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0 });
  assert.equal(channel.sent.length, 1, "한 번에 두 건을 보냈다");

  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0 });
  assert.equal(channel.sent.length, 2);

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0 });
});

test("다른 Worker 가 집은 알림은 가져가지 않는다", async () => {
  const store = await seed();
  const channel = createInMemoryChannel();

  const claimed = await store.claimNotification({
    workerId: "other",
    fencingToken: 9,
    now: new Date().toISOString(),
  });
  assert.ok(claimed, "준비 단계에서 집지 못했다");

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0 });
  assert.equal(channel.sent.length, 0, "다른 Worker 의 알림을 보냈다");
});

// --- 보낸 뒤 기록이 실패하는 창 (동작 기록) -------------------------------

test("보낸 뒤 sent 기록이 실패하면 실패로 남고 다음 차례에 다시 보낸다", async () => {
  // flushOutboxOnce 의 try 가 channel.send 와 markNotificationSent 를 함께
  // 감싼다. 그래서 전송은 성공했는데 상태 기록이 실패하면 알림이 미전송으로
  // 남고, 다음 차례에 **같은 알림을 다시 보낸다**. 적어도 한 번 보내는 쪽을
  // 택한 설계이며, 중복 전송 창이 존재한다는 사실을 여기 고정해 둔다.
  const inner = await seed();
  let failRecordOnce = true;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "markNotificationSent" || typeof value !== "function") return value;
      return async (...args) => {
        if (failRecordOnce) {
          failRecordOnce = false;
          throw new Error("상태 기록 실패(일시 오류)");
        }
        return value.apply(target, args);
      };
    },
  });
  const channel = createInMemoryChannel();

  // 1회차: 보냈지만 기록 실패 -> failed 로 집계된다.
  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 1 });
  assert.equal(channel.sent.length, 1, "실제로는 보냈어야 한다");

  const [afterFirst] = await inner.listNotifications(JOB_ID);
  assert.equal(afterFirst.sentAt, null, "기록이 실패했는데 sent 로 남았다");
  assert.equal(afterFirst.failedAttempts, 1);

  // 2회차: 같은 알림을 다시 보낸다 -> 중복 전송.
  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0 });
  assert.equal(channel.sent.length, 2, "중복 전송 창이 없어졌다면 이 테스트를 고쳐야 한다");
  const [afterSecond] = await inner.listNotifications(JOB_ID);
  assert.ok(afterSecond.sentAt);
});
