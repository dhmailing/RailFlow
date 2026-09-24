import assert from "node:assert/strict";
import test from "node:test";

import {
  maskPersonName,
  maskReservationNumber,
  redactText,
  redactValue,
  safeScreenText,
} from "../../agent/src/redact.mjs";

test("쿠키·토큰·비밀번호는 값이 남지 않는다", () => {
  const out = redactText("Cookie: JSESSIONID=ABC123DEF; password=hunter2; authorization=Bearer xyz");
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("Bearer xyz"));
  assert.ok(out.includes("[REDACTED]"));
});

test("연락처·이메일·주민번호·카드번호는 지운다", () => {
  const out = redactText("홍길동 010-1234-5678 hong@example.com 900101-1234567 4111 1111 1111 1111");
  assert.ok(!out.includes("010-1234-5678"));
  assert.ok(!out.includes("hong@example.com"));
  assert.ok(!out.includes("900101-1234567"));
  assert.ok(!out.includes("4111"));
});

test("객체의 민감한 키는 값을 통째로 가린다", () => {
  const out = redactValue({
    password: "hunter2",
    cookie: "a=b",
    sessionToken: "zzz",
    passengerName: "홍길동",
    reservationNumber: "SRT12345678",
    trainNumber: "SRT 305",
  });
  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.cookie, "[REDACTED]");
  assert.equal(out.sessionToken, "[REDACTED]");
  assert.equal(out.passengerName, "홍**");
  // 예약번호는 뒤 3자리만 남는다 -- 화면과 대조는 되지만 원문은 남지 않는다.
  assert.equal(out.reservationNumber.endsWith("678"), true);
  assert.equal(out.reservationNumber.includes("SRT12345"), false);
  // 개인정보가 아닌 값은 그대로 둔다.
  assert.equal(out.trainNumber, "SRT 305");
});

test("마스킹 도우미", () => {
  assert.equal(maskReservationNumber("ABCDEF123"), "******123");
  assert.equal(maskReservationNumber("12"), "**");
  assert.equal(maskPersonName("김철수"), "김**");
});

test("화면 문구는 길이를 제한하고 개인정보를 지운다", () => {
  const long = `예약자 010-9999-8888 ${"가".repeat(300)}`;
  const out = safeScreenText(long);
  assert.ok(out.length <= 121);
  assert.ok(!out.includes("010-9999-8888"));
});

test("중첩 객체와 배열도 재귀적으로 처리한다", () => {
  const out = redactValue({ rows: [{ note: "pwd=abcd1234" }], nested: { cookie: "x" } });
  assert.ok(!JSON.stringify(out).includes("abcd1234"));
  assert.equal(out.nested.cookie, "[REDACTED]");
});
