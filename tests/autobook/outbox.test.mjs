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

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0, sentUnrecorded: 0 });
  assert.equal(channel.sent.length, 0);
});

// --- 재시도 경로 (핵심 공백) ----------------------------------------------

test("실패한 알림을 다음 차례에 다시 집어 보낸다", async () => {
  const store = await seed();
  const channel = flakyChannel(1); // 첫 번째만 실패

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 1, sentUnrecorded: 0 });
  assert.equal(channel.sent.length, 0, "실패했는데 보낸 것으로 기록됐다");

  // 두 번째 차례 — 같은 알림을 다시 집어야 한다.
  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0, sentUnrecorded: 0 });
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
    assert.deepEqual(result, { sent: 0, failed: 1, sentUnrecorded: 0 });
    const [notification] = await store.listNotifications(JOB_ID);
    assert.equal(notification.failedAttempts, expected, `${expected}회차 누적이 틀렸다`);
    assert.equal(notification.claimedBy, null, "실패 후 claim 이 풀리지 않았다");
  }
  assert.equal(channel.attempts, 3);
});

test("채널이 동기적으로 throw 해도 같게 처리된다", async () => {
  const store = await seed();
  const channel = failingChannel({ sync: true });

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 1, sentUnrecorded: 0 });
  const [notification] = await store.listNotifications(JOB_ID);
  assert.equal(notification.failedAttempts, 1);
  assert.equal(notification.sentAt, null);
});

// --- 중복 전송 방지 --------------------------------------------------------

test("이미 보낸 알림은 다시 집지 않는다", async () => {
  const store = await seed();
  const channel = createInMemoryChannel();

  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0, sentUnrecorded: 0 });
  // 두 번째 호출은 집을 것이 없어야 한다.
  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0, sentUnrecorded: 0 });
  assert.equal(channel.sent.length, 1, "같은 알림을 두 번 보냈다");
});

test("보낸 알림은 claim 이 풀려도 다시 집히지 않는다", async () => {
  // 위 테스트만으로는 부족하다. 전송 성공 뒤에도 claimedBy 가 남아 있어서
  // "claim 이 있으면 건너뛴다" 규칙만으로 재전송이 막힐 수 있다. 그래서
  // claim 을 직접 풀고, sentAt 기준의 방어가 실제로 동작하는지 확인한다.
  const store = await seed();
  const channel = createInMemoryChannel();

  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0, sentUnrecorded: 0 });
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

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0, sentUnrecorded: 0 });
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

  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0, sentUnrecorded: 0 });
  assert.equal(channel.sent.length, 1, "한 번에 두 건을 보냈다");

  assert.deepEqual(await flush(store, channel), { sent: 1, failed: 0, sentUnrecorded: 0 });
  assert.equal(channel.sent.length, 2);

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0, sentUnrecorded: 0 });
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

  assert.deepEqual(await flush(store, channel), { sent: 0, failed: 0, sentUnrecorded: 0 });
  assert.equal(channel.sent.length, 0, "다른 Worker 의 알림을 보냈다");
});

// --- 보낸 뒤 기록이 실패하는 창 (T8 에서 닫았다) -------------------------

/** markNotificationSent 를 n 번째 호출까지 실패시키는 store 래퍼. */
function recordFailingStore(inner, failTimes) {
  let calls = 0;
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "markNotificationSent" || typeof value !== "function") return value;
      return async (...args) => {
        calls += 1;
        if (calls <= failTimes) throw new Error("상태 기록 실패(일시 오류)");
        return value.apply(target, args);
      };
    },
  });
  return { store: proxy, get calls() { return calls; } };
}

test("보낸 뒤 sent 기록이 끝까지 실패하면 다시 보내지 않고 sentUnrecorded 로 끝난다", async () => {
  // T8 이전에는 channel.send 와 markNotificationSent 가 같은 try 안에 있어서,
  // 전송은 성공했는데 기록이 실패하면 알림이 미전송으로 남고 다음 차례에
  // **같은 알림을 다시 보냈다**(중복 전송 창). 지금은 둘을 분리하고, 기록
  // 실패를 전송 실패로 세지 않으며, claim 을 놓지 않아 재전송을 막는다.
  const inner = await seed();
  const wrapped = recordFailingStore(inner, Number.POSITIVE_INFINITY);
  const channel = createInMemoryChannel();

  // 1회차: 보냈지만 기록은 끝까지 실패 -> failed 가 아니라 sentUnrecorded.
  assert.deepEqual(await flush(wrapped.store, channel), { sent: 0, failed: 0, sentUnrecorded: 1 });
  assert.equal(channel.sent.length, 1, "실제로는 보냈어야 한다");

  const [afterFirst] = await inner.listNotifications(JOB_ID);
  assert.equal(afterFirst.sentAt, null, "기록이 실패했는데 sent 로 남았다");
  assert.equal(afterFirst.failedAttempts, 0, "기록 실패가 전송 실패로 집계됐다");
  assert.equal(afterFirst.claimedBy, "w1", "claim 을 놓아서 다음 차례에 다시 집힌다");

  // 2회차: claim 이 남아 있으므로 집히지 않는다 -> 중복 전송이 없다.
  assert.deepEqual(await flush(inner, channel), { sent: 0, failed: 0, sentUnrecorded: 0 });
  assert.equal(channel.sent.length, 1, "같은 알림을 두 번 보냈다 — 중복 전송 창이 살아 있다");
});

test("기록 재시도는 유한하다", async () => {
  // 무제한 재시도는 Worker 한 턴을 붙잡는다. 상한을 넘기면 포기한다.
  const inner = await seed();
  const wrapped = recordFailingStore(inner, Number.POSITIVE_INFINITY);

  await flush(wrapped.store, createInMemoryChannel());
  assert.ok(wrapped.calls >= 2, `재시도가 아예 없다(호출 ${wrapped.calls}회)`);
  assert.ok(wrapped.calls <= 5, `기록 재시도가 ${wrapped.calls}회 — 상한이 없다`);
});

test("기록이 재시도에서 성공하면 정상 전송으로 끝난다", async () => {
  const inner = await seed();
  const wrapped = recordFailingStore(inner, 1);
  const channel = createInMemoryChannel();

  assert.deepEqual(await flush(wrapped.store, channel), { sent: 1, failed: 0, sentUnrecorded: 0 });
  assert.equal(channel.sent.length, 1, "재시도 때문에 두 번 보냈다");
  const [notification] = await inner.listNotifications(JOB_ID);
  assert.ok(notification.sentAt, "기록이 성공했는데 sent 로 남지 않았다");
});

test("채널은 멱등키로 중복 전송을 억제한다", async () => {
  // 기록 실패는 막을 수 있지만, 채널이 예외를 던졌는데 실제로는 전달된
  // 경우는 Outbox 쪽에서 알 수 없다. 마지막 방어선은 채널의 멱등 처리다.
  const channel = createInMemoryChannel();
  const notification = buildNotification({ job: makeJob(), kind: "SEAT_HELD", id: "n1" });

  await channel.send(notification, { idempotencyKey: notification.idempotencyKey });
  await channel.send(notification, { idempotencyKey: notification.idempotencyKey });

  assert.equal(channel.sent.length, 1, "채널이 같은 멱등키를 두 번 전달했다");
  assert.equal(channel.suppressed.length, 1, "억제된 전송이 기록되지 않았다");
});

test("채널은 멱등키를 context 로도 받는다", async () => {
  const seen = [];
  const channel = {
    name: "spy",
    async send(notification, context) {
      seen.push({ fromNotification: notification.idempotencyKey, fromContext: context?.idempotencyKey });
    },
  };
  const store = await seed();

  await flush(store, channel);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].fromContext, "채널이 멱등키를 context 로 받지 못했다");
  assert.equal(seen[0].fromContext, seen[0].fromNotification, "context 의 멱등키가 알림과 다르다");
});
