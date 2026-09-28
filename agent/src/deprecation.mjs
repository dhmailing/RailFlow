// 실사이트 브라우저 자동화 경로의 영구 차단 스위치.
//
// 왜 있는가
// ---------
// v0.8의 Local Agent가 Playwright로 공식 예매 화면(etk.srail.kr)에 접속하자
// 운영자가 이를 자동화된 요청으로 판정해 해당 IP를 일시 제한했다.
// 자세한 경위와 결정은 docs/V0.8-LIVE-AUTOMATION-POSTMORTEM.md 에 있다.
//
// 결론: **이 경로는 실제 운영 경로로 쓸 수 없다.** 탐지 회피로 되살리는
// 선택지는 없다(그건 우회이고, 이 프로젝트가 하지 않기로 한 일이다).
//
// 이 모듈은 그 결정을 "설정"이 아니라 "코드"로 만든다.
//  - 환경변수로 되살릴 수 없다. 켜는 값이 존재하지 않는다.
//  - 이미 사용자의 PC에 설치된 Agent도 업데이트되면 즉시 멈춘다(fail-closed).
//  - Mock·시뮬레이터 테스트 자산은 그대로 둔다(자동화 로직의 회귀 테스트로
//    계속 쓸모가 있고, 외부로 요청을 보내지 않는다).

/** 실사이트 자동화 경로의 상태. 값이 하나뿐인 것이 핵심이다. */
export const LIVE_AUTOMATION_STATUS = "DEPRECATED_BLOCKED";

/** 사용자에게 보여줄 설명. 화면과 콘솔이 같은 문구를 쓴다. */
export const LIVE_AUTOMATION_NOTICE = Object.freeze({
  status: LIVE_AUTOMATION_STATUS,
  title: "실사이트 브라우저 자동화는 중단됐습니다",
  summary:
    "공식 예매 화면을 브라우저로 직접 조작하는 방식은 운영자가 자동화된 요청으로 판정해 접속을 제한했습니다. " +
    "탐지를 피해 되살리지 않습니다. RailFlow는 허용된 연동 경로로 다시 설계하고 있습니다.",
  whatStillWorks: [
    "Mock 예매 사이트 대상 시뮬레이터와 테스트(외부로 요청을 보내지 않습니다)",
    "TAGO 공식 시간표 조회",
  ],
  whatIsBlocked: [
    "공식 예매 화면 접속",
    "실제 좌석 상태 읽기",
    "화면 연결(프로필 캡처) 마법사",
  ],
  document: "docs/V0.8-LIVE-AUTOMATION-POSTMORTEM.md",
});

export class LiveAutomationBlockedError extends Error {
  constructor(action) {
    super(
      `${LIVE_AUTOMATION_NOTICE.title}. ` +
        `요청한 동작(${action})은 수행하지 않습니다. ${LIVE_AUTOMATION_NOTICE.summary}`,
    );
    this.name = "LiveAutomationBlockedError";
    this.code = LIVE_AUTOMATION_STATUS;
  }
}

/**
 * 실사이트로 나가는 동작 앞에서 호출한다. 항상 던진다.
 *
 * 인자를 받지만 어떤 값으로도 통과시키지 않는다 -- "어떤 조건에서는 된다"를
 * 만들지 않기 위해서다.
 */
export function assertLiveAutomationAllowed(action = "실사이트 자동화") {
  throw new LiveAutomationBlockedError(action);
}

/** 화면·진단에 내보낼 요약. */
export function liveAutomationStatus() {
  return { ...LIVE_AUTOMATION_NOTICE, blockedAt: null, canBeEnabled: false };
}
