import { expect, test } from "@playwright/test";

// 검색 결과 → [자동예약] → 등록 화면으로 **값이 실제로 옮겨지는지**를
// 브라우저에서 확인한다. 문자열이 소스에 있는지가 아니라, 화면이 들고 있는
// 상태가 탭을 왕복해도 그대로인지를 본다.
//
// 후보는 localStorage 로 심는다. 이 컨테이너에서는 공공데이터 호스트로
// 나갈 수 없어 실제 검색이 되지 않고, 애초에 검사 대상은 "저장 → 복원 →
// 등록 화면 전달" 경로다.

const STORAGE_KEY = "railflow-automation-candidates";
const SETTINGS_KEY = "railflow-settings";

type SeedCandidate = Record<string, unknown>;

function candidate(overrides: SeedCandidate = {}): SeedCandidate {
  return {
    id: "seed-1",
    number: "KTX 101",
    trainType: "KTX",
    depart: "08:00",
    arrive: "10:30",
    fare: "59,800원",
    departure: "서울",
    arrival: "부산",
    date: "2026-10-20",
    source: "tago",
    ...overrides,
  };
}

async function seed(
  page: import("@playwright/test").Page,
  candidates: SeedCandidate[],
  settings: Record<string, unknown> | null = null,
) {
  await page.addInitScript(
    ([key, settingsKey, rows, saved]) => {
      window.localStorage.setItem(key as string, JSON.stringify(rows));
      if (saved) window.localStorage.setItem(settingsKey as string, JSON.stringify(saved));
    },
    [STORAGE_KEY, SETTINGS_KEY, candidates, settings] as const,
  );
}

async function openAutomationTab(page: import("@playwright/test").Page) {
  await page.getByTestId("bottom-nav-tab").filter({ hasText: "자동예약" }).first().click();
  await page.getByTestId("autobook-panel").waitFor();
}

async function openBookingTab(page: import("@playwright/test").Page) {
  await page.getByTestId("bottom-nav-tab").filter({ hasText: "예매" }).first().click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("데모 후보의 출처가 자동예약 등록 화면까지 유지된다", async ({ page }) => {
  await seed(page, [candidate({ id: "demo-1", source: "demo" })]);
  await page.goto("/");

  // 예매 탭의 후보 목록에서 먼저 가상 열차로 표시된다.
  await expect(page.getByTestId("candidate-source-demo")).toBeVisible();

  await openAutomationTab(page);

  const train = page.getByTestId("autobook-handoff-train").first();
  await expect(train).toHaveAttribute("data-train-source", "demo");
  await expect(train).toContainText("가상 열차");
  await expect(page.getByTestId("autobook-handoff-demo-warning")).toBeVisible();
  await expect(page.getByTestId("autobook-handoff-demo-warning")).toContainText("실제 작업으로 등록되지 않습니다");
});

test("실제 시간표 후보에는 가상 열차 경고가 붙지 않는다", async ({ page }) => {
  await seed(page, [candidate({ id: "real-1", source: "tago" })]);
  await page.goto("/");
  await expect(page.getByTestId("candidate-source-demo")).toHaveCount(0);

  await openAutomationTab(page);
  await expect(page.getByTestId("autobook-handoff-train").first()).toHaveAttribute("data-train-source", "tago");
  await expect(page.getByTestId("autobook-handoff-demo-warning")).toHaveCount(0);
});

test("데모와 실제가 섞여도 각 줄의 출처가 구분된다", async ({ page }) => {
  await seed(page, [candidate({ id: "a", source: "tago" }), candidate({ id: "b", number: "KTX 103", source: "demo" })]);
  await page.goto("/");
  await openAutomationTab(page);

  const rows = page.getByTestId("autobook-handoff-train");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-train-source", "tago");
  await expect(rows.nth(1)).toHaveAttribute("data-train-source", "demo");
  await expect(page.getByTestId("autobook-handoff-demo-warning")).toContainText("1편");
});

test("출처 없는 옛 저장 데이터는 실제 후보로 복원되지 않고 재선택을 안내한다", async ({ page }) => {
  const legacy = candidate({ id: "legacy-1" });
  delete legacy.source;
  await seed(page, [legacy]);
  await page.goto("/");

  await expect(page.getByTestId("candidate-unknown-source-note")).toBeVisible();
  await expect(page.getByTestId("candidate-unknown-source-note")).toContainText("확인할 수 없어");
  // 후보 목록 자체가 생기지 않는다.
  await expect(page.getByTestId("candidate-tray")).toHaveCount(0);

  // 등록 화면에도 조건이 넘어가지 않는다.
  await openAutomationTab(page);
  await expect(page.getByTestId("autobook-handoff")).toHaveCount(0);
});

test("좌석등급 기본값은 일반실만이다", async ({ page }) => {
  await seed(page, [candidate()]);
  await page.goto("/");
  await openAutomationTab(page);

  await expect(page.getByTestId("autobook-seat-class")).toHaveValue("standard_only");
  await expect(page.getByTestId("autobook-seat-class-value")).toHaveText("일반실만");
});

test("고른 좌석등급이 탭을 왕복해도 유지된다", async ({ page }) => {
  await seed(page, [candidate()]);
  await page.goto("/");
  await openAutomationTab(page);

  await page.getByTestId("autobook-seat-class").selectOption("first_only");
  await expect(page.getByTestId("autobook-seat-class-value")).toHaveText("특실만");

  await openBookingTab(page);
  await expect(page.getByTestId("autobook-panel")).toHaveCount(0);
  await openAutomationTab(page);

  await expect(page.getByTestId("autobook-seat-class")).toHaveValue("first_only");
  await expect(page.getByTestId("autobook-seat-class-value")).toHaveText("특실만");
});

test("일반실만 선택이 탭 왕복으로 특실 허용으로 바뀌지 않는다", async ({ page }) => {
  await seed(page, [candidate()]);
  await page.goto("/");
  await openAutomationTab(page);

  // 한 번 바꿨다가 되돌려도 일반실만으로 남아야 한다.
  await page.getByTestId("autobook-seat-class").selectOption("any");
  await page.getByTestId("autobook-seat-class").selectOption("standard_only");

  await openBookingTab(page);
  await openAutomationTab(page);

  await expect(page.getByTestId("autobook-seat-class")).toHaveValue("standard_only");
  const value = await page.getByTestId("autobook-seat-class-value").textContent();
  expect(value ?? "", "일반실만 선택이 특실 허용으로 바뀌었다").not.toContain("특실");
});

test("새로고침 후에도 좌석등급이 유지된다", async ({ page }) => {
  await seed(page, [candidate()]);
  await page.goto("/");
  await openAutomationTab(page);
  await page.getByTestId("autobook-seat-class").selectOption("any");

  await page.reload();
  await openAutomationTab(page);
  await expect(page.getByTestId("autobook-seat-class")).toHaveValue("any");
});

test("저장된 좌석등급이 알 수 없는 값이면 일반실만으로 돌아간다", async ({ page }) => {
  await seed(page, [candidate()], { seatClass: "standard_preferred" });
  await page.goto("/");
  await openAutomationTab(page);

  await expect(page.getByTestId("autobook-seat-class")).toHaveValue("standard_only");
});

// --- 자동예약 탭의 두 패널 사이 ------------------------------------------
//
// 같은 탭에 서버형 자동예약 패널과 취소표 감시 패널이 함께 있다. 조건이 한
// 쪽에만 전달되면 사용자는 같은 화면에서 서로 다른 조건을 보게 된다.

// 감시 패널의 등록 폼은 로그인한 사용자에게만 보인다. 개발/테스트 전용
// 메모리 계정 저장소로 가입한다(playwright.config.ts 의 AUTH_STORE=memory).
async function signIn(page: import("@playwright/test").Page) {
  const response = await page.request.post("/api/auth/signup", {
    // 요청 제한 버킷을 테스트마다 분리한다(lib/security/rate-limit.ts).
    // 제한 회피가 아니라 테스트 독립을 위한 것이다.
    headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
    data: { email: `panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`, password: "two-panel-1234" },
  });
  if (response.status() !== 201) throw new Error(`가입 실패: ${response.status()} ${await response.text()}`);
}

async function waitForWatchPanel(page: import("@playwright/test").Page) {
  await page.getByTestId("watch-seat-class").waitFor();
}

test("같은 후보의 출처가 두 패널에서 일치한다", async ({ page }) => {
  await seed(page, [candidate({ id: "demo-1", source: "demo" })]);
  await signIn(page);
  await page.goto("/");
  await openAutomationTab(page);
  await waitForWatchPanel(page);

  // 서버형 패널
  await expect(page.getByTestId("autobook-handoff-train").first()).toHaveAttribute("data-train-source", "demo");
  // 감시 패널의 후보 줄
  await expect(page.getByTestId("watch-candidate-source").first()).toHaveAttribute("data-train-source", "demo");
  await expect(page.getByTestId("watch-candidate-source").first()).toContainText("가상 열차");
});

test("실제 시간표 후보도 두 패널에서 같은 출처로 보인다", async ({ page }) => {
  await seed(page, [candidate({ id: "real-1", source: "tago" })]);
  await signIn(page);
  await page.goto("/");
  await openAutomationTab(page);
  await waitForWatchPanel(page);

  await expect(page.getByTestId("autobook-handoff-train").first()).toHaveAttribute("data-train-source", "tago");
  await expect(page.getByTestId("watch-candidate-source").first()).toHaveAttribute("data-train-source", "tago");
  // 감시 경로는 실제 좌석을 조회하지 않으므로 등록을 막는다.
  await expect(page.getByTestId("watch-blocked-reason")).toBeVisible();
  await expect(page.getByTestId("watch-create-job")).toBeDisabled();
});

test("좌석등급이 두 패널에서 같은 값을 보인다", async ({ page }) => {
  await seed(page, [candidate({ source: "demo" })]);
  await signIn(page);
  await page.goto("/");
  await openAutomationTab(page);
  await waitForWatchPanel(page);

  // 기본값
  await expect(page.getByTestId("autobook-seat-class")).toHaveValue("standard_only");
  await expect(page.getByTestId("watch-seat-class")).toHaveValue("standard_only");

  // 감시 패널에서 바꾸면 서버형 패널도 따라온다.
  await page.getByTestId("watch-seat-class").selectOption("any");
  await expect(page.getByTestId("autobook-seat-class")).toHaveValue("any");
  await expect(page.getByTestId("autobook-seat-class-value")).toHaveText("일반실·특실 모두 허용");

  // 서버형 패널에서 되돌리면 감시 패널도 따라온다.
  await page.getByTestId("autobook-seat-class").selectOption("standard_only");
  await expect(page.getByTestId("watch-seat-class")).toHaveValue("standard_only");
});

test("일반실만 선택이 다른 패널에서 특실 허용으로 바뀌지 않는다", async ({ page }) => {
  await seed(page, [candidate({ source: "demo" })]);
  await signIn(page);
  await page.goto("/");
  await openAutomationTab(page);
  await waitForWatchPanel(page);

  await page.getByTestId("autobook-seat-class").selectOption("standard_only");
  await openBookingTab(page);
  await openAutomationTab(page);
  await waitForWatchPanel(page);

  await expect(page.getByTestId("watch-seat-class")).toHaveValue("standard_only");
  const watchValue = await page.getByTestId("watch-seat-class").inputValue();
  expect(watchValue, "일반실만이 특실 허용으로 바뀌었다").not.toBe("any");
  expect(watchValue).not.toBe("standard_preferred");
  await expect(page.getByTestId("watch-blocked-reason")).toHaveCount(0);
});

test("감시 경로가 지원하지 않는 좌석등급은 조용히 대체되지 않고 등록이 막힌다", async ({ page }) => {
  await seed(page, [candidate({ source: "demo" })]);
  await signIn(page);
  await page.goto("/");
  await openAutomationTab(page);
  await waitForWatchPanel(page);

  await page.getByTestId("autobook-seat-class").selectOption("first_only");

  // 감시 패널이 값을 다른 등급으로 바꿔 보여주지 않는다.
  await expect(page.getByTestId("watch-seat-class")).toHaveValue("first_only");
  await expect(page.getByTestId("watch-seat-class-unsupported")).toBeVisible();
  await expect(page.getByTestId("watch-seat-class-unsupported")).toContainText("특실만");
  await expect(page.getByTestId("watch-create-job")).toBeDisabled();

  // 서버형 패널의 표시도 그대로 특실만이다.
  await expect(page.getByTestId("autobook-seat-class-value")).toHaveText("특실만");
});
