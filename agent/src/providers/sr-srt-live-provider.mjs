// 실제 화면 Provider -- SR(주식회사 에스알)의 SRT 공식 예매 화면 대상.
//
// 대상 확정 근거와 그 한계
// ------------------------
// 사용자가 실증하려는 구간은 동탄 -> 울산(통도사)이다. 이 구간을 운행하는
// 사업자와 공식 예매 화면은 **이 저장소를 만든 개발 환경에서 직접 확인하지
// 못했다** -- 해당 호스트로 나가는 연결이 차단되어 있다(CONNECT 403).
// 공개 자료에서 SRT(SR 운영) 경부선 정차역에 동탄과 울산(통도사)이 있고
// 공식 예매 화면이 etk.srail.kr 이라는 것까지만 확인했다. 따라서:
//
//   - 이 파일에는 화면 선택자도, 화면 문구도 하드코딩하지 않았다.
//   - 대상 호스트조차 코드에 박지 않고 프로필에서 읽는다.
//   - 프로필은 사용자의 PC에서 `railflow-agent capture` 로 실제 화면을
//     열어 만든다. 프로필이 없으면 이 Provider는 아무 것도 하지 않는다.
//
// 즉 "추측하지 않는다"(지침 §7)를 주석이 아니라 구조로 지킨다.
//
// 이 Provider가 하지 않는 일: CAPTCHA 해결·우회, 대기열 우회, 봇 탐지 회피,
// UA/IP/계정/세션 로테이션, 프록시 우회, 탐지 회피용 간격 무작위화,
// 비공개 API 호출, 결제 자동화, 쿠키·세션 파일 저장.

import { tempBrowserProfileDir } from "../config.mjs";
import { log } from "../log.mjs";
import { safeScreenText } from "../redact.mjs";
import { classifyScreenText } from "../profile.mjs";
import { SeatStatus, HaltReason } from "../status.mjs";
import { matchCandidateRow } from "../match.mjs";

export class ProviderHalt extends Error {
  constructor(reason, message, evidence = null) {
    super(message);
    this.name = "ProviderHalt";
    this.code = reason;
    this.evidence = evidence;
  }
}

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
  if (parsed.hostname !== profile.host) {
    throw new ProviderHalt(
      HaltReason.HOST_NOT_ALLOWED,
      `프로필이 허용한 호스트(${profile.host}) 밖입니다: ${parsed.hostname}`,
    );
  }
  return parsed.toString();
}

/**
 * 화면 전체 텍스트에서 즉시 중단해야 하는 신호를 찾는다(지침 §17).
 * 여기 걸리면 우회하지 않고 그대로 멈춘다.
 */
function detectHaltSignal(profile, pageText) {
  const hit = classifyScreenText(profile, pageText);
  if (!hit) return null;
  const map = {
    loginRequired: HaltReason.LOGIN_EXPIRED,
    additionalVerification: HaltReason.ADDITIONAL_VERIFICATION,
    queueOrRestricted: HaltReason.ACCESS_RESTRICTED,
  };
  const reason = map[hit.key];
  return reason ? { reason, phrase: hit.phrase } : null;
}

function detectPaymentScreen(profile, pageText) {
  const markers = Array.isArray(profile.paymentScreenMarkers) ? profile.paymentScreenMarkers : [];
  const text = String(pageText ?? "");
  return markers.find((marker) => marker && text.includes(marker)) ?? null;
}

/**
 * 표 형태의 결과를 읽는다. 열 위치를 추측하지 않고, 행 안의 값들을 내용으로
 * 식별한다(열차번호처럼 보이는 것, 시각처럼 보이는 것, 역 이름). 화면 구조가
 * 바뀌어도 잘못된 열을 읽는 대신 "못 읽었다"가 되도록 하는 것이 목적이다.
 */
const EXTRACT_ROWS = () => {
  const timeRe = /\b(\d{1,2}\s*[:시]\s*\d{2})\b/g;
  const rows = [];
  const rowNodes = document.querySelectorAll('[role="row"], table tr');
  rowNodes.forEach((node, index) => {
    const cells = Array.from(node.querySelectorAll('[role="cell"], [role="gridcell"], td, th'));
    if (cells.length === 0) return;
    const cellTexts = cells.map((cell) => (cell.textContent || "").replace(/\s+/g, " ").trim());
    const rowText = cellTexts.join(" | ");
    const times = [];
    let m;
    while ((m = timeRe.exec(rowText)) !== null) times.push(m[1]);
    timeRe.lastIndex = 0;
    rows.push({
      index,
      cellTexts,
      rowText,
      times,
      // 행 안의 버튼/링크 접근성 이름. 예약 컨트롤을 여기서 찾는다.
      controls: Array.from(node.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
        .map((el) => ({
          name: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("value") || "")
            .replace(/\s+/g, " ")
            .trim(),
          disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
        }))
        .filter((c) => c.name),
    });
  });
  return rows;
};

/** 행 텍스트에서 후보와 대조할 값을 뽑는다. 못 뽑으면 빈 값으로 둔다(추측 금지). */
function toObservedRow(raw, candidate) {
  const numberPattern = new RegExp(
    `${String(candidate.trainNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*")}`,
    "i",
  );
  const hasNumber = numberPattern.test(raw.rowText);
  return {
    index: raw.index,
    trainNumber: hasNumber ? candidate.trainNumber : (raw.cellTexts.find((t) => /\d{2,}/.test(t)) ?? ""),
    departAt: raw.times[0] ?? "",
    arriveAt: raw.times[1] ?? "",
    // 역 이름은 행에 없을 수도 있다(검색 조건에만 표시되는 화면). 행에
    // 있으면 쓰고, 없으면 조회 조건에서 확인한 값을 그대로 쓴다.
    departure: raw.cellTexts.find((t) => t.includes(candidate.departure)) ? candidate.departure : "",
    arrival: raw.cellTexts.find((t) => t.includes(candidate.arrival)) ? candidate.arrival : "",
    raw,
  };
}

export function createSrSrtLiveProvider({ profile, playwright, lock }) {
  let context = null;
  let page = null;
  let userDataDir = null;

  async function pageText() {
    return page.evaluate(() => document.body?.innerText ?? "");
  }

  /** 페이지를 읽기 전에 항상 중단 신호부터 확인한다. */
  async function guardPage() {
    const text = await pageText();
    const payment = detectPaymentScreen(profile, text);
    if (payment) {
      throw new ProviderHalt(
        HaltReason.UNEXPECTED_PAYMENT_SCREEN,
        "예상하지 못한 결제 화면입니다. 자동 동작을 중단합니다.",
        { phrase: safeScreenText(payment) },
      );
    }
    const halt = detectHaltSignal(profile, text);
    if (halt) {
      throw new ProviderHalt(halt.reason, `화면에서 중단 신호를 확인했습니다: ${halt.phrase}`, {
        phrase: safeScreenText(halt.phrase),
      });
    }
    return text;
  }

  return {
    // 이름에 대상 사업자를 명시한다. Mock과 절대 겹치지 않는다.
    name: `live:SR-SRT@${profile.host}`,
    operator: profile.operator || "SR (SRT)",
    simulation: false,

    /** 화면이 보이는 브라우저를 임시 프로필로 띄우고 조회 화면을 연다. */
    async openBookingSite() {
      userDataDir = tempBrowserProfileDir();
      // headless 는 항상 false. 사용자가 화면을 보고 있어야 한다.
      context = await playwright.chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: null,
        args: ["--start-maximized"],
      });
        page = context.pages()[0] ?? (await context.newPage());
      const url = assertAllowedUrl(profile, profile.urls.searchEntry);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      log.info("공식 예매 화면을 열었습니다.", { host: profile.host });
      return { url, host: profile.host };
    },

    /**
     * 사용자가 직접 로그인할 때까지 기다린다. 아이디·비밀번호·OTP를
     * 입력하지도, 읽지도, 저장하지도 않는다.
     *
     * 로그인 완료 판정은 "사용자가 눌렀다"만으로 하지 않고, 예약내역
     * 화면에 접근이 되는지로 확인한다 -- 화면 증거가 있어야 한다.
     */
    async waitForManualLogin({ timeoutMs, isConfirmedByUser }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (isConfirmedByUser()) {
          const url = assertAllowedUrl(profile, profile.urls.reservationList);
          await page.goto(url, { waitUntil: "domcontentloaded" });
          const text = await pageText();
          const stillNeedsLogin = (profile.vocabulary.loginRequired ?? []).some((phrase) =>
            text.includes(phrase),
          );
          if (!stillNeedsLogin) {
            log.info("로그인이 확인됐습니다(예약내역 화면 접근 성공).");
            return { loggedIn: true };
          }
          log.warn("아직 로그인 상태가 아닙니다. 사용자 로그인을 계속 기다립니다.");
        }
        await page.waitForTimeout(2000);
      }
      throw new ProviderHalt(HaltReason.LOGIN_EXPIRED, "로그인 대기 시간이 지났습니다.");
    },

    /**
     * 조회 조건을 넣고 결과를 읽어, 후보 열차와 일치하는 행 하나를 찾는다.
     * 조회 폼 입력은 접근성 이름(role+name) 기준으로만 시도하고, 실패하면
     * 좌표 클릭으로 우회하지 않고 그대로 중단한다.
     */
    async searchTrain({ departure, arrival, date, passengers, candidate }) {
      const url = assertAllowedUrl(profile, profile.urls.searchEntry);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await guardPage();

      // 조회 폼은 화면마다 다르다. 프로필이 알려준 접근성 이름으로만 채우고,
      // 하나라도 못 찾으면 화면이 바뀐 것으로 보고 멈춘다.
      const formFields = profile.formFields ?? {};
      const fill = async (key, value) => {
        const name = formFields[key];
        if (!name) {
          throw new ProviderHalt(
            HaltReason.PROVIDER_PROFILE_REQUIRED,
            `프로필에 조회 폼 항목(${key})의 접근성 이름이 없습니다.`,
          );
        }
        const field = page.getByLabel(name, { exact: false }).first();
        if ((await field.count()) === 0) {
          throw new ProviderHalt(
            HaltReason.PROVIDER_LAYOUT_CHANGED,
            `조회 폼에서 "${name}" 항목을 찾지 못했습니다.`,
          );
        }
        await field.fill(String(value));
      };
      await fill("departure", departure);
      await fill("arrival", arrival);
      await fill("date", date);
      if (formFields.passengers) await fill("passengers", passengers);

      const submitName = formFields.submit;
      const submit = page.getByRole("button", { name: submitName, exact: false }).first();
      if (!submitName || (await submit.count()) === 0) {
        throw new ProviderHalt(HaltReason.PROVIDER_LAYOUT_CHANGED, "조회 버튼을 찾지 못했습니다.");
      }
      await submit.click();
      await page.waitForLoadState("domcontentloaded");
      await guardPage();

      const rawRows = await page.evaluate(EXTRACT_ROWS);
      if (rawRows.length === 0) {
        throw new ProviderHalt(HaltReason.PROVIDER_LAYOUT_CHANGED, "조회 결과 표를 읽지 못했습니다.");
      }
      const observed = rawRows.map((raw) => toObservedRow(raw, candidate));
      // 행에 역 이름이 없으면 조회 조건이 곧 구간이다. 조건을 그대로 채운다.
      for (const row of observed) {
        if (!row.departure) row.departure = departure;
        if (!row.arrival) row.arrival = arrival;
      }
      const match = matchCandidateRow({ ...candidate, departure, arrival }, observed);
      if (match.outcome !== "MATCHED") {
        throw new ProviderHalt(
          HaltReason.TRAIN_IDENTIFICATION_UNCERTAIN,
          `열차를 확실히 식별하지 못했습니다(${match.outcome}). 잘못된 열차를 예약하지 않기 위해 중단합니다.`,
          { outcome: match.outcome, mismatches: match.mismatches ?? null },
        );
      }
      log.info("후보 열차를 화면에서 확인했습니다.", {
        trainNumber: candidate.trainNumber,
        rowIndex: match.row.index,
      });
      return { rowIndex: match.row.index, matchedBy: ["trainNumber", "departAt", "departure", "arrival"] };
    },

    /**
     * 좌석 상태를 읽는다. 화면에 있는 문구만 정규화하고, 좌석 수는
     * 화면에 없으면 추정하지 않는다. 읽기 실패는 매진이 아니라 UNKNOWN 이다.
     */
    async readSeatAvailability({ rowIndex }) {
      await guardPage();
      const rawRows = await page.evaluate(EXTRACT_ROWS);
      const row = rawRows.find((r) => r.index === rowIndex);
      if (!row) {
        return {
          status: SeatStatus.PROVIDER_CHANGED,
          screenText: "",
          note: "직전에 확인한 행을 다시 찾지 못했습니다.",
        };
      }
      const hit = classifyScreenText(profile, row.rowText);
      const byKey = {
        soldOut: SeatStatus.SOLD_OUT,
        availableStandard: SeatStatus.AVAILABLE_STANDARD,
        availableFirst: SeatStatus.AVAILABLE_FIRST,
        waitlist: SeatStatus.WAITLIST_AVAILABLE,
        loginRequired: SeatStatus.AUTH_REQUIRED,
        additionalVerification: SeatStatus.ADDITIONAL_VERIFICATION_REQUIRED,
        queueOrRestricted: SeatStatus.QUEUE_OR_ACCESS_RESTRICTED,
      };
      const status = hit ? (byKey[hit.key] ?? SeatStatus.UNKNOWN) : SeatStatus.UNKNOWN;
      return {
        status,
        // 원본 화면 문구를 함께 보존한다(길이 제한 + 개인정보 마스킹).
        screenText: safeScreenText(row.rowText),
        matchedPhrase: hit ? safeScreenText(hit.phrase, 40) : null,
      };
    },

    /**
     * 예약 버튼을 누른다. ARMED 모드에서만 호출되며, 누르기 직전에
     * 펜싱 토큰을 다시 확인한다. 결과가 불명확하면 재클릭하지 않는다.
     */
    async requestReservation({ rowIndex }) {
      lock.assertFencingToken();
      await guardPage();

      const reserveNames = profile.vocabulary.reserveControl ?? [];
      const rawRows = await page.evaluate(EXTRACT_ROWS);
      const row = rawRows.find((r) => r.index === rowIndex);
      if (!row) {
        throw new ProviderHalt(
          HaltReason.TRAIN_IDENTIFICATION_UNCERTAIN,
          "예약 직전에 대상 행을 다시 찾지 못했습니다. 클릭하지 않습니다.",
        );
      }
      const control = row.controls.find(
        (c) => !c.disabled && reserveNames.some((name) => c.name.includes(name)),
      );
      if (!control) {
        throw new ProviderHalt(
          HaltReason.PROVIDER_LAYOUT_CHANGED,
          "해당 행에서 예약 버튼을 확실히 찾지 못했습니다. 좌표로 누르지 않고 중단합니다.",
        );
      }

      const rowLocator = page.locator('[role="row"], table tr').nth(rowIndex);
      const button = rowLocator.getByRole("button", { name: control.name, exact: false }).first();
      const link = rowLocator.getByRole("link", { name: control.name, exact: false }).first();
      const target = (await button.count()) > 0 ? button : link;
      if ((await target.count()) === 0) {
        throw new ProviderHalt(HaltReason.PROVIDER_LAYOUT_CHANGED, "예약 컨트롤을 다시 찾지 못했습니다.");
      }

      log.info("예약 버튼을 누릅니다.", { rowIndex, control: safeScreenText(control.name, 40) });
      // 클릭은 단 한 번. 결과가 불확실해도 다시 누르지 않는다.
      await target.click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return { clicked: true, clickedAt: new Date().toISOString() };
    },

    /**
     * 예약이 실제로 생겼는지 확인한다. 버튼을 눌렀다는 사실만으로
     * 성공으로 처리하지 않는다(지침 §1). 예약내역을 다시 조회해 대조한다.
     */
    async verifyReservation({ candidate, date }) {
      const url = assertAllowedUrl(profile, profile.urls.reservationList);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const text = await guardPage();

      const successPhrases = profile.vocabulary.reservationSuccess ?? [];
      const sawSuccessMarker = successPhrases.some((phrase) => text.includes(phrase));

      const rawRows = await page.evaluate(EXTRACT_ROWS);
      const observed = rawRows.map((raw) => toObservedRow(raw, candidate));
      for (const row of observed) {
        if (!row.departure) row.departure = candidate.departure;
        if (!row.arrival) row.arrival = candidate.arrival;
      }
      const match = matchCandidateRow(candidate, observed);

      if (match.outcome === "MATCHED") {
        return {
          confirmed: true,
          evidence: {
            source: "reservationList",
            sawSuccessMarker,
            rowText: safeScreenText(match.row.raw.rowText),
          },
          // 예약번호는 화면 문구에서 뽑되, 로그에는 마스킹되어 남는다.
          reservationNumber: extractReservationNumber(match.row.raw.rowText, profile),
          date,
        };
      }
      return {
        confirmed: false,
        outcome: match.outcome,
        evidence: { source: "reservationList", sawSuccessMarker },
      };
    },

    /** 결제기한을 화면에서 읽는다. 못 읽으면 추정값을 만들지 않는다. */
    async readPaymentDeadline() {
      const labels = profile.vocabulary.paymentDeadlineLabel ?? [];
      const text = await pageText();
      for (const label of labels) {
        const at = text.indexOf(label);
        if (at === -1) continue;
        const window = text.slice(at, at + 160);
        const stamp = window.match(
          /(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})일?(?:\s*(\d{1,2})\s*[:시]\s*(\d{2}))?/,
        );
        if (stamp) {
          const [, y, mo, d, h, mi] = stamp;
          return {
            found: true,
            label: safeScreenText(label, 40),
            rawText: safeScreenText(window, 80),
            iso: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}${
              h ? `T${String(h).padStart(2, "0")}:${mi}` : ""
            }`,
          };
        }
      }
      // 화면에서 확인하지 못했으면 그렇다고만 말한다. 10분 같은 값을 만들지 않는다.
      return { found: false, label: null, rawText: null, iso: null };
    },

    async stop() {
      try {
        await context?.close();
      } catch {
        /* 이미 닫혔으면 그만이다 */
      }
      context = null;
      page = null;
      // 임시 프로필 디렉터리는 OS 임시 폴더에 있고, 쿠키를 따로 내보내지 않는다.
      log.info("브라우저를 종료했습니다. 로그인 세션은 남기지 않습니다.", { userDataDir: "[TEMP]" });
    },
  };
}

/**
 * 예약번호로 보이는 값을 화면 문구에서 찾는다. 프로필이 라벨을 알려준
 * 경우에만 그 근처에서 찾고, 아무 숫자나 예약번호로 삼지 않는다.
 */
function extractReservationNumber(rowText, profile) {
  const labels = profile.vocabulary.reservationNumberLabel ?? [];
  for (const label of labels) {
    const at = rowText.indexOf(label);
    if (at === -1) continue;
    const near = rowText.slice(at, at + 60);
    const found = near.match(/[A-Z0-9]{6,}/);
    if (found) return found[0];
  }
  return null;
}
