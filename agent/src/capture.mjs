// 사이트 프로필 만들기(capture).
//
// 이 명령이 있는 이유는 하나다: 아무도 화면 문구를 추측하지 않게 하려고.
// 개발 환경에서는 공식 예매 화면에 접근할 수 없으므로, 사용자의 PC에서
// 실제 화면을 열고 거기서 관찰한 것만 프로필에 적는다.
//
// capture 가 기록하는 것:
//   - 실제로 방문한 주소(호스트 포함)
//   - 조회 폼의 라벨 문구 후보
//   - 결과 표에서 반복적으로 나타난 짧은 상태 문구 후보
//   - 버튼/링크의 접근성 이름 후보
//
// capture 가 기록하지 않는 것:
//   - DOM 전체, HTML 원문
//   - 쿠키/세션/토큰
//   - 사람 이름, 전화번호, 예약번호 원문 (redact.mjs 를 통과한 값만 남는다)
//
// 결과는 초안(draft)이다. 사용자가 읽고 어떤 문구가 "매진"이고 어떤 것이
// "예약 버튼"인지 확정한 뒤 verified 를 true 로 바꿔야 실행된다.

import { tempBrowserProfileDir } from "./config.mjs";
import { log } from "./log.mjs";
import { safeScreenText } from "./redact.mjs";
import { emptyProfile, saveProfile } from "./profile.mjs";

/** 화면에서 관찰 가능한 구조만 뽑는다. 값이 아니라 "라벨"을 모은다. */
const OBSERVE = () => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const formLabels = Array.from(
    document.querySelectorAll("input, select, textarea"),
  )
    .map((el) => {
      const id = el.getAttribute("id");
      const labelled = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return clean(
        el.getAttribute("aria-label") ||
          labelled?.textContent ||
          el.closest("label")?.textContent ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          "",
      );
    })
    .filter((s) => s && s.length <= 30);

  const controlNames = Array.from(
    document.querySelectorAll('button, a, [role="button"], input[type="submit"]'),
  )
    .map((el) => clean(el.getAttribute("aria-label") || el.textContent || el.getAttribute("value")))
    .filter((s) => s && s.length <= 30);

  // 결과 표의 짧은 셀 문구. 상태 표시(매진/예약가능 등)는 대개 짧다.
  const cellTexts = Array.from(document.querySelectorAll('[role="cell"], [role="gridcell"], td'))
    .map((el) => clean(el.textContent))
    .filter((s) => s && s.length <= 16);

  const headings = Array.from(document.querySelectorAll("h1, h2, h3, legend, caption"))
    .map((el) => clean(el.textContent))
    .filter((s) => s && s.length <= 40);

  return { url: location.href, host: location.hostname, formLabels, controlNames, cellTexts, headings };
};

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([text, count]) => ({ text: safeScreenText(text, 30), count }));
}

/**
 * 실제 화면을 열어 프로필 초안을 만든다.
 *
 * @param {object} options
 * @param {string} options.startUrl   사용자가 알려준 공식 예매 화면 주소
 * @param {object} options.playwright playwright 모듈
 * @param {() => boolean} options.isReadyForCapture  사용자가 "지금 화면을 기록" 을 눌렀는지
 * @param {number} options.timeoutMs
 */
export async function captureProfile({ startUrl, playwright, isReadyForCapture, timeoutMs = 20 * 60 * 1000 }) {
  const parsed = new URL(startUrl);
  if (parsed.protocol !== "https:") throw new Error("https 주소만 사용할 수 있습니다.");

  const userDataDir = tempBrowserProfileDir();
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(parsed.toString(), { waitUntil: "domcontentloaded" });
    log.info("capture: 화면을 열었습니다. 직접 로그인하고 조회 화면까지 이동해 주세요.", {
      host: parsed.hostname,
    });

    const snapshots = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isReadyForCapture()) {
        const observed = await page.evaluate(OBSERVE);
        // 다른 호스트로 넘어갔으면 기록하지 않는다.
        if (observed.host !== parsed.hostname) {
          log.warn("capture: 대상 호스트가 아닌 화면은 기록하지 않습니다.", { host: observed.host });
        } else {
          snapshots.push(observed);
          log.info("capture: 현재 화면을 기록했습니다.", {
            url: observed.url.split("?")[0],
            counts: {
              formLabels: observed.formLabels.length,
              controls: observed.controlNames.length,
              cells: observed.cellTexts.length,
            },
          });
        }
        // 한 번 기록했으면 사용자가 다시 누를 때까지 기다린다.
        while (isReadyForCapture() && Date.now() < deadline) await page.waitForTimeout(500);
      }
      await page.waitForTimeout(500);
      if (snapshots.length >= 6) break;
    }

    if (snapshots.length === 0) throw new Error("기록된 화면이 없습니다.");

    const draft = emptyProfile({ operator: "", host: parsed.hostname });
    draft.capturedAt = new Date().toISOString();
    draft.capturedFromUrl = snapshots[0].url.split("?")[0];
    draft.urls.searchEntry = snapshots[0].url.split("?")[0];
    draft.urls.reservationList = snapshots[snapshots.length - 1].url.split("?")[0];
    draft.observed = {
      formLabelCandidates: tally(snapshots.flatMap((s) => s.formLabels)),
      controlNameCandidates: tally(snapshots.flatMap((s) => s.controlNames)),
      statusTextCandidates: tally(snapshots.flatMap((s) => s.cellTexts)),
      headingCandidates: tally(snapshots.flatMap((s) => s.headings)),
      visitedUrls: [...new Set(snapshots.map((s) => s.url.split("?")[0]))],
    };
    draft.notes = [
      "이 파일은 capture 로 만든 초안입니다.",
      "observed 목록을 보고 vocabulary / formFields / urls 를 채운 뒤 verified 를 true 로 바꿔 주세요.",
      "채우기 전에는 Agent가 조회도 클릭도 하지 않습니다(PROVIDER_PROFILE_REQUIRED).",
    ].join(" ");

    const file = saveProfile("sr-srt", draft);
    log.info("capture: 프로필 초안을 저장했습니다.", { file });
    return { file, draft };
  } finally {
    await context.close().catch(() => {});
  }
}
