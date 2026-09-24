// Provider가 "여기서 멈춰야 한다"고 알릴 때 쓰는 오류.
//
// 별도 파일로 둔 이유: Provider 구현(브라우저 코드)과 감시 루프가 같은
// 오류 타입을 공유해야 하는데, 루프가 Provider 모듈 전체를 불러올 필요는
// 없기 때문이다.

export class ProviderHalt extends Error {
  /**
   * @param {string} reason status.mjs 의 HaltReason 값
   * @param {string} message 사용자에게 보여줄 한국어 설명
   * @param {object|null} evidence 판단 근거(개인정보 없이)
   */
  constructor(reason, message, evidence = null) {
    super(message);
    this.name = "ProviderHalt";
    this.code = reason;
    this.evidence = evidence;
  }
}
