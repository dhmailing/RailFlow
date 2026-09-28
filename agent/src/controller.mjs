// 로컬 화면의 요청을 처리한다.
//
// 이 파일이 "무엇을 할 수 있는가"의 목록이다. 여기에 없는 동작은 화면에서
// 호출할 수 없다.
//
// 2026-09 현재: **실사이트로 나가는 경로는 전부 막혀 있다.**
// v0.8의 브라우저 자동화가 운영자에게 자동화된 요청으로 판정돼 접속이
// 제한됐고, 탐지를 피해 되살리지 않기로 했다
// (docs/V0.8-LIVE-AUTOMATION-POSTMORTEM.md).
//
// 그래서 남아 있는 것은 상태 조회와 진단뿐이다. 캡처·조회 라우트는 화면이
// 옛 버전이어도 조용히 실패하지 않고 이유를 말하도록 남겨 두되, 전부
// 같은 차단 오류를 돌려준다. 예약·구매·결제 경로는 애초에 존재하지 않는다.

import { VERIFIER_VERSION } from "./profile-signing.mjs";
import { MIN_LIVE_POLLING_INTERVAL_SECONDS } from "./config.mjs";
import { listProfiles } from "./profile.mjs";
import { LiveAutomationBlockedError, liveAutomationStatus } from "./deprecation.mjs";

/** 실사이트로 나가던 라우트. 전부 같은 이유로 거부한다. */
const BLOCKED_ROUTES = Object.freeze({
  "POST /api/capture/start": "공식 화면 연결",
  "POST /api/capture/login": "공식 화면 연결",
  "POST /api/capture/search": "공식 화면 연결",
  "POST /api/capture/await-pick": "공식 화면 연결",
  "POST /api/capture/skip": "공식 화면 연결",
  "GET /api/capture/observed": "공식 화면 연결",
  "POST /api/capture/reservation-list": "공식 화면 연결",
  "POST /api/capture/verify": "공식 화면 연결",
  "POST /api/probe/start": "실제 좌석 조회",
  "POST /api/probe/login": "실제 좌석 조회",
  "POST /api/probe/stop": "실제 좌석 조회",
});

export class Controller {
  #config;

  constructor({ config }) {
    this.#config = config;
  }

  async handle(pathname, method, body) {
    const key = `${method} ${pathname}`;
    if (key in BLOCKED_ROUTES) throw new LiveAutomationBlockedError(BLOCKED_ROUTES[key]);
    const route = this.#routes()[key];
    if (!route) return undefined;
    return route(body);
  }

  #routes() {
    return {
      "GET /api/state": () => this.#state(),
      "GET /api/diagnostics": () => this.#diagnostics(),
      // 화면의 [연결 중단] 이 오류를 내지 않게만 한다. 되돌릴 세션은 없다.
      "POST /api/capture/cancel": () => ({ ok: true }),
    };
  }

  #state() {
    return {
      liveAutomation: liveAutomationStatus(),
      // 예전에 만들어 둔 프로필이 있으면 목록에는 보여 준다. 다만 이 프로필로
      // 실제 조회를 다시 시작할 수는 없다.
      profiles: listProfiles(),
      capture: null,
      probe: null,
    };
  }

  /** 개인정보 없이 붙여넣을 수 있는 진단 요약. */
  #diagnostics() {
    return {
      liveAutomation: liveAutomationStatus(),
      agent: {
        node: process.version,
        platform: process.platform,
        port: this.#config.port,
        minPollingIntervalSeconds: MIN_LIVE_POLLING_INTERVAL_SECONDS,
        verifierVersion: VERIFIER_VERSION,
        // 아래 두 값이 이번 Agent가 외부로 아무 것도 하지 않는다는 근거다.
        liveAutomationEnabled: false,
        reservationEnabled: false,
      },
      profiles: listProfiles().map((p) => ({ host: p.host, usable: p.usable, capturedAt: p.capturedAt })),
    };
  }

  async shutdown() {
    // 실행 중인 실사이트 세션이 존재할 수 없으므로 정리할 것이 없다.
  }
}
