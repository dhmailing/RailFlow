import { expect, test } from "@playwright/test";

// 자동예약 탭의 "실제 연동" 패널 회귀 테스트.
//
// 이 테스트가 도는 환경에는 로컬 Agent가 실행되어 있지 않다. 그 상태에서
// 패널이 어떻게 보여야 하는지를 고정한다:
//   - 실제 연동이 PC의 Agent를 필요로 한다는 것을 알려준다
//   - 시뮬레이터와 혼동되지 않게 표시한다
//   - 실제 조회 없이 "감시 중"이나 "예약 성공"을 표시하지 않는다
//   - 계정 정보를 묻지 않는다

async function openAutomationTab(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("bottom-nav-tab").filter({ hasText: "자동예약" }).first().click();
  await page.getByTestId("live-agent-panel").waitFor();
}

test("공개 배포본은 PC에서 실행하는 방법만 안내한다 -- 자동예약 탭", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);

  await expect(page.getByText("실제 좌석 조회 · PC에서 실행합니다")).toBeVisible();
  await expect(page.getByText(/2-RailFlow실행\.cmd/)).toBeVisible();
  // 화면을 꺼도 도는 서버 감시로 설명하지 않는다.
  await expect(page.getByText(/Agent 창을 닫거나 PC가 절전에 들어가면 조회가 멈춥니다/)).toBeVisible();
});

test("공개 배포본은 로컬 Agent에 요청을 보내지 않는다", async ({ page }) => {
  // https 페이지가 http://127.0.0.1 을 호출하는 구조는 브라우저가 막는다.
  // 그래서 배포본은 아예 시도하지 않는다(docs/V0.8-LOCAL-CONNECTION.md).
  const attempts: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("127.0.0.1") || /:\/\/localhost:4319/.test(url)) attempts.push(url);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);
  await page.waitForTimeout(2500);
  expect(attempts, "배포본이 로컬 Agent를 호출했다").toEqual([]);
});

test("실제 조회 없이 감시 중·예약 성공을 표시하지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);

  // 실제 연동 패널 안쪽만 본다. 같은 탭의 시연/안내 문구까지 잡으면
  // 이 테스트가 검사하려는 것("실제 상태를 지어내지 않는가")과 무관해진다.
  const panel = await page.getByTestId("live-agent-panel").innerText();
  expect(panel).not.toContain("예약 성공 · 결제 필요");
  expect(panel).not.toContain("좌석 없음 · 감시 중");
  expect(panel).not.toContain("좌석 발견");
  expect(panel).not.toContain("예약 요청 중");
});

test("실제 연동 패널은 계정 정보를 묻지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAutomationTab(page);

  // 배포본 패널에는 입력 칸 자체가 없다. 계정 정보를 받을 수 있는 통로가
  // 아예 없다는 뜻이다. ("OTP를 저장하지 않는다" 같은 안내 문구는 있어도 된다 --
  // 문구 유무가 아니라 입력 통로의 유무가 검사 대상이다.)
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const panel = page.getByTestId("live-agent-panel");
  await expect(panel.locator("input")).toHaveCount(0);
  await expect(panel.locator("form")).toHaveCount(0);
});

test("실제 연동 안내가 좁은 화면에서도 카드 밖으로 넘치지 않는다", async ({ page }) => {
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
