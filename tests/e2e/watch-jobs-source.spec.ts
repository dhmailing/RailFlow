import { expect, test } from "@playwright/test";

// 취소표 감시 등록 경로의 **서버 입력 검증**을 실제 요청으로 확인한다.
//
// 화면을 거치지 않고 직접 POST 해도 잘못된 입력이 거부돼야 한다. 화면에서만
// 막으면 요청을 직접 보내는 쪽에는 아무 보호가 없다.
//
// 여기서 확인하는 것은 **입력값의 일관성**이다. 클라이언트가 보낸 "tago" 라는
// 문자열이 실제 열차라는 증거가 될 수 없으므로(lib/rail/candidate-source.ts),
// "진위를 검증했다"고 읽지 않는다.

const PASSWORD = "verify-source-1234";

// 기기 등록 후 채워진다. body() 가 이 값을 쓴다.
let DEVICE_ID = "dev-1";

function body(overrides: Record<string, unknown> = {}) {
  const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  return {
    departure: "서울",
    arrival: "부산",
    departureId: "demo-0",
    arrivalId: "demo-1",
    date,
    timeRangeStart: "09:00",
    timeRangeEnd: "18:00",
    trainType: "KTX",
    passengers: 1,
    seatClassPreference: "standard_only",
    candidates: [
      {
        externalKey: "k-1",
        trainNumber: "KTX 101",
        trainType: "KTX",
        departAt: `${date}T10:00:00+09:00`,
        arriveAt: `${date}T12:00:00+09:00`,
        source: "demo",
      },
    ],
    watchUntil: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    notificationMethods: [{ channel: "email", deviceId: DEVICE_ID }],
    ...overrides,
  };
}

test("후보 출처를 서버가 직접 검증한다", async ({ request }) => {
  // 요청 제한은 클라이언트 IP 로 버킷을 나눈다(lib/security/rate-limit.ts).
  // 테스트마다 다른 값을 줘서 다른 테스트의 요청과 버킷을 섞지 않는다.
  // 제한을 피하려는 것이 아니라 테스트를 서로 독립시키는 것이다.
  const headers = { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250) + 1}` };

  // 이 경로는 인증을 요구한다. 개발/테스트 전용 메모리 계정 저장소를 쓴다.
  const signup = await request.post("/api/auth/signup", {
    headers,
    data: { email: `source-${Date.now()}@example.test`, password: PASSWORD },
  });
  expect(signup.status(), await signup.text()).toBe(201);

  // 알림 수신 기기가 하나 있어야 작업을 만들 수 있다.
  const device = await request.post("/api/devices", {
    headers,
    data: { channel: "email", token: "source-test@example.test", label: "test" },
  });
  expect(device.status(), await device.text()).toBe(201);
  DEVICE_ID = (await device.json()).device.id as string;

  const post = (data: unknown) => request.post("/api/watch-jobs", { headers, data });

  // 1) source 가 없으면 거부한다. 기본값으로 메워 주지 않는다.
  const noSource = body({
    candidates: [{ ...body().candidates[0], source: undefined }],
  });
  const r1 = await post(noSource);
  expect(r1.status()).toBe(400);
  expect((await r1.json()).error.code).toBe("INVALID_JOB_INPUT");

  // 2) 알 수 없는 출처 문자열도 거부한다.
  const r2 = await post(body({ candidates: [{ ...body().candidates[0], source: "korail" }] }));
  expect(r2.status()).toBe(400);
  expect((await r2.json()).error.code).toBe("INVALID_JOB_INPUT");

  // 3) 한 작업에 실제 후보와 데모 후보를 섞을 수 없다.
  const base = body().candidates[0];
  const r3 = await post(
    body({
      candidates: [base, { ...base, externalKey: "k-2", trainNumber: "KTX 103", source: "tago" }],
    }),
  );
  expect(r3.status()).toBe(400);
  expect((await r3.json()).error.code).toBe("INVALID_CANDIDATE_SOURCE");

  // 4) 실제 시간표 후보는 이 경로로 등록할 수 없다 -- 실제 좌석 Provider 가
  //    없으므로 받아 주면 가상 결과가 실제처럼 보인다.
  const r4 = await post(
    body({
      departureId: "NAT010000",
      arrivalId: "NAT014445",
      candidates: [{ ...base, source: "tago" }],
    }),
  );
  expect(r4.status()).toBe(422);
  expect((await r4.json()).error.code).toBe("REAL_SOURCE_UNSUPPORTED");

  // 5) 데모 후보는 등록되고, 출처가 저장된 작업에 남는다. 가상 작업 표시도.
  const r5 = await post(body());
  expect(r5.status(), await r5.text()).toBe(201);
  const created = (await r5.json()).job;
  expect(created.simulation, "Mock Provider 작업인데 가상 표시가 없다").toBe(true);
  expect(created.seatProvider).toBe("mock");
  expect(created.candidates[0].source).toBe("demo");
});
