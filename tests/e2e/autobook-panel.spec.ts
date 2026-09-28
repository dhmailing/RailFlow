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

test("상태 API 가 실제 예약 불가를 알린다", async ({ request }) => {
  const response = await request.get("/api/autobook/status");
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.liveReservationPossible).toBe(false);
  expect(body.runtime.provider).toBe("unavailable");
  expect(body.provider.capabilities.canCreateReservation).toBe(false);
  expect(body.accountLink.anyAvailable).toBe(false);
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
