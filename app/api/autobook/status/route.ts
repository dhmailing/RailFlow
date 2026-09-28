import { NextResponse } from "next/server";

import { accountLinkAvailability } from "@/lib/autobook/account-link";
import { autobookRuntimeStatus } from "@/lib/autobook/feature-flags";
import { getSeatReservationProvider } from "@/lib/autobook/provider";
import { getRateLimitPolicy } from "@/lib/autobook/rate-limit";

// v0.9 서버형 자동예약의 현재 상태.
//
// 읽기 전용이다. 이 라우트로는 작업을 만들 수 없다 -- 작업 생성·진행
// 라우트는 실제 Provider 가 확보되고 저장소가 Postgres 가 된 뒤에 추가한다.
// 지금 만들어 두면 "설정만 바꾸면 도는" 경로가 생기기 때문이다.
//
// 화면은 이 응답만 보고 `공식 연동 준비 중`을 표시한다. Mock 결과를 실제
// 결과처럼 보여주지 않기 위해 simulation 플래그를 그대로 내보낸다.
export async function GET() {
  const runtime = autobookRuntimeStatus();
  const provider = getSeatReservationProvider();
  const capabilities = provider.capabilities();

  return NextResponse.json(
    {
      runtime,
      provider: {
        name: provider.name,
        capabilities,
        rateLimit: getRateLimitPolicy(provider.name),
      },
      accountLink: accountLinkAvailability(),
      // 이 값이 false 인 한 화면은 실제 좌석·예약을 표시하지 않는다.
      liveReservationPossible: runtime.liveReservationPossible,
      note:
        "서버형 자동예약 기반은 구현했지만 공식·승인된 좌석 조회·예약 연동이 없어 실제 작업은 생성되지 않습니다.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
