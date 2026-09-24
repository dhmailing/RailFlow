// 프로필 캡처 마법사.
//
// 사용자는 JSON을 열지 않는다. 실제 화면 위에서 "여기가 열차 행",
// "여기가 일반실 상태" 를 클릭하면 Agent가 의미 구조만 뽑아 프로필을 만들고,
// 자동 검증에 통과했을 때만 서명한다.
//
// 저장하지 않는 것: DOM/HTML 원문, 쿠키, 세션, 이름·회원번호·전화번호·
// 이메일·예약번호·결제정보. 화면 문구는 마스킹 후 길이를 제한해 최소한만
// 남긴다.

import { tempBrowserProfileDir } from "./config.mjs";
import { log } from "./log.mjs";
import { safeScreenText } from "./redact.mjs";
import { overlayScript, REMOVE_OVERLAY, READ_STRUCTURE, READ_ROWS_BY_PROFILE } from "./overlay.mjs";
import { computeFingerprint } from "./profile-signing.mjs";
import { emptyProfile, finalizeProfile, saveProfile, ProfileError } from "./profile.mjs";
import { normalizeTime, normalizeTrainNumber } from "./match.mjs";

/** 마법사 단계. 로컬 화면이 이 순서대로 안내한다. */
export const CAPTURE_STEPS = Object.freeze([
  { id: "OPEN", title: "공식 화면 열기", hint: "브라우저가 열립니다." },
  { id: "LOGIN", title: "직접 로그인", hint: "열린 브라우저에서 직접 로그인해 주세요." },
  { id: "SEARCH", title: "열차 조회", hint: "동탄 → 울산(통도사) 를 조회해 결과 목록을 띄워 주세요." },
  { id: "PICK_ROW", title: "열차 행 지정", hint: "열차 한 편이 표시된 줄을 클릭해 주세요." },
  { id: "PICK_TRAIN_NUMBER", title: "열차번호 지정", hint: "그 줄에서 열차번호가 보이는 곳을 클릭해 주세요." },
  { id: "PICK_DEPART", title: "출발시각 지정", hint: "출발시각이 보이는 곳을 클릭해 주세요." },
  { id: "PICK_ARRIVE", title: "도착시각 지정", hint: "도착시각이 보이는 곳을 클릭해 주세요." },
  { id: "PICK_STANDARD", title: "일반실 상태 지정", hint: "일반실 상태(예: 매진/예약가능)가 보이는 곳을 클릭해 주세요." },
  { id: "PICK_FIRST", title: "특실 상태 지정", hint: "특실 상태가 보이는 곳을 클릭해 주세요. 없으면 건너뛸 수 있습니다." },
  { id: "PICK_FORM", title: "조회 조건 지정", hint: "출발역·도착역·날짜 입력칸과 조회 버튼을 차례로 클릭해 주세요." },
  { id: "RESERVATION_LIST", title: "예약내역 화면", hint: "예약내역 화면으로 이동해 주세요." },
  { id: "VERIFY", title: "자동 검증", hint: "Agent가 같은 화면을 다시 읽어 확인합니다." },
  { id: "DONE", title: "완료", hint: "프로필이 검증·서명됐습니다." },
]);

const FORM_FIELD_ORDER = ["departure", "arrival", "date", "passengers", "submit"];
const FORM_FIELD_LABEL = {
  departure: "출발역 입력칸",
  arrival: "도착역 입력칸",
  date: "날짜 입력칸",
  passengers: "인원 입력칸 (없으면 건너뛰기)",
  submit: "조회 버튼",
};

export class CaptureSession {
  #playwright;
  #context = null;
  #page = null;
  #profile;
  #step = "OPEN";
  #pending = null;
  #formIndex = 0;
  #listeners = new Set();
  #expectation;
  #message = null;
  #error = null;
  #structures = [];
  #finished = false;
  #savedPath = null;

  /**
   * @param {object} options
   * @param {object} options.playwright
   * @param {{departure:string, arrival:string}} options.expectation 캡처 중 조회한 구간(교차확인용)
   */
  constructor({ playwright, expectation }) {
    this.#playwright = playwright;
    this.#expectation = expectation;
    this.#profile = emptyProfile();
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    const snap = this.snapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snap);
      } catch (error) {
        log.warn("캡처 상태 구독자 오류", { error });
      }
    }
  }

  snapshot() {
    const meta = CAPTURE_STEPS.find((step) => step.id === this.#step) ?? CAPTURE_STEPS[0];
    return {
      step: this.#step,
      title: meta.title,
      hint:
        this.#step === "PICK_FORM"
          ? `${FORM_FIELD_LABEL[FORM_FIELD_ORDER[this.#formIndex]]} 을(를) 클릭해 주세요.`
          : meta.hint,
      steps: CAPTURE_STEPS.map((s) => ({ id: s.id, title: s.title })),
      host: this.#profile.host || null,
      operator: this.#profile.operator || null,
      message: this.#message,
      error: this.#error,
      finished: this.#finished,
      savedPath: this.#savedPath,
      // 어떤 항목이 채워졌는지만 보여준다. 값(선택자)은 화면에 내보내지 않는다.
      collected: {
        row: Boolean(this.#profile.row.containerTag),
        trainNumber: Boolean(this.#profile.row.fieldPaths.trainNumber),
        departAt: Boolean(this.#profile.row.fieldPaths.departAt),
        arriveAt: Boolean(this.#profile.row.fieldPaths.arriveAt),
        standardSeat: Boolean(this.#profile.row.fieldPaths.standardSeat),
        firstSeat: Boolean(this.#profile.row.fieldPaths.firstSeat),
        form: FORM_FIELD_ORDER.filter((key) => this.#profile.form[key]),
        detectors: Object.fromEntries(
          Object.entries(this.#profile.detectors).map(([key, list]) => [key, list.length]),
        ),
        reservationList: Boolean(this.#profile.pages.reservationList.url),
      },
    };
  }

  /** 1단계: 브라우저를 열고 사용자가 로그인할 때까지 기다린다. */
  async open(startUrl) {
    const parsed = new URL(startUrl);
    if (parsed.protocol !== "https:") throw new Error("https 주소만 사용할 수 있습니다.");

    this.#context = await this.#playwright.chromium.launchPersistentContext(tempBrowserProfileDir(), {
      headless: false,
      viewport: null,
      args: ["--start-maximized"],
    });
    this.#page = this.#context.pages()[0] ?? (await this.#context.newPage());

    // 오버레이가 결과를 돌려주는 통로. 페이지가 Agent에 값을 보내는 유일한 길이다.
    await this.#page.exposeBinding("__railflowPick", (_source, payload) => {
      this.#pending = payload;
    });

    await this.#page.goto(parsed.toString(), { waitUntil: "domcontentloaded" });
    // 호스트는 사용자가 실제로 연 화면에서 가져온다. 미리 정하지 않는다.
    this.#profile.host = await this.#page.evaluate(() => location.hostname);
    this.#profile.allowedHosts = [this.#profile.host];
    this.#profile.pages.search.url = (await this.#page.url()).split("?")[0];
    this.#step = "LOGIN";
    this.#message = "브라우저에서 직접 로그인한 뒤, 이 화면에서 [로그인 완료] 를 눌러 주세요.";
    log.info("캡처: 공식 화면을 열었습니다.", { host: this.#profile.host });
    this.#emit();
    return this.snapshot();
  }

  /** 사용자가 로그인을 마쳤다고 알린다. */
  async confirmLogin() {
    this.#assertStep("LOGIN");
    await this.#assertSameHost();
    this.#step = "SEARCH";
    this.#message = "동탄 → 울산(통도사) 를 조회해 결과 목록을 띄운 뒤 [조회 완료] 를 눌러 주세요.";
    this.#emit();
    return this.snapshot();
  }

  /** 사용자가 조회 결과를 띄웠다고 알린다. 여기서 구조를 한 번 기록한다. */
  async confirmSearch() {
    this.#assertStep("SEARCH");
    await this.#assertSameHost();
    this.#profile.pages.search.url = this.#page.url().split("?")[0];
    this.#profile.pages.search.kind = "searchResult";
    this.#structures.push(await this.#page.evaluate(READ_STRUCTURE));
    this.#step = "PICK_ROW";
    await this.#arm("열차 한 편이 표시된 줄을 클릭해 주세요.", "PICK_ROW", true);
    return this.snapshot();
  }

  /** 오버레이를 띄우고 클릭을 기다린다. */
  async #arm(prompt, step, scopeToRow) {
    this.#pending = null;
    await this.#page.evaluate(overlayScript({ prompt, step, scopeToRow }));
    this.#message = prompt;
    this.#emit();
  }

  /**
   * 사용자가 화면에서 요소를 클릭할 때까지 기다린 뒤 프로필에 반영한다.
   * 로컬 화면이 이 메서드를 반복 호출하며 진행한다.
   */
  async awaitPick({ timeoutMs = 5 * 60 * 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#pending) {
        const payload = this.#pending;
        this.#pending = null;
        if (payload.cancelled) {
          this.#message = "선택을 취소했습니다. 다시 눌러 주세요.";
          await this.#arm(this.snapshot().hint, this.#step, this.#step !== "PICK_FORM");
          continue;
        }
        await this.#applyPick(payload);
        return this.snapshot();
      }
      await this.#page.waitForTimeout(200);
    }
    throw new Error("선택을 기다리는 시간이 지났습니다.");
  }

  async #applyPick(payload) {
    if (payload.host && payload.host !== this.#profile.host) {
      throw new ProfileError("HOST_NOT_ALLOWED", `다른 호스트(${payload.host})의 화면은 기록하지 않습니다.`);
    }
    const { picked, row, text } = payload;

    switch (this.#step) {
      case "PICK_ROW": {
        this.#profile.row.containerTag = row.tag;
        this.#profile.row.containerRole = row.role;
        this.#profile.row.cellCount = row.cellCount;
        this.#profile.row.rowIndexHint = row.rowIndexHint;
        this.#step = "PICK_TRAIN_NUMBER";
        await this.#arm("그 줄에서 열차번호가 보이는 곳을 클릭해 주세요.", "PICK_TRAIN_NUMBER", true);
        break;
      }
      case "PICK_TRAIN_NUMBER":
        this.#profile.row.fieldPaths.trainNumber = picked;
        this.#step = "PICK_DEPART";
        await this.#arm("출발시각이 보이는 곳을 클릭해 주세요.", "PICK_DEPART", true);
        break;
      case "PICK_DEPART":
        this.#profile.row.fieldPaths.departAt = picked;
        this.#step = "PICK_ARRIVE";
        await this.#arm("도착시각이 보이는 곳을 클릭해 주세요.", "PICK_ARRIVE", true);
        break;
      case "PICK_ARRIVE":
        this.#profile.row.fieldPaths.arriveAt = picked;
        this.#step = "PICK_STANDARD";
        await this.#arm("일반실 상태가 보이는 곳을 클릭해 주세요.", "PICK_STANDARD", true);
        break;
      case "PICK_STANDARD":
        this.#profile.row.fieldPaths.standardSeat = picked;
        // 클릭한 칸의 현재 문구를 상태 어휘의 출발점으로 삼는다.
        this.#rememberDetector(text);
        this.#step = "PICK_FIRST";
        await this.#arm("특실 상태가 보이는 곳을 클릭해 주세요.", "PICK_FIRST", true);
        break;
      case "PICK_FIRST":
        this.#profile.row.fieldPaths.firstSeat = picked;
        this.#rememberDetector(text);
        this.#step = "PICK_FORM";
        this.#formIndex = 0;
        await this.#arm(`${FORM_FIELD_LABEL.departure} 을(를) 클릭해 주세요.`, "PICK_FORM", false);
        break;
      case "PICK_FORM": {
        const key = FORM_FIELD_ORDER[this.#formIndex];
        this.#profile.form[key] = picked.name;
        this.#formIndex += 1;
        if (this.#formIndex < FORM_FIELD_ORDER.length) {
          await this.#arm(
            `${FORM_FIELD_LABEL[FORM_FIELD_ORDER[this.#formIndex]]} 을(를) 클릭해 주세요.`,
            "PICK_FORM",
            false,
          );
        } else {
          await this.#page.evaluate(REMOVE_OVERLAY);
          this.#step = "RESERVATION_LIST";
          this.#message = "예약내역 화면으로 이동한 뒤 [예약내역 확인] 을 눌러 주세요.";
          this.#emit();
        }
        break;
      }
      default:
        throw new Error(`이 단계에서는 요소를 고를 수 없습니다: ${this.#step}`);
    }
  }

  /** 특실 등 없는 항목을 건너뛴다. */
  async skipCurrentPick() {
    if (this.#step === "PICK_FIRST") {
      this.#step = "PICK_FORM";
      this.#formIndex = 0;
      await this.#arm(`${FORM_FIELD_LABEL.departure} 을(를) 클릭해 주세요.`, "PICK_FORM", false);
      return this.snapshot();
    }
    if (this.#step === "PICK_FORM" && FORM_FIELD_ORDER[this.#formIndex] === "passengers") {
      this.#formIndex += 1;
      await this.#arm(`${FORM_FIELD_LABEL.submit} 을(를) 클릭해 주세요.`, "PICK_FORM", false);
      return this.snapshot();
    }
    throw new Error("이 단계는 건너뛸 수 없습니다.");
  }

  /**
   * 화면에서 읽은 상태 문구를 어휘로 기록한다. 사용자가 어떤 뜻인지
   * 고르게 하는 대신, 클릭한 칸의 문구를 그대로 후보로 두고 검증 단계에서
   * 사용자가 확인한다. 개인정보가 섞이지 않도록 짧은 문구만 받는다.
   */
  #rememberDetector(text) {
    const value = safeScreenText(text, 20);
    if (!value || value.length > 20) return;
    if (!this.#profile.detectors.observedSeatTexts) this.#profile.detectors.observedSeatTexts = [];
    if (!this.#profile.detectors.observedSeatTexts.includes(value)) {
      this.#profile.detectors.observedSeatTexts.push(value);
    }
  }

  /**
   * 사용자가 화면에서 본 상태 문구를 뜻별로 확정한다. 로컬 화면이
   * 관찰된 문구를 보여주고 사용자가 분류한 결과를 여기로 보낸다.
   */
  setDetectors(mapping) {
    for (const [key, phrases] of Object.entries(mapping ?? {})) {
      if (!(key in this.#profile.detectors)) continue;
      this.#profile.detectors[key] = [...new Set(
        (Array.isArray(phrases) ? phrases : [])
          .map((phrase) => safeScreenText(phrase, 20))
          .filter(Boolean),
      )];
    }
    this.#emit();
    return this.snapshot();
  }

  /** 예약내역 화면을 기록한다. */
  async confirmReservationList() {
    this.#assertStep("RESERVATION_LIST");
    await this.#assertSameHost();
    this.#profile.pages.reservationList.url = this.#page.url().split("?")[0];
    this.#profile.pages.reservationList.kind = "reservationList";
    this.#structures.push(await this.#page.evaluate(READ_STRUCTURE));
    this.#step = "VERIFY";
    this.#message = "조회 화면으로 돌아가 [자동 검증 시작] 을 눌러 주세요.";
    this.#emit();
    return this.snapshot();
  }

  /**
   * 자동 검증. 사용자가 고른 위치로 같은 화면을 다시 읽어, 지정한 자리에서
   * 실제로 열차번호·시각·좌석 상태가 나오는지 확인한다. 하나라도 어긋나면
   * 서명하지 않는다.
   */
  async verifyAndSign() {
    this.#assertStep("VERIFY");
    await this.#assertSameHost();

    // 조회 화면으로 돌아가 있어야 한다.
    const currentUrl = this.#page.url().split("?")[0];
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });

    add("조회 화면에서 검증", currentUrl === this.#profile.pages.search.url,
      currentUrl === this.#profile.pages.search.url ? undefined : "조회 결과 화면으로 돌아가 주세요.");

    let rows = [];
    if (checks[0].ok) {
      rows = await this.#page.evaluate(READ_ROWS_BY_PROFILE, this.#profile.row);
    }
    const usable = rows.filter((row) => row.resolvedAll);

    add("열차 행을 다시 찾음", usable.length > 0, `해석된 행 ${usable.length}개`);
    add(
      "열차번호 자리에서 열차번호를 읽음",
      usable.some((row) => normalizeTrainNumber(row.fields.trainNumber ?? "").length >= 3),
    );
    add(
      "출발시각 자리에서 시각을 읽음",
      usable.some((row) => normalizeTime(row.fields.departAt ?? "") !== ""),
    );
    add(
      "일반실 상태 자리에서 문구를 읽음",
      usable.some((row) => (row.fields.standardSeat ?? "").trim().length > 0),
    );
    add(
      "상태 문구 분류가 채워짐",
      this.#profile.detectors.soldOut.length > 0 && this.#profile.detectors.availableStandard.length > 0,
      "매진/예약가능에 해당하는 문구를 지정해 주세요.",
    );
    add("조회 폼 항목이 채워짐", ["departure", "arrival", "date", "submit"].every((key) => this.#profile.form[key]));
    add("예약내역 화면이 기록됨", Boolean(this.#profile.pages.reservationList.url));

    // 구조 지문. 검증에 쓴 화면 기준으로 계산한다.
    const structure = await this.#page.evaluate(READ_STRUCTURE);
    this.#profile.fingerprint = computeFingerprint({
      formLabels: structure.formLabels,
      controlNames: structure.controlNames,
      rowCellCount: this.#profile.row.cellCount,
      rowContainerTag: this.#profile.row.containerTag,
      landmarkCounts: structure.landmarkCounts,
    });
    this.#profile.capturedAt = new Date().toISOString();
    // 관찰 목록은 프로필에 남기지 않는다(분류가 끝났으므로 불필요하다).
    delete this.#profile.detectors.observedSeatTexts;

    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
      this.#error = `검증에 실패했습니다: ${failed.map((c) => c.detail || c.name).join(" / ")}`;
      this.#emit();
      return { ok: false, checks, snapshot: this.snapshot() };
    }

    const signed = finalizeProfile(this.#profile, checks);
    this.#savedPath = saveProfile(signed);
    this.#profile = signed;
    this.#step = "DONE";
    this.#finished = true;
    this.#error = null;
    this.#message = "프로필이 검증·서명됐습니다. 이제 읽기 전용 조회를 시작할 수 있습니다.";
    log.info("캡처: 프로필을 서명해 저장했습니다.", { host: signed.host, file: this.#savedPath });
    this.#emit();
    return { ok: true, checks, snapshot: this.snapshot() };
  }

  /** 검증 직전에 사용자가 분류할 수 있도록 관찰된 상태 문구를 돌려준다. */
  observedSeatTexts() {
    return this.#profile.detectors.observedSeatTexts ?? [];
  }

  /** 사용자가 입력한 사업자 이름(화면에 보이는 그대로). */
  setOperator(name) {
    this.#profile.operator = safeScreenText(name, 40);
    this.#emit();
    return this.snapshot();
  }

  async #assertSameHost() {
    const host = await this.#page.evaluate(() => location.hostname);
    if (this.#profile.host && host !== this.#profile.host) {
      throw new ProfileError(
        "HOST_NOT_ALLOWED",
        `대상 호스트(${this.#profile.host}) 밖의 화면입니다(${host}). 공식 화면으로 돌아가 주세요.`,
      );
    }
  }

  #assertStep(expected) {
    if (this.#step !== expected) throw new Error(`지금 단계는 ${this.#step} 입니다(${expected} 아님).`);
  }

  async close() {
    try {
      await this.#page?.evaluate(REMOVE_OVERLAY).catch(() => {});
      await this.#context?.close();
    } catch {
      /* 이미 닫혔으면 그만이다 */
    }
    this.#context = null;
    this.#page = null;
  }
}
