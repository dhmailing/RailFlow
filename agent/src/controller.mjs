// 로컬 화면의 요청을 캡처 마법사와 읽기 전용 조회로 이어 준다.
//
// 이 파일이 "무엇을 할 수 있는가"의 목록이다. 여기에 없는 동작은 화면에서
// 호출할 수 없다. 예약·구매·결제 관련 경로는 존재하지 않는다.

import { log } from "./log.mjs";
import { CaptureSession } from "./capture.mjs";
import { ReadOnlyProbe } from "./readonly-probe.mjs";
import { createLiveBookingProvider } from "./providers/live-booking-provider.mjs";
import { assertProviderContract } from "./providers/provider-contract.mjs";
import { checkProfile, listProfiles, loadProfile } from "./profile.mjs";
import { VERIFIER_VERSION } from "./profile-signing.mjs";
import { MIN_LIVE_POLLING_INTERVAL_SECONDS } from "./config.mjs";

export class Controller {
  #playwright;
  #lock;
  #config;
  #capture = null;
  #probe = null;
  #lastProbeSnapshot = null;

  constructor({ playwright, lock, config }) {
    this.#playwright = playwright;
    this.#lock = lock;
    this.#config = config;
  }

  async handle(pathname, method, body) {
    const key = `${method} ${pathname}`;
    const route = this.#routes()[key];
    if (!route) return undefined;
    return route(body);
  }

  #routes() {
    return {
      "GET /api/state": () => this.#state(),
      "GET /api/diagnostics": () => this.#diagnostics(),

      "POST /api/capture/start": (body) => this.#captureStart(body),
      "POST /api/capture/login": () => this.#requireCapture().confirmLogin(),
      "POST /api/capture/search": () => this.#requireCapture().confirmSearch(),
      "POST /api/capture/await-pick": () => this.#requireCapture().awaitPick(),
      "POST /api/capture/skip": () => this.#requireCapture().skipCurrentPick(),
      "GET /api/capture/observed": () => ({ texts: this.#requireCapture().observedSeatTexts() }),
      "POST /api/capture/reservation-list": () => this.#requireCapture().confirmReservationList(),
      "POST /api/capture/verify": (body) => this.#captureVerify(body),
      "POST /api/capture/cancel": () => this.#captureCancel(),

      "POST /api/probe/start": (body) => this.#probeStart(body),
      "POST /api/probe/login": () => {
        this.#requireProbe().confirmLogin();
        return this.#requireProbe().snapshot();
      },
      "POST /api/probe/stop": () => {
        this.#requireProbe().requestStop();
        return this.#requireProbe().snapshot();
      },
    };
  }

  #requireCapture() {
    if (!this.#capture) {
      const error = new Error("진행 중인 화면 연결이 없습니다. [공식 화면 열기] 부터 눌러 주세요.");
      error.code = "NO_CAPTURE_SESSION";
      throw error;
    }
    return this.#capture;
  }

  #requireProbe() {
    if (!this.#probe) {
      const error = new Error("진행 중인 조회가 없습니다.");
      error.code = "NO_PROBE";
      throw error;
    }
    return this.#probe;
  }

  #state() {
    return {
      profiles: listProfiles(),
      capture: this.#capture ? this.#capture.snapshot() : null,
      probe: this.#probe ? this.#probe.snapshot() : this.#lastProbeSnapshot,
    };
  }

  /** 개인정보 없이 붙여넣을 수 있는 진단 요약. */
  #diagnostics() {
    const profiles = listProfiles();
    const probe = this.#probe ? this.#probe.snapshot() : this.#lastProbeSnapshot;
    return {
      agent: {
        node: process.version,
        platform: process.platform,
        port: this.#config.port,
        pollingIntervalSeconds: this.#config.livePollingIntervalSeconds,
        minPollingIntervalSeconds: MIN_LIVE_POLLING_INTERVAL_SECONDS,
        verifierVersion: VERIFIER_VERSION,
        // 이 값이 false 라는 것이 "예약 코드가 실행될 수 없다"의 근거다.
        reservationEnabled: false,
      },
      profiles: profiles.map((p) => ({ host: p.host, usable: p.usable, problem: p.problem, capturedAt: p.capturedAt })),
      capture: this.#capture ? { step: this.#capture.snapshot().step, error: this.#capture.snapshot().error } : null,
      probe: probe
        ? {
            state: probe.state,
            phase: probe.phase,
            haltReason: probe.haltReason,
            readingCount: (probe.readings ?? []).length,
            // 상태 코드만 넣는다. 화면 문구와 열차번호는 넣지 않는다.
            statuses: (probe.readings ?? []).map((r) => r.status),
          }
        : null,
    };
  }

  async #captureStart({ url }) {
    if (this.#capture) await this.#capture.close();
    if (this.#probe?.snapshot().active) {
      const error = new Error("조회가 실행 중입니다. 먼저 중단해 주세요.");
      error.code = "PROBE_ACTIVE";
      throw error;
    }
    this.#capture = new CaptureSession({
      playwright: this.#playwright,
      expectation: { departure: "동탄", arrival: "울산(통도사)" },
    });
    return this.#capture.open(url);
  }

  async #captureVerify({ operator, detectors }) {
    const capture = this.#requireCapture();
    if (operator) capture.setOperator(operator);
    if (detectors) capture.setDetectors(detectors);
    const result = await capture.verifyAndSign();
    if (result.ok) {
      await capture.close();
      this.#capture = null;
    }
    return result;
  }

  async #captureCancel() {
    if (this.#capture) {
      await this.#capture.close();
      this.#capture = null;
    }
    return { ok: true };
  }

  /**
   * 읽기 전용 조회 시작.
   * Provider 는 항상 allowReservation:false 로 만든다. 이 단계에서 예약이
   * 실행될 수 없다는 것이 설정값이 아니라 객체의 성질이 되도록 한다.
   */
  async #probeStart(body) {
    if (this.#probe?.snapshot().active) {
      const error = new Error("이미 조회가 실행 중입니다.");
      error.code = "PROBE_ACTIVE";
      throw error;
    }
    if (this.#capture) {
      const error = new Error("화면 연결이 진행 중입니다. 먼저 끝내거나 중단해 주세요.");
      error.code = "CAPTURE_ACTIVE";
      throw error;
    }

    const profiles = listProfiles().filter((p) => p.usable);
    if (profiles.length === 0) {
      const error = new Error("사용 가능한 공식 화면 프로필이 없습니다. 먼저 [공식 화면 열기] 로 연결해 주세요.");
      error.code = "PROVIDER_PROFILE_REQUIRED";
      throw error;
    }
    const profile = loadProfile(profiles[0].host);
    const usable = checkProfile(profile);
    if (!usable.ok) {
      const error = new Error(usable.problem);
      error.code = usable.code;
      throw error;
    }

    for (const key of ["departure", "arrival", "date"]) {
      if (!body[key]) throw new Error(`${key} 를 입력해 주세요.`);
    }
    if (!body.candidate?.trainNumber || !body.candidate?.departAt) {
      throw new Error("열차번호와 출발시각을 입력해 주세요.");
    }

    const provider = createLiveBookingProvider({
      profile,
      playwright: this.#playwright,
      lock: this.#lock,
      allowReservation: false,
    });
    assertProviderContract(provider);

    this.#probe = new ReadOnlyProbe({
      provider,
      pollingIntervalSeconds: this.#config.livePollingIntervalSeconds,
    });
    this.#probe.onChange((snapshot) => {
      this.#lastProbeSnapshot = snapshot;
    });
    log.info("읽기 전용 조회를 시작합니다.", { host: profile.host });
    return this.#probe.start(body);
  }

  async shutdown() {
    this.#probe?.requestStop();
    await this.#probe?.waitUntilIdle().catch(() => {});
    await this.#capture?.close().catch(() => {});
  }
}
