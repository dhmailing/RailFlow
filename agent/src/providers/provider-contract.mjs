// 실제 화면 Provider가 지켜야 하는 계약.
//
// 이 파일에는 브라우저 코드가 없다. "무엇을 할 수 있어야 하는가"와
// "무엇을 절대 하면 안 되는가"만 정의하고, 구현이 그 모양을 지키는지
// 검사한다. Mock Provider(lib/automation/providers/**)는 이 계약을
// 구현하지 않으며, 이름도 겹치지 않는다.
//
// 절대 포함되지 않는 기능(지침 §4):
//  - CAPTCHA 해결/우회, 대기열 우회, 봇 탐지 회피
//  - User-Agent/IP/계정/세션 로테이션, 프록시 우회
//  - 탐지 회피용 요청 간격 무작위화
//  - 비공개 API 호출, 앱 트래픽 가로채기
//  - 결제 자동화
// 위 항목에 해당하는 메서드는 계약에 존재하지 않는다. 즉 Provider가
// 그런 일을 하려면 계약 밖으로 나가야 하고, 그러면 아래 검사에 걸린다.

export const REQUIRED_PROVIDER_METHODS = Object.freeze([
  "openBookingSite",
  "waitForManualLogin",
  "searchTrain",
  "readSeatAvailability",
  "requestReservation",
  "verifyReservation",
  "readPaymentDeadline",
  "stop",
]);

/** 계약에 있어서는 안 되는 이름. 구현에 있으면 로드 자체를 거부한다. */
const FORBIDDEN_METHODS = Object.freeze([
  "solveCaptcha",
  "bypassCaptcha",
  "bypassQueue",
  "skipQueue",
  "rotateUserAgent",
  "rotateProxy",
  "rotateAccount",
  "rotateSession",
  "evadeDetection",
  "randomizeInterval",
  "exportCookies",
  "saveSession",
  "pay",
  "submitPayment",
  "autoPay",
]);

export class ProviderContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderContractError";
    this.code = "PROVIDER_CONTRACT_VIOLATION";
  }
}

/**
 * Provider 구현이 계약을 지키는지 확인한다.
 * `name` 은 반드시 "live:" 로 시작하고 대상 사업자를 포함해야 한다 --
 * 로그·UI 어디서도 Mock과 헷갈리지 않게 하기 위해서다(지침 §5).
 */
export function assertProviderContract(provider) {
  if (!provider || typeof provider !== "object") {
    throw new ProviderContractError("Provider 객체가 아닙니다.");
  }
  if (typeof provider.name !== "string" || !provider.name.startsWith("live:")) {
    throw new ProviderContractError(
      `실제 Provider의 이름은 "live:" 로 시작하고 대상 사업자를 포함해야 합니다(현재: ${provider.name}).`,
    );
  }
  if (provider.simulation !== false) {
    throw new ProviderContractError("실제 Provider는 simulation=false 를 명시해야 합니다.");
  }
  const missing = REQUIRED_PROVIDER_METHODS.filter((key) => typeof provider[key] !== "function");
  if (missing.length > 0) {
    throw new ProviderContractError(`Provider에 다음 메서드가 없습니다: ${missing.join(", ")}`);
  }
  const forbidden = FORBIDDEN_METHODS.filter((key) => key in provider);
  if (forbidden.length > 0) {
    throw new ProviderContractError(
      `Provider에 허용되지 않는 기능이 있습니다: ${forbidden.join(", ")}. 차단·탐지 회피·결제 자동화는 구현하지 않습니다.`,
    );
  }
  return true;
}
