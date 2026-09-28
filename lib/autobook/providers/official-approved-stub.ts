import "server-only";

import { AutobookError, type SeatReservationProvider } from "@/lib/autobook/types";

// 공식·승인 경로 Provider — **Stub 이다. 아직 구현이 없다.**
//
// 왜 Stub 인가
// -----------
// docs/V0.9-KORAIL-INTEGRATION-RESEARCH.md 의 결론:
//  - 공개된 코레일 Open API 는 열차운행정보(시간표)와 승차권 진위확인뿐이다.
//  - **좌석 잔여 조회 API 와 예약 생성 API 는 공개 범위에 없다.**
//  - 제3자 서버가 사용자 계정으로 자동예약하는 것에 대한 이용조건과
//    제휴·판매대행 창구를 확인하지 못했다.
//
// 허용된 요청·응답 명세와 이용 권한을 확인하지 못했으므로 실제 구현을
// 하지 않는다. 추측한 endpoint 를 넣지 않는다 -- 그건 비공개 API 복제다.
//
// 이 파일이 존재하는 이유는 두 가지다:
//  1. 플래그로 선택했을 때 "설정은 됐는데 조용히 아무 일도 안 일어남"이
//     아니라 무엇이 없어서 못 하는지 말해 주기 위해.
//  2. 나중에 명세를 확보했을 때 갈아 끼울 자리를 비워 두기 위해.

const WHY = [
  "공식·승인된 연동 명세(요청·응답)와 사용 권한을 아직 확보하지 못했습니다.",
  "공개된 코레일 Open API 범위에 좌석 잔여 조회와 예약 생성이 없습니다.",
  "확인된 내용은 docs/V0.9-KORAIL-INTEGRATION-RESEARCH.md 에 정리돼 있습니다.",
].join(" ");

function notImplemented(): never {
  throw new AutobookError("OFFICIAL_INTEGRATION_REQUIRED", WHY);
}

export const officialApprovedStubProvider: SeatReservationProvider = {
  name: "official-approved (stub)",
  capabilities: () => ({
    // 전부 false 다. 이 값을 보고 Worker 가 예약을 시도조차 하지 않는다.
    canReadAvailability: false,
    canCreateReservation: false,
    canVerifyReservation: false,
    simulation: false,
  }),
  checkAvailability: () => Promise.reject(notImplemented()),
  createReservation: () => Promise.reject(notImplemented()),
  findExistingReservation: () => Promise.reject(notImplemented()),
};
