import { expect, test } from "@playwright/test";

// Real-browser E2E for the public, login-free /demo/booking-automation page
// (§6 of the v0.7 follow-up request). Drives: condition input -> candidate
// selection (2+) -> interval selection -> "자동 감시 시작" -> automatic
// seat-search ticks -> seat found -> automatic purchase-click -> automatic
// reserve -> payment-pending with a virtual reservation number -> the other
// candidate showing "다른 열차 예약 성공으로 자동 중단" -> page reload
// (sessionStorage persistence) -> "결제 완료" -> COMPLETED.
//
// Uses Playwright's clock API (page.clock) instead of real waits, per the
// request's explicit "테스트에서는 실제 1초씩 기다리지 않도록 fake timer
// 또는 테스트 전용 clock을 사용한다" -- this page's timers
// (lib/automation-demo/timer.ts) are plain setTimeout, which clock.install()
// virtualizes globally in the page before navigation.
test.describe("자동 좌석조회·예약 매크로 공개 시연 (/demo/booking-automation)", () => {
  test("조건 등록부터 가상 예약 성공, 새로고침 복원, 결제 완료까지", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto("/demo/booking-automation");

    // 2. 후보 2개 이상 선택 (candidate-2, candidate-3 -- candidate-1은 항상
    // 매진이라 선택에서 빼서 라운드로빈을 짧게 유지한다).
    await page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-2"] input[type="checkbox"]').check();
    await page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-3"] input[type="checkbox"]').check();

    // 3. 간격 1초 선택.
    await page.getByRole("button", { name: "1초" }).click();

    // 4. 자동 감시 시작.
    await page.getByRole("button", { name: "자동 감시 시작" }).click();
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "WATCHING");

    // 5. 좌석 없음 반복 확인 (tick 1~4: candidate-2 1/2회차, candidate-3
    // 1/2회차 -- 아직 좌석 없음).
    for (let i = 0; i < 4; i += 1) {
      await page.clock.fastForward(1000);
    }
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "WATCHING");
    await expect(page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-2"]')).toHaveAttribute("data-check-count", "2");
    await expect(page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-3"]')).toHaveAttribute("data-check-count", "2");

    // 6. 5번째 tick: candidate-2가 자신의 3번째 확인에서 좌석 발견.
    await page.clock.fastForward(1000);
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "SEAT_FOUND");
    await expect(page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-2"]')).toHaveAttribute("data-candidate-status", "seat_found");

    // 7. 자동 구매클릭.
    await page.clock.fastForward(1000);
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "PURCHASE_CLICKING");

    // 8. 자동 예약 요청.
    await page.clock.fastForward(1000);
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "RESERVING");

    // 9. 결제 대기 -- 가상 예약번호·결제기한 표시.
    await page.clock.fastForward(1000);
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "PAYMENT_PENDING");
    const resultLocator = page.locator('[data-testid="demo-reservation-result"]');
    await expect(resultLocator).toBeVisible();
    const reservationNumber = await resultLocator.getAttribute("data-reservation-number");
    expect(reservationNumber).toMatch(/^RF-[A-Z0-9]{8}$/);
    const paymentDeadline = await resultLocator.getAttribute("data-payment-deadline");
    expect(paymentDeadline).toBeTruthy();

    // 10/11. 다른 후보(candidate-3) 자동 중단 표시 (동일 문구가 후보 목록
    // 카드/진행 카드/중단 후보 요약 섹션 세 곳에 표시되므로 .first()로 특정).
    await expect(page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-3"]')).toHaveAttribute("data-candidate-status", "stopped");
    await expect(page.getByText("다른 열차 예약 성공으로 자동 중단").first()).toBeVisible();

    // 12. 새로고침 후 예약 상태·경과 시간 복원 (sessionStorage).
    await page.clock.fastForward(5000); // 새로고침 전 경과 시간이 0이 아니게 만든다.
    const elapsedBeforeReload = await page.locator("text=/경과 시간/").innerText();
    await page.reload();
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "PAYMENT_PENDING");
    await expect(page.locator('[data-testid="demo-reservation-result"]')).toHaveAttribute("data-reservation-number", reservationNumber!);
    const elapsedAfterReload = await page.locator("text=/경과 시간/").innerText();
    expect(elapsedAfterReload).not.toBe("경과 시간 0분 00초");
    void elapsedBeforeReload;

    // 13. 결제 완료(사용자 클릭으로만 이뤄짐) -> COMPLETED.
    await page.getByRole("button", { name: "결제 완료" }).click();
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "COMPLETED");
  });

  // 1단계 결함 수정 검증: "입력한 시간대·인원·좌석등급이 실제 후보 선정과
  // 가상 예약에 반영되는지도 검증한다. 입력 UI만 있고 시나리오가 이를
  // 무시하면 결함으로 수정해라" -- 인원(passengers) 입력이 실제로
  // 자동 예약 성공 여부에 반영되는지 실제 브라우저로 확인한다. 이 fixture는
  // 두 후보 모두 항상 좌석이 1석만 나오므로, 2명을 요청하면 몇 번을
  // 확인하든 "좌석 발견"으로 넘어가면 안 된다(표시된 좌석 수가 요청 인원보다
  // 적을 때는 예약 성공으로 처리하지 않는다).
  test("인원 2명을 요청하면 좌석이 1석만 있는 후보는 예약 성공으로 이어지지 않는다", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto("/demo/booking-automation");

    await page.locator('[data-testid="demo-passengers-select"]').selectOption("2");
    await page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-2"] input[type="checkbox"]').check();
    await page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-3"] input[type="checkbox"]').check();
    await page.getByRole("button", { name: "1초" }).click();
    await page.getByRole("button", { name: "자동 감시 시작" }).click();

    // candidate-2가 자신의 3번째 확인(5번째 전체 tick)에 도달할 때까지 진행.
    for (let i = 0; i < 5; i += 1) {
      await page.clock.fastForward(1000);
    }
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "WATCHING", {
      timeout: 2000,
    });
    await expect(page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-2"]')).toHaveAttribute("data-candidate-status", "insufficient");
    await expect(page.getByText("좌석 부족(요청 인원 미달)").first()).toBeVisible();

    // 몇 회차를 더 진행해도 결코 SEAT_FOUND/PAYMENT_PENDING으로 넘어가지 않는다.
    for (let i = 0; i < 10; i += 1) {
      await page.clock.fastForward(1000);
    }
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "WATCHING");
  });

  // "좌석등급이 실제 후보 선정에 반영되는지" -- 일반실만 선호로 바꾸면 특실만
  // 나오는 후보(candidate-3)는 선택 자체가 불가능해야 한다.
  test("좌석등급을 일반실만으로 선택하면 특실 후보는 선택할 수 없다", async ({ page }) => {
    await page.goto("/demo/booking-automation");

    await page.getByRole("button", { name: "일반실만" }).click();
    const candidate3Row = page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-3"]');
    await expect(candidate3Row).toHaveAttribute("data-ineligible", "true");
    await expect(candidate3Row.locator('input[type="checkbox"]')).toBeDisabled();
    await expect(candidate3Row.getByText("선택 불가")).toBeVisible();

    // 일반실 후보(candidate-2)는 그대로 선택 가능해야 한다.
    const candidate2Row = page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-2"]');
    await expect(candidate2Row.locator('input[type="checkbox"]')).toBeEnabled();
  });

  // §4 결함 수정: "감시 기한과 결제기한은 구분한다. 결제기한이 지난 가상
  // 예약을 결제 완료로 변경할 수 없게 한다" -- 실제 브라우저 타이머(가상
  // clock)로 결제기한을 넘긴 뒤 "결제 완료" 버튼이 더 이상 동작하지 않고,
  // 대신 PAYMENT_EXPIRED로 자동 전이되어 "다시 감시"만 가능함을 확인한다.
  test("결제기한이 지나면 결제 완료로 전환할 수 없고 자동으로 결제기한 만료 상태가 된다", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto("/demo/booking-automation");

    await page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-2"] input[type="checkbox"]').check();
    await page.locator('[data-testid="demo-candidate-row"][data-candidate-id="auto-demo-candidate-3"] input[type="checkbox"]').check();
    await page.getByRole("button", { name: "1초" }).click();
    await page.getByRole("button", { name: "자동 감시 시작" }).click();

    // READY -> ... -> PAYMENT_PENDING까지 8번의 1초 tick.
    for (let i = 0; i < 8; i += 1) {
      await page.clock.fastForward(1000);
    }
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "PAYMENT_PENDING");
    await expect(page.getByRole("button", { name: "결제 완료" })).toBeVisible();

    // 결제기한(+10분)을 넘긴다.
    await page.clock.fastForward(11 * 60 * 1000);
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "PAYMENT_EXPIRED");
    await expect(page.getByRole("button", { name: "결제 완료" })).toHaveCount(0, { timeout: 2000 });
    await expect(page.getByText("결제기한 만료 · 가상 예약 취소됨")).toBeVisible();

    // "다시 감시"로 새 journey를 시작할 수 있다.
    await page.getByRole("button", { name: "다시 감시" }).click();
    await expect(page.locator('[data-testid="demo-status"]')).toHaveAttribute("data-status", "WATCHING");
  });
});
