import { expect, test } from "@playwright/test";

// 후보 열차 카드 레이아웃 회귀 테스트.
//
// 재현한 실제 결함(PR #13 Preview에서 사용자가 발견): 전역 CSS
// `main input { width: 100% }`가 `input[type="checkbox"]`에도 적용되어,
// 체크박스가 행 전체 폭(390px 화면에서 296px)을 차지했다. 체크박스에는
// `shrink-0`이 붙어 있어 줄어들지도 않았고, 그 결과
//   - 같은 행의 열차 정보 div(`min-w-0 flex-1`)가 폭 0으로 밀리고
//   - 상태 배지가 카드 오른쪽 경계를 78px 넘어가고
//   - 문서 폭이 뷰포트를 넘어 가로 스크롤이 생겼다.
//
// 아주 좁은 폭(390px 화면 200% 확대 ≈ 195 CSS px)에서는 체크박스 폭이
// 정상이어도 상태 배지가 정보 영역을 폭 0 가까이로 밀어내는 두 번째 형태의
// 결함이 있었다. 195px 조건은 실제 브라우저 확대가 아니라 뷰포트를 절반으로
// 줄인 대체 조건이다(CSS px 기준 레이아웃은 동일하게 재현된다).
//
// 이 테스트는 "체크박스가 작게 유지되는가"가 아니라 그 결과로 나타나는
// 증상(정보 영역 폭 붕괴, 카드 경계 이탈, 가로 스크롤)을 직접 검사한다.
// 글자 축소나 overflow:hidden으로 숨기면 통과하지 않는다.
const VIEWPORTS = [
  { width: 195, height: 422, label: "195px(390px 200% 확대 상당)" },
  { width: 360, height: 740, label: "360px" },
  { width: 390, height: 844, label: "390px" },
  { width: 1440, height: 900, label: "1440px" },
  { width: 1920, height: 1080, label: "1920px" },
];

const SCREENS = ["/demo", "/demo/booking-automation"];

type RowAudit = {
  checkboxWidth: number;
  infoWidth: number;
  overflowRight: number;
};

async function auditCandidateRows(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    const rows = boxes.map((cb) => {
      const row = (cb.closest("label") ?? cb.parentElement) as HTMLElement;
      const rowRect = row.getBoundingClientRect();
      const childRects = Array.from(row.children).map((child) => child.getBoundingClientRect());
      const infoRect = childRects[1];
      return {
        checkboxWidth: cb.getBoundingClientRect().width,
        infoWidth: infoRect ? infoRect.width : 0,
        overflowRight: Math.max(...childRects.map((r) => r.right)) - rowRect.right,
      };
    });
    return {
      rows,
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth,
    } as { rows: RowAudit[]; horizontalScroll: boolean };
  });
}

for (const screen of SCREENS) {
  for (const viewport of VIEWPORTS) {
    test(`후보 열차 카드가 경계를 넘지 않는다 -- ${screen} ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(screen);
      await page.waitForSelector('input[type="checkbox"]');

      const { rows, horizontalScroll } = await auditCandidateRows(page);
      expect(rows.length, "후보 행을 찾지 못했다").toBeGreaterThan(0);

      for (const row of rows) {
        // 체크박스가 행을 독차지하지 않는다(정상 20px, 결함 시 296px).
        expect(row.checkboxWidth, "체크박스가 비정상적으로 넓다").toBeLessThan(48);
        // 열차 정보가 남은 폭을 실제로 쓴다(결함 시 0px, 좁은 폭 결함 시 18.6px).
        expect(row.infoWidth, "열차 정보 영역이 폭 0 가까이로 밀렸다").toBeGreaterThan(40);
        // 배지를 포함한 어떤 자식도 카드 오른쪽 경계를 넘지 않는다.
        expect(row.overflowRight, "카드 경계를 넘어 표시된다").toBeLessThanOrEqual(1);
      }

      expect(horizontalScroll, "가로 스크롤이 생겼다").toBe(false);
    });
  }
}

test("후보 열차 체크박스는 클릭과 키보드로 모두 선택된다 -- /demo", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo");
  const first = page.locator('input[type="checkbox"]').first();
  await first.waitFor();

  await first.check();
  await expect(first).toBeChecked();

  // 키보드(Space)로도 해제·선택이 되어야 한다.
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(first).toBeChecked();
});

test("라벨 텍스트를 눌러도 후보가 선택된다 -- /demo", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo");
  const first = page.locator('input[type="checkbox"]').first();
  await first.waitFor();
  const checkedBefore = await first.isChecked();

  // 체크박스가 아니라 같은 행의 열차 정보 텍스트를 클릭한다.
  const row = page.locator("label").filter({ has: first }).first();
  await row.locator("div").first().click();
  expect(await first.isChecked()).toBe(!checkedBefore);
});

// 195 CSS px(390px 화면 200% 확대 상당)에서 시연 화면 헤더의 "RailFlow로
// 돌아가기" 링크와 "초기화" 버튼이 서로 겹쳐 글자가 포개져 보이던 문제.
// 원인은 `main :is(.flex, .grid) > * { min-width: 0 }`가 두 항목을 각자의
// 최소 폭 아래로 줄여 각 항목의 글자가 자기 박스를 넘어 흐른 것이다.
for (const screen of SCREENS) {
  test(`헤더 항목이 서로 겹치지 않는다 -- ${screen} 195px`, async ({ page }) => {
    await page.setViewportSize({ width: 195, height: 422 });
    await page.goto(screen);
    await page.waitForSelector("header a");

    const overlap = await page.evaluate(() => {
      const row = document.querySelector("header a")!.parentElement as HTMLElement;
      const items = Array.from(row.children).map((el) => el.getBoundingClientRect());
      let worst = 0;
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const a = items[i];
          const b = items[j];
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (x > 0 && y > 0) worst = Math.max(worst, Math.min(x, y));
        }
      }
      return worst;
    });

    expect(overlap, "헤더 항목이 서로 겹친다").toBeLessThanOrEqual(0);
  });
}
