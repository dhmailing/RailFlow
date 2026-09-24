// 실제 공식 예매 화면 Provider.
//
// 대상 사업자와 호스트를 파일 이름이나 코드로 먼저 정하지 않는다. 사용자가
// 실제로 연 화면의 호스트가 프로필에 기록되고, 이 Provider는 그 프로필만
// 따른다. 그래서 파일 이름도 사업자명이 아니라 역할로 지었다.
//
// 이 파일에는 선택자도, 화면 문구도, 호스트도 없다. 전부 프로필에서 온다.
//
// 하지 않는 일: CAPTCHA 해결·우회, 대기열 우회, 봇 탐지 회피,
// UA/IP/계정/세션 로테이션, 프록시 우회, 탐지 회피용 간격 무작위화,
// 비공개 API 호출, 결제 자동화, 쿠키·세션 파일 저장.

import { tempBrowserProfileDir } from "../config.mjs";
import { log } from "../log.mjs";
import { safeScreenText } from "../redact.mjs";
import { classifyScreenText, isHostAllowed } from "../profile.mjs";
import { computeFingerprint } from "../profile-signing.mjs";
import { READ_STRUCTURE, READ_ROWS_BY_PROFILE } from "../overlay.mjs";
import { SeatStatus, HaltReason } from "../status.mjs";
import { matchCandidateRow, normalizeTime, normalizeTrainNumber } from "../match.mjs";
import { ProviderHalt } from "./provider-halt.mjs";

export { ProviderHalt };

/** 프로필이 허용한 호스트 밖으로는 절대 나가지 않는다. */
function assertAllowedUrl(profile, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderHalt(HaltReason.HOST_NOT_ALLOWED, `주소 형식이 잘못됐습니다: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new ProviderHalt(HaltReason.HOST_NOT_ALLOWED, "https 가 아닌 주소로는 이동하지 않습니다.");
  }
  if (!isHostAllowed(profile, parsed.hostname)) {
    throw new ProviderHalt(
      HaltReason.HOST_NOT_ALLOWED,
      `허용 호스트 밖입니다: ${parsed.hostname} (허용: ${[profile.host, ...(profile.allowedHosts ?? [])].join(", ")})`,
    );
  }
  return parsed.toString();
}

/** 좌석 칸의 문구 -> 정규화 상태. 프로필 어휘로만 판정한다. */
function seatStatusFromText(profile, text, kind) {
  const hit = classifyScreenText(profile, text);
  if (!hit) return { status: SeatStatus.UNKNOWN, phrase: null };
  const map = {
    soldOut: SeatStatus.SOLD_OUT,
    availableStandard: SeatStatus.AVAILABLE_STANDARD,
    availableFirst: SeatStatus.AVAILABLE_FIRST,
    waitlist: SeatStatus.WAITLIST_AVAILABLE,
    standingRoom: SeatStatus.WAITLIST_AVAILABLE,
    loginRequired: SeatStatus.AUTH_REQUIRED,
    additionalVerification: SeatStatus.ADDITIONAL_VERIFICATION_REQUIRED,
    queueOrRestricted: SeatStatus.QUEUE_OR_ACCESS_RESTRICTED,
  };
  let status = map[hit.key] ?? SeatStatus.UNKNOWN;
  // 어느 칸에서 읽었는지에 따라 등급을 맞춘다. 일반실 칸에서 "예약가능"을
  // 읽었는데 특실로 기록하면 안 되기 때문이다.
  if (status === SeatStatus.AVAILABLE_STANDARD && kind === "first") status = SeatStatus.AVAILABLE_FIRST;
  if (status === SeatStatus.AVAILABLE_FIRST && kind === "standard") status = SeatStatus.AVAILABLE_STANDARD;
  return { status, phrase: hit.phrase };
}

/**
 * @param {object} options
 * @param {object} options.profile  서명 검증을 통과한 프로필
 * @param {object} options.playwright
 * @param {object} options.lock
 * @param {boolean} [options.allowReservation=false]
 *   false 면 requestReservation 이 아예 동작하지 않는다. 읽기 전용 실증에서는
 *   항상 false 로 만들어, 코드 결함이 있어도 예약 클릭이 불가능하게 한다.
 */
export function createLiveBookingProvider({ profile, playwright, lock, allowReservation = false }) {
  let context = null;
  let page = null;

  async function pageText() {
    return page.evaluate(() => document.body?.innerText ?? "");
  }

  function currentFingerprint(structure) {
    return computeFingerprint({
      formLabels: structure.formLabels,
      controlNames: structure.controlNames,
      rowCellCount: profile.row.cellCount,
      rowContainerTag: profile.row.containerTag,
      landmarkCounts: structure.landmarkCounts,
    });
  }

  /** 페이지를 읽기 전에 항상 중단 신호부터 확인한다. */
  async function guardPage({ checkFingerprint = false } = {}) {
    const host = await page.evaluate(() => location.hostname);
    if (!isHostAllowed(profile, host)) {
      throw new ProviderHalt(HaltReason.HOST_NOT_ALLOWED, `외부 호스트로 이동했습니다: ${host}`);
    }

    const text = await pageText();

    for (const marker of profile.guardMarkers?.paymentScreen ?? []) {
      if (marker && text.includes(marker)) {
        throw new ProviderHalt(
          HaltReason.UNEXPECTED_PAYMENT_SCREEN,
          "예상하지 못한 결제 화면입니다. 자동 동작을 중단합니다.",
          { phrase: safeScreenText(marker) },
        );
      }
    }
    for (const marker of profile.guardMarkers?.reservationScreen ?? []) {
      if (marker && text.includes(marker)) {
        throw new ProviderHalt(
          HaltReason.UNEXPECTED_RESERVATION_SCREEN,
          "예상하지 못한 예약 화면입니다. 읽기 전용 단계에서는 여기로 넘어가면 안 됩니다.",
          { phrase: safeScreenText(marker) },
        );
      }
    }

    const hit = classifyScreenText(profile, text);
    const haltMap = {
      loginRequired: HaltReason.LOGIN_EXPIRED,
      additionalVerification: HaltReason.ADDITIONAL_VERIFICATION,
      queueOrRestricted: HaltReason.ACCESS_RESTRICTED,
    };
    if (hit && haltMap[hit.key]) {
      throw new ProviderHalt(haltMap[hit.key], `화면에서 중단 신호를 확인했습니다: ${hit.phrase}`, {
        phrase: safeScreenText(hit.phrase),
      });
    }

    if (checkFingerprint) {
      const structure = await page.evaluate(READ_STRUCTURE);
      const now = currentFingerprint(structure);
      if (now !== profile.fingerprint) {
        throw new ProviderHalt(
          HaltReason.PROFILE_FINGERPRINT_MISMATCH,
          "화면 구조가 프로필을 만들 때와 다릅니다. 잘못된 요소를 읽지 않기 위해 중단합니다. 공식 화면 연결을 다시 진행해 주세요.",
          { expected: profile.fingerprint.slice(0, 8), actual: now.slice(0, 8) },
        );
      }
    }
    return text;
  }

  return {
    // 이름에 대상 사업자와 호스트가 들어간다. Mock 과 절대 겹치지 않는다.
    name: `live:${profile.operator || "미확인사업자"}@${profile.host}`,
    operator: profile.operator || "(화면에서 확인 필요)",
    host: profile.host,
    simulation: false,
    reservationEnabled: allowReservation,

    async openBookingSite() {
      context = await playwright.chromium.launchPersistentContext(tempBrowserProfileDir(), {
        headless: false,
        viewport: null,
        args: ["--start-maximized"],
      });
      page = context.pages()[0] ?? (await context.newPage());
      const url = assertAllowedUrl(profile, profile.pages.search.url);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      log.info("공식 예매 화면을 열었습니다.", { host: profile.host });
      return { url, host: profile.host };
    },

    /**
     * 사용자가 직접 로그인할 때까지 기다린다. 아이디·비밀번호·OTP를
     * 입력하지도, 읽지도, 저장하지도 않는다. 로그인 판정은 버튼을 눌렀다는
     * 사실이 아니라 예약내역 화면에 실제로 접근되는지로 한다.
     */
    async waitForManualLogin({ timeoutMs, isConfirmedByUser }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (isConfirmedByUser()) {
          const url = assertAllowedUrl(profile, profile.pages.reservationList.url);
          await page.goto(url, { waitUntil: "domcontentloaded" });
          const text = await pageText();
          const stillNeedsLogin = (profile.detectors.loginRequired ?? []).some((phrase) =>
            text.includes(phrase),
          );
          if (!stillNeedsLogin) {
            log.info("로그인이 확인됐습니다(예약내역 화면 접근 성공).");
            return { loggedIn: true };
          }
          log.warn("아직 로그인 상태가 아닙니다. 계속 기다립니다.");
        }
        await page.waitForTimeout(2000);
      }
      throw new ProviderHalt(HaltReason.LOGIN_EXPIRED, "로그인 대기 시간이 지났습니다.");
    },

    /**
     * 조회 조건을 넣고 결과에서 후보 열차 행 하나를 특정한다.
     * 폼 항목은 프로필이 기록한 접근성 이름으로만 찾고, 못 찾으면 좌표
     * 클릭으로 우회하지 않고 중단한다.
     */
    async searchTrain({ departure, arrival, date, passengers, candidate }) {
      const url = assertAllowedUrl(profile, profile.pages.search.url);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await guardPage();

      const fill = async (key, value) => {
        const name = profile.form[key];
        if (!name) return false;
        const field = page.getByLabel(name, { exact: false }).first();
        if ((await field.count()) === 0) {
          throw new ProviderHalt(
            HaltReason.PROVIDER_LAYOUT_CHANGED,
            `조회 폼에서 "${name}" 항목을 찾지 못했습니다.`,
          );
        }
        await field.fill(String(value));
        return true;
      };
      await fill("departure", departure);
      await fill("arrival", arrival);
      await fill("date", date);
      if (profile.form.passengers) await fill("passengers", passengers);

      const submit = page.getByRole("button", { name: profile.form.submit, exact: false }).first();
      if ((await submit.count()) === 0) {
        throw new ProviderHalt(HaltReason.PROVIDER_LAYOUT_CHANGED, "조회 버튼을 찾지 못했습니다.");
      }
      await submit.click();
      await page.waitForLoadState("domcontentloaded");
      await guardPage({ checkFingerprint: true });

      const rows = await page.evaluate(READ_ROWS_BY_PROFILE, profile.row);
      const usable = rows.filter((row) => row.resolvedAll);
      if (usable.length === 0) {
        throw new ProviderHalt(
          HaltReason.PROVIDER_LAYOUT_CHANGED,
          "조회 결과에서 프로필이 지정한 위치를 찾지 못했습니다.",
        );
      }

      const observed = usable.map((row) => ({
        index: row.index,
        trainNumber: row.fields.trainNumber ?? "",
        departAt: row.fields.departAt ?? "",
        arriveAt: row.fields.arriveAt ?? "",
        departure,
        arrival,
      }));
      const match = matchCandidateRow({ ...candidate, departure, arrival }, observed);
      if (match.outcome !== "MATCHED") {
        throw new ProviderHalt(
          HaltReason.TRAIN_IDENTIFICATION_UNCERTAIN,
          `열차를 확실히 식별하지 못했습니다(${match.outcome}). 잘못된 열차를 읽지 않기 위해 중단합니다.`,
          { outcome: match.outcome, mismatches: match.mismatches ?? null },
        );
      }
      log.info("후보 열차를 화면에서 확인했습니다.", {
        trainNumber: candidate.trainNumber,
        rowIndex: match.row.index,
      });
      return {
        rowIndex: match.row.index,
        matchedBy: ["trainNumber", "departAt", "departure", "arrival"],
        searchedAt: new Date().toISOString(),
      };
    },

    /**
     * 좌석 상태를 읽는다. 일반실·특실을 각각의 칸에서 따로 읽고, 원본 문구를
     * 함께 보존한다. 좌석 수가 화면에 없으면 숫자를 만들지 않는다.
     * 읽기 실패는 매진이 아니라 UNKNOWN 이다.
     */
    async readSeatAvailability({ rowIndex, seatPreference = "any" }) {
      await guardPage({ checkFingerprint: true });
      const rows = await page.evaluate(READ_ROWS_BY_PROFILE, profile.row);
      const row = rows.find((r) => r.index === rowIndex);
      if (!row || !row.resolvedAll) {
        return {
          status: SeatStatus.PROVIDER_CHANGED,
          standard: null,
          first: null,
          screenText: "",
          note: "직전에 확인한 행을 다시 해석하지 못했습니다.",
          readAt: new Date().toISOString(),
        };
      }

      const standardText = row.fields.standardSeat ?? "";
      const firstText = row.fields.firstSeat ?? "";
      const standard = seatStatusFromText(profile, standardText, "standard");
      const first = firstText ? seatStatusFromText(profile, firstText, "first") : null;

      // 조건에 맞는 등급을 우선 고른다. 둘 다 없으면 읽은 그대로 돌려준다.
      const pick = () => {
        if (seatPreference === "standard_only") return standard.status;
        if (seatPreference === "first_only") return first?.status ?? SeatStatus.UNKNOWN;
        if (standard.status === SeatStatus.AVAILABLE_STANDARD) return standard.status;
        if (first?.status === SeatStatus.AVAILABLE_FIRST) return first.status;
        // 둘 다 예약 가능이 아니면, 중단 신호가 있으면 그것을 우선한다.
        for (const candidate of [standard.status, first?.status]) {
          if (
            candidate === SeatStatus.AUTH_REQUIRED ||
            candidate === SeatStatus.ADDITIONAL_VERIFICATION_REQUIRED ||
            candidate === SeatStatus.QUEUE_OR_ACCESS_RESTRICTED
          ) {
            return candidate;
          }
        }
        if (standard.status === SeatStatus.SOLD_OUT && (!first || first.status === SeatStatus.SOLD_OUT)) {
          return SeatStatus.SOLD_OUT;
        }
        if (standard.status === SeatStatus.WAITLIST_AVAILABLE || first?.status === SeatStatus.WAITLIST_AVAILABLE) {
          return SeatStatus.WAITLIST_AVAILABLE;
        }
        return SeatStatus.UNKNOWN;
      };

      return {
        status: pick(),
        // 등급별 원본 문구를 그대로 보존한다(마스킹 + 길이 제한).
        standard: { status: standard.status, screenText: safeScreenText(standardText, 40) },
        first: first ? { status: first.status, screenText: safeScreenText(firstText, 40) } : null,
        screenText: safeScreenText([standardText, firstText].filter(Boolean).join(" / "), 80),
        trainNumber: safeScreenText(row.fields.trainNumber ?? "", 30),
        departAt: normalizeTime(row.fields.departAt ?? ""),
        arriveAt: normalizeTime(row.fields.arriveAt ?? ""),
        readAt: new Date().toISOString(),
        sourceHost: profile.host,
      };
    },

    /**
     * 예약 버튼 클릭. 읽기 전용으로 만든 Provider 에서는 아예 동작하지 않는다.
     * 승인 단계가 도입되기 전까지는 이 경로로 들어올 수 없다.
     */
    async requestReservation() {
      if (!allowReservation) {
        throw new ProviderHalt(
          HaltReason.RESERVATION_NOT_ARMED,
          "읽기 전용 모드에서는 예약 동작을 수행할 수 없습니다.",
        );
      }
      lock.assertFencingToken();
      throw new ProviderHalt(
        HaltReason.RESERVATION_NOT_ARMED,
        "실제 예약 단계는 읽기 전용 실증이 끝난 뒤 별도 승인으로 활성화합니다.",
      );
    },

    /** 예약내역 확인(읽기 전용). 예약을 만들지 않는다. */
    async verifyReservation({ candidate, date }) {
      const url = assertAllowedUrl(profile, profile.pages.reservationList.url);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await guardPage();
      const rows = await page.evaluate(READ_ROWS_BY_PROFILE, profile.row);
      const usable = rows.filter((row) => row.resolvedAll);
      const observed = usable.map((row) => ({
        index: row.index,
        trainNumber: row.fields.trainNumber ?? "",
        departAt: row.fields.departAt ?? "",
        arriveAt: row.fields.arriveAt ?? "",
        departure: candidate.departure,
        arrival: candidate.arrival,
      }));
      const match = matchCandidateRow(candidate, observed);
      return {
        confirmed: match.outcome === "MATCHED",
        outcome: match.outcome,
        evidence: { source: "reservationList", checkedAt: new Date().toISOString() },
        date,
      };
    },

    /** 결제기한은 이번 단계에서 읽지 않는다. 추정값도 만들지 않는다. */
    async readPaymentDeadline() {
      return { found: false, label: null, rawText: null, iso: null, note: "읽기 전용 단계에서는 읽지 않습니다." };
    },

    async stop() {
      try {
        await context?.close();
      } catch {
        /* 이미 닫혔으면 그만이다 */
      }
      context = null;
      page = null;
      log.info("브라우저를 종료했습니다. 로그인 세션은 남기지 않습니다.");
    },

    /** 현재 열린 화면의 구조 지문. 진단용. */
    async currentFingerprint() {
      const structure = await page.evaluate(READ_STRUCTURE);
      return currentFingerprint(structure);
    },

    /** 진단용: 조회 결과에서 열차번호로 보이는 값이 몇 개 읽히는지. */
    async probeRowCount() {
      const rows = await page.evaluate(READ_ROWS_BY_PROFILE, profile.row);
      return {
        total: rows.length,
        resolved: rows.filter((row) => row.resolvedAll).length,
        withTrainNumber: rows.filter((row) => normalizeTrainNumber(row.fields.trainNumber ?? "").length >= 3).length,
      };
    },
  };
}
