import { NextResponse } from "next/server";

import { accountLinkAvailability } from "@/lib/autobook/account-link";
import { autobookRuntimeStatus } from "@/lib/autobook/feature-flags";
import { getSeatReservationProvider } from "@/lib/autobook/provider";
import { getRateLimitPolicy } from "@/lib/autobook/rate-limit";
import { describePostgresConfig } from "@/lib/autobook/postgres/config";

// v0.9 서버형 자동예약의 현재 상태.
//
// 읽기 전용이다. 이 라우트로는 작업을 만들 수 없다 -- 작업 생성·진행
// 라우트는 실제 Provider 가 확보되고 저장소가 Postgres 가 된 뒤에 추가한다.
// 지금 만들어 두면 "설정만 바꾸면 도는" 경로가 생기기 때문이다.
//
// 화면은 이 응답만 보고 `공식 연동 준비 중`을 표시한다. Mock 결과를 실제
// 결과처럼 보여주지 않기 위해 simulation 플래그를 그대로 내보낸다.
//
// v0.10 부터 이 응답은 **"코드가 있다"와 "운영에서 켜져 있다"를 나눠서**
// 내보낸다. PostgreSQL 어댑터가 저장소에 있다는 것과, 이 환경에 DB 설정이
// 있다는 것과, 실제로 연결된다는 것은 전부 다른 사실이다. 하나로 뭉치면
// 화면이 준비되지 않은 기능을 준비된 것처럼 보여준다.
export async function GET() {
  const runtime = autobookRuntimeStatus();
  const provider = getSeatReservationProvider();
  const capabilities = provider.capabilities();
  const postgresConfig = describePostgresConfig();

  // 연결 확인은 **설정이 있을 때만** 한다. 기본 fail-closed 경로에서는
  // Node 전용 드라이버를 불러오지도 않는다.
  let dbConnection: { attempted: boolean; ok: boolean; problem: string | null } = {
    attempted: false,
    ok: false,
    problem: null,
  };
  if (runtime.store === "postgres" && postgresConfig.configured) {
    const { checkPostgresConnection } = await import("@/lib/autobook/postgres/client");
    const checked = await checkPostgresConnection();
    dbConnection = { attempted: true, ok: checked.ok, problem: checked.problem };
  }

  return NextResponse.json(
    {
      runtime,
      provider: {
        name: provider.name,
        capabilities,
        rateLimit: getRateLimitPolicy(provider.name),
      },
      accountLink: accountLinkAvailability(),
      // v0.10 운영 준비 상태. 각 줄은 서로 다른 사실이며 합쳐 읽으면 안 된다.
      readiness: {
        /** PostgreSQL 저장소 어댑터 코드가 저장소에 있는가. */
        postgresStoreImplemented: runtime.postgres.implemented,
        /** 이 환경에 DB 연결 설정이 있는가(연결 문자열은 담지 않는다). */
        postgresConfigured: runtime.postgres.configured,
        /** 설정이 없거나 형식이 틀렸다면 그 이유. */
        postgresProblem: runtime.postgres.problem,
        /** 실제로 연결해 봤는가, 됐는가. */
        postgresConnectionChecked: dbConnection.attempted,
        postgresConnected: dbConnection.ok,
        postgresConnectionProblem: dbConnection.problem,
        /** Worker 실행 진입점 코드가 있는가. */
        workerEntrypointImplemented: runtime.worker.entrypointImplemented,
        /** Cron·Queue 가 그 진입점을 실제로 부르도록 배포됐는가. */
        workerScheduleConfigured: runtime.worker.scheduleConfigured,
        /** 공식·승인된 좌석 조회·예약 Provider 가 연결됐는가. */
        officialProviderConnected: capabilities.canCreateReservation && !capabilities.simulation,
        /** 실제 예약이 일어날 수 있는 조합인가. */
        liveReservationPossible: runtime.liveReservationPossible,
      },
      // 이 값이 false 인 한 화면은 실제 좌석·예약을 표시하지 않는다.
      liveReservationPossible: runtime.liveReservationPossible,
      note:
        "서버형 자동예약 기반과 PostgreSQL 저장소 코드는 구현했지만, 공식·승인된 좌석 조회·예약 연동이 없고 Worker 운영 배포·스케줄도 설정되지 않아 실제 작업은 생성·실행되지 않습니다.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
