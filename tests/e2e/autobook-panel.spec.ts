import { expect, test } from "@playwright/test";

// v0.9 서버형 자동예약 패널.
//
// 검사하는 것: 실제 연동이 없다는 사실을 숨기지 않는가, Mock 결과를
// 실제처럼 보여주지 않는가, 계정 정보를 받지 않는가.

async function openAutomationTab(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("bottom-nav-tab").filter({ hasText: "자동예약" }).first().click();
  await page.getByTestId("autobook-panel").waitFor();
}

test("공식 연동이 없으면 '준비 중'으로 표시한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);

  await expect(page.getByTestId("autobook-readiness")).toHaveText("공식 연동 준비 중");
  await expect(page.getByText(/결제는 사용자가 공식 앱에서 직접/)).toBeVisible();
});

test("아직 하지 않는 결과를 표시하지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);

  const panel = await page.getByTestId("autobook-panel").innerText();
  for (const word of ["예약 성공", "좌석 발견", "예약번호", "결제기한"]) {
    expect(panel, `아직 없는 결과를 표시한다: ${word}`).not.toContain(word);
  }
});

test("자동예약 패널은 계정 정보를 받지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);

  const panel = page.getByTestId("autobook-panel");
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
  await expect(panel.locator("input")).toHaveCount(0);
  await expect(page.getByText(/비밀번호를 입력받지도, 저장하지도 않습니다/)).toBeVisible();
});

test("§7: 네 가지 상태를 그대로 표시한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);

  await expect(page.getByTestId("autobook-state-foundation")).toContainText("서버형 자동예약 기반 준비됨");
  await expect(page.getByTestId("autobook-state-provider")).toContainText("실제 좌석 Provider 미연결");
  await expect(page.getByTestId("autobook-state-account")).toContainText("계정 연결 비활성");
  await expect(page.getByTestId("autobook-state-live")).toContainText("실제 좌석 조회·예약을 수행하지 않음");
});

test("§7: 실제 작업 등록 버튼은 비활성이고 사유 세 가지를 밝힌다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);

  const button = page.getByTestId("autobook-create-job");
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();

  const reasons = page.getByTestId("autobook-disabled-reasons");
  await expect(reasons).toContainText("공식 연동 Provider 없음");
  await expect(reasons).toContainText("영속 DB 미연결");
  await expect(reasons).toContainText("계정 연결 방식 없음");
  await expect(reasons).toContainText("Worker 운영 배포·스케줄 미설정");
});

test("v0.10: 코드 구현과 운영 활성화를 나눠서 표시한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);

  const readiness = page.getByTestId("autobook-readiness-list");
  // 코드가 있다고 말하는 줄
  await expect(readiness).toContainText("PostgreSQL 저장소 코드");
  await expect(readiness).toContainText("Worker 실행 코드");
  // 아직 운영에서 켜지지 않았다고 말하는 줄
  await expect(readiness).toContainText("이 환경의 DB 설정 없음");
  await expect(readiness).toContainText("DB 연결 미확인");
  await expect(readiness).toContainText("Worker 운영 배포·스케줄 미설정");
  await expect(readiness).toContainText("공식 Provider 미연결");

  // 연결 문자열이 화면에 새지 않는다.
  const panel = await page.getByTestId("autobook-panel").innerText();
  expect(panel).not.toMatch(/postgres(ql)?:\/\//);
});

test("상태 API 가 실제 예약 불가를 알린다", async ({ request }) => {
  const response = await request.get("/api/autobook/status");
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.liveReservationPossible).toBe(false);
  expect(body.runtime.provider).toBe("unavailable");
  expect(body.provider.capabilities.canCreateReservation).toBe(false);
  expect(body.accountLink.anyAvailable).toBe(false);

  // v0.10: 코드 구현과 운영 활성화가 서로 다른 필드로 나온다.
  expect(body.readiness.postgresStoreImplemented).toBe(true);
  expect(body.readiness.workerEntrypointImplemented).toBe(true);
  expect(body.readiness.postgresConfigured).toBe(false);
  expect(body.readiness.postgresConnected).toBe(false);
  expect(body.readiness.workerScheduleConfigured).toBe(false);
  expect(body.readiness.officialProviderConnected).toBe(false);
  expect(body.readiness.liveReservationPossible).toBe(false);
  // 연결 문자열은 어떤 형태로도 응답에 없다.
  expect(JSON.stringify(body)).not.toMatch(/postgres(ql)?:\/\//);
});

test("좁은 화면에서 카드 밖으로 넘치지 않는다", async ({ page }) => {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await openAutomationTab(page);
    const overflow = await page.evaluate(() => {
      let worst = 0;
      for (const card of document.querySelectorAll("article, li, label")) {
        const rect = card.getBoundingClientRect();
        if (rect.width === 0) continue;
        for (const el of card.querySelectorAll("*")) {
          const child = el.getBoundingClientRect();
          if (child.width === 0 || getComputedStyle(el).position === "absolute") continue;
          worst = Math.max(worst, child.right - rect.right);
        }
      }
      return { worst, hScroll: document.documentElement.scrollWidth > window.innerWidth };
    });
    expect(overflow.worst, `${width}px 에서 카드 경계를 넘는다`).toBeLessThanOrEqual(1);
    expect(overflow.hScroll, `${width}px 에서 가로 스크롤이 생겼다`).toBe(false);
  }
});
