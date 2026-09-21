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
});
