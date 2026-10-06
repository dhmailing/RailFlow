// lib/autobook/account-link.ts — 안전 원칙 가드.
//
// T5. **이 파일은 기능 테스트가 아니라 안전장치다.** 여기 있는 단정이 깨지면
// 그것은 "테스트가 낡았다"는 뜻이 아니라 **지켜야 할 원칙이 무너졌다**는
// 뜻이다. 근거는 두 곳이다.
//
//  - CLAUDE.md 「현재 목표(v0.3)」 4번: "좌석 잔여·예약 기능은 공식·승인된
//    연동 방식이 확인된 뒤 별도 구현한다." 계정 연결은 그 연동의 전제이고,
//    공식 방식(OAuth / API credential / 단기 세션)은 어느 것도 확인되지
//    않았다(docs/V0.9-KORAIL-INTEGRATION-RESEARCH.md).
//  - CLAUDE.md 「개발 원칙」·「실제 연동에 대한 원칙 (v0.9) › 하지 않는 것」:
//    비밀번호·카드정보·OTP·쿠키를 요청하거나 저장하지 않는다.
//  - docs/adr/0003-abandon-browser-agent.md: 공식 예매 화면을 브라우저로
//    조작해 로그인 상태를 얻는 방식은 폐기됐다. 계정 연결을 켜는 것으로
//    그 경로를 되살리지 않는다.
//
// **나중에 계정 연결을 켜려는 사람에게:** 이 테스트를 고쳐서 통과시키지
// 말아라. 먼저 공식·승인된 연동 방식을 확보하고, 그 근거를 문서에 적고,
// CLAUDE.md 목표 4번을 개정한 뒤에 이 테스트를 **의도적으로 뒤집어라.**
// 테스트만 손보고 지나가면 비밀번호를 받지 않는다는 약속이 조용히 사라진다.

import assert from "node:assert/strict";
import test from "node:test";

import loader from "./load-ts.cjs";

const { loadTs } = loader;
const {
  METHOD_AVAILABILITY,
  accountLinkAvailability,
  createMemoryAccountLinkStore,
  resetAccountLinkStore,
} = loadTs("lib/autobook/account-link.ts");

const ALL_METHODS = ["official_oauth", "official_api_credential", "short_lived_session"];

/** 이 프로세스에서 나가는 외부 요청을 전부 센다. */
function countNetworkCalls(run) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(String(args[0]));
    throw new Error("테스트 중 외부 요청이 발생했다");
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
    })
    .then((value) => ({ value, calls }));
}

function withEnv(env, run) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

// --- A. 세 방식 모두 available:false 고정 ---------------------------------

test("세 가지 연동 방식이 이름별로 모두 available:false 다", () => {
  // 이름을 하나씩 못박는다. 루프만 돌면 방식이 사라져도 통과한다.
  assert.equal(METHOD_AVAILABILITY.official_oauth.available, false, "공식 OAuth 가 활성화됐다");
  assert.equal(
    METHOD_AVAILABILITY.official_api_credential.available,
    false,
    "공식 API credential 이 활성화됐다",
  );
  assert.equal(
    METHOD_AVAILABILITY.short_lived_session.available,
    false,
    "단기 세션 방식이 활성화됐다",
  );
  for (const method of ALL_METHODS) {
    assert.ok(
      METHOD_AVAILABILITY[method].blockedReason.length > 0,
      `${method}: 막힌 이유가 비어 있다 — 화면이 사유를 보여줄 수 없다`,
    );
  }
});

test("연동 방식은 정확히 세 개이며 자격증명 입력 방식이 없다", () => {
  assert.deepEqual(Object.keys(METHOD_AVAILABILITY).sort(), [...ALL_METHODS].sort());
  const keys = Object.keys(METHOD_AVAILABILITY).join(" ");
  for (const banned of ["password", "passwd", "pwd", "cookie", "session_cookie", "otp", "card", "pin"]) {
    assert.ok(!keys.includes(banned), `자격증명 입력 방식이 생겼다: ${banned}`);
  }
});

test("요약은 아무 방식도 가능하지 않다고 말한다", () => {
  const availability = accountLinkAvailability();
  assert.equal(availability.anyAvailable, false, "계정 연결이 가능하다고 보고한다");
  assert.equal(availability.methods.length, 3);
  for (const entry of availability.methods) {
    assert.equal(entry.available, false, `${entry.method} 가 가능하다고 보고한다`);
  }
  // 이 문장이 화면에 그대로 나간다.
  assert.match(availability.summary, /비밀번호를 입력받지도, 저장하지도 않습니다/);
});

// --- B. 거절 + 저장 0 + 외부 요청 0 ---------------------------------------

test("어떤 방식으로 연동을 시도해도 거절되고 외부 요청이 0회다", async () => {
  resetAccountLinkStore();
  const store = createMemoryAccountLinkStore();

  const { calls } = await countNetworkCalls(async () => {
    for (const method of ALL_METHODS) {
      await assert.rejects(
        () => store.beginLink({ userId: "u1", method }),
        (error) => {
          assert.equal(error.code, "ACCOUNT_LINK_REQUIRED", `${method}: 거절 코드가 다르다`);
          return true;
        },
        `${method}: 연동이 거절되지 않았다`,
      );
    }
  });

  assert.equal(calls.length, 0, `계정 연결 시도가 외부로 요청을 보냈다: ${calls.join(", ")}`);
});

test("거절된 뒤 저장소에 아무것도 남지 않는다", async () => {
  resetAccountLinkStore();
  const store = createMemoryAccountLinkStore();

  // 여러 사용자가 모든 방식을 시도해 본다.
  for (const userId of ["u1", "u2", "u3"]) {
    for (const method of ALL_METHODS) {
      await assert.rejects(() => store.beginLink({ userId, method }));
    }
  }

  for (const userId of ["u1", "u2", "u3"]) {
    const status = await store.getStatus(userId);
    assert.equal(status.kind, "NOT_LINKED", `${userId}: 연결 상태가 생겼다`);
    assert.equal(status.reason, "OFFICIAL_METHOD_UNAVAILABLE");
  }
});

test("beginLink 는 어떤 경우에도 성공으로 끝나지 않는다", async () => {
  resetAccountLinkStore();
  const store = createMemoryAccountLinkStore();

  for (const method of ALL_METHODS) {
    let resolved = false;
    try {
      await store.beginLink({ userId: "u1", method });
      resolved = true;
    } catch {
      // 기대한 경로
    }
    assert.equal(resolved, false, `${method}: beginLink 가 성공으로 끝났다`);
  }
});

test("알 수 없는 방식은 입력 오류로 거절된다", async () => {
  resetAccountLinkStore();
  const store = createMemoryAccountLinkStore();

  await assert.rejects(
    () => store.beginLink({ userId: "u1", method: "password" }),
    (error) => {
      assert.equal(error.code, "INVALID_INPUT", "비밀번호 방식이 알려진 방식으로 처리됐다");
      return true;
    },
  );
  // 비밀번호·쿠키·OTP 같은 이름으로는 아예 알려진 방식이 되지 못한다.
  for (const bogus of ["password", "cookie", "otp", "card", "", "OFFICIAL_OAUTH", "official_oauth "]) {
    await assert.rejects(
      () => store.beginLink({ userId: "u1", method: bogus }),
      (error) => {
        assert.equal(error.code, "INVALID_INPUT", `${bogus}: 알 수 없는 방식이 받아들여졌다`);
        return true;
      },
      `${bogus}: 거절되지 않았다`,
    );
  }
});

test("자격증명 비슷한 값을 함께 넘겨도 거절되고 저장되지 않는다", async () => {
  resetAccountLinkStore();
  const store = createMemoryAccountLinkStore();

  const { calls } = await countNetworkCalls(async () => {
    await assert.rejects(() =>
      store.beginLink({
        userId: "u1",
        method: "official_oauth",
        // 호출자가 억지로 끼워 넣어도 받아들일 자리가 없어야 한다.
        password: "p@ssw0rd",
        cookie: "SESSION=abc",
        otp: "123456",
        accessToken: "tok_live_xxx",
      }),
    );
  });

  assert.equal(calls.length, 0);
  const status = await store.getStatus("u1");
  // 자격증명 유출을 먼저 본다. 상태 종류보다 이쪽이 더 치명적이므로
  // 실패 메시지가 "자격증명이 남았다"로 나와야 한다.
  const dumped = JSON.stringify(status);
  for (const secret of ["p@ssw0rd", "SESSION=abc", "123456", "tok_live_xxx"]) {
    assert.ok(!dumped.includes(secret), `상태에 자격증명이 남았다: ${secret}`);
  }
  assert.equal(status.kind, "NOT_LINKED", "거절된 시도가 연결 상태를 만들었다");
});

test("unlink 는 연결되지 않은 사용자에게도 안전하다", async () => {
  resetAccountLinkStore();
  const store = createMemoryAccountLinkStore();
  await store.unlink("없는-사용자");
  const status = await store.getStatus("없는-사용자");
  assert.equal(status.kind, "NOT_LINKED");
});

// --- C. 입력·환경변수·설정으로 켜는 경로가 없다 ---------------------------

test("환경변수를 켜도 계정 연결이 열리지 않는다", async () => {
  // 소스에 process.env 를 읽는 자리가 없다는 것을 먼저 확인하고,
  // 실제로 환경변수를 잔뜩 켜 본다.
  const fs = await import("node:fs");
  const source = fs.readFileSync("lib/autobook/account-link.ts", "utf8");
  assert.ok(
    !/process\.env/.test(source),
    "account-link.ts 가 환경변수를 읽는다 — 환경변수로 켜는 경로가 생겼다",
  );

  await withEnv(
    {
      ENABLE_ACCOUNT_LINK: "true",
      ACCOUNT_LINK_ENABLED: "true",
      AUTOBOOK_ACCOUNT_LINK: "official_oauth",
      ALLOW_LIVE_RESERVATION: "true",
      NODE_ENV: "development",
    },
    async () => {
      assert.equal(accountLinkAvailability().anyAvailable, false, "환경변수로 계정 연결이 열렸다");
      resetAccountLinkStore();
      const store = createMemoryAccountLinkStore();
      for (const method of ALL_METHODS) {
        await assert.rejects(() => store.beginLink({ userId: "u1", method }));
      }
    },
  );
});

test("입력으로 available 을 켜는 경로가 없다", async () => {
  resetAccountLinkStore();
  const store = createMemoryAccountLinkStore();

  // 호출자가 플래그를 끼워 넣어도 무시돼야 한다.
  for (const extra of [
    { available: true },
    { force: true },
    { bypass: true },
    { override: { available: true } },
    { methodAvailability: { official_oauth: { available: true } } },
  ]) {
    await assert.rejects(
      () => store.beginLink({ userId: "u1", method: "official_oauth", ...extra }),
      (error) => {
        assert.equal(error.code, "ACCOUNT_LINK_REQUIRED", `입력 ${JSON.stringify(extra)} 가 거절을 바꿨다`);
        return true;
      },
    );
  }
  assert.equal(accountLinkAvailability().anyAvailable, false);
});

// --- D. METHOD_AVAILABILITY 가 얕은 freeze 다 (현재 동작 기록) ------------

test("METHOD_AVAILABILITY 는 얕은 freeze 이고 중첩 값을 바꿀 수 있다(현재 동작 기록)", () => {
  // Object.freeze 는 최상위만 막는다. 중첩된 방식 객체는 가변이므로
  // `METHOD_AVAILABILITY.official_oauth.available = true` 한 줄로
  // accountLinkAvailability().anyAvailable 이 true 가 된다 -- 화면이
  // "계정 연결 가능" 이라고 거짓을 말하게 된다.
  //
  // **다만 실제 연결은 열리지 않는다.** beginLink 는 availability 와 무관하게
  // 무조건 거절한다(위 테스트들이 그것을 붙들고 있다). 그래서 이것은
  // "안전장치가 뚫린다"가 아니라 **"화면이 거짓을 말한다"** 범주다.
  // scripts/verify-autobook.cjs 의 `available: true` 검사는 소스 문자열만
  // 보므로 런타임 변경을 잡지 못한다.
  //
  // **이 테스트를 지우지 말고 뒤집어라.** 깊은 freeze 로 고치면 아래 단정이
  // 깨진다. 그때 isFrozen 을 true 로, "바뀐다"를 "바뀌지 않는다"로 뒤집어라.
  assert.equal(Object.isFrozen(METHOD_AVAILABILITY), true, "최상위 freeze 가 사라졌다");
  assert.equal(
    Object.isFrozen(METHOD_AVAILABILITY.official_oauth),
    false,
    "중첩 객체가 frozen 이 됐다 — 고쳐졌다면 이 테스트를 뒤집어라",
  );

  const original = METHOD_AVAILABILITY.official_oauth.available;
  try {
    METHOD_AVAILABILITY.official_oauth.available = true;
    assert.equal(
      accountLinkAvailability().anyAvailable,
      true,
      "중첩 변경이 번지지 않았다 — 방어가 추가됐다면 이 테스트를 뒤집어라",
    );
  } finally {
    // 다른 테스트에 번지지 않게 되돌린다.
    METHOD_AVAILABILITY.official_oauth.available = original;
  }
  assert.equal(accountLinkAvailability().anyAvailable, false);
});

test("앞 테스트가 연동 가용성을 오염시키지 않았다(실행 순서 독립성)", () => {
  // 위 테스트는 공유 객체를 일부러 변조한다. finally 로 되돌리지만,
  // 되돌리기가 빠지거나 try 블록이 중간에 터지면 이후 테스트가 조용히
  // 오염된 값을 본다. 안전 가드이므로 그 회귀를 반드시 잡는다.
  assert.equal(accountLinkAvailability().anyAvailable, false, "앞 테스트의 변조가 남아 있다");
  for (const method of ALL_METHODS) {
    assert.equal(METHOD_AVAILABILITY[method].available, false, `${method}: 변조가 남아 있다`);
  }
});
