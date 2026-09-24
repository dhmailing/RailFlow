"use client";

// 공개 배포본(Vercel)의 "실제 연동" 안내 패널.
//
// 이 패널은 상태를 가져오지 않는다. 가져올 수 없기 때문이다.
//
// https 로 서빙되는 이 페이지가 http://127.0.0.1 의 로컬 Agent를 호출하는
// 구조는 실제 Chrome/Edge에서 막힌다(Mixed Content, Private Network Access,
// CORS). 자세한 내용과 실제 브라우저 확인 결과는
// docs/V0.8-LOCAL-CONNECTION.md 에 있다. 브라우저 보안 설정을 낮추라고
// 안내하는 것은 선택지가 아니므로, 실제 연동 화면 자체를 Agent가 로컬에서
// 함께 제공하도록 구조를 바꿨다.
//
// 그래서 이 패널이 하는 일은 하나다: 어디로 가야 하는지 알려주는 것.
// 실제 조회 상태·좌석 문구·중단은 전부 로컬 화면에서 다룬다.

import { useSyncExternalStore } from "react";
import { ExternalLink, MonitorSmartphone, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LOCAL_CONSOLE_URL } from "@/lib/live/agent-protocol";

export default function LiveAgentPanel() {
  // 로컬에서 열었을 때만 "로컬 화면 열기" 링크가 의미가 있다. 배포본에서는
  // 주소를 안내만 한다(그 주소는 이 브라우저가 아닌 다른 PC일 수 있다).
  // 서버 렌더링에는 window 가 없으므로 useSyncExternalStore 로 읽는다.
  const isLocalPage = useSyncExternalStore(
    () => () => {},
    () => /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname),
    () => false,
  );

  return (
    <Card
      data-testid="live-agent-panel"
      className="rounded-[28px] border-red-500/30 bg-[#140d0d]/90 py-0 text-white"
    >
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 basis-40 text-sm font-extrabold text-red-300">
            실제 좌석 조회 · PC에서 실행합니다
          </p>
          <span className="shrink-0 max-w-full whitespace-normal rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] font-bold leading-4 text-red-300">
            시뮬레이터 아님
          </span>
        </div>

        <p className="text-sm leading-6 text-white/60">
          실제 공식 예매 화면의 좌석 상태는 사용자의 Windows PC에서 실행되는 RailFlow Agent가 읽습니다. 이 웹
          화면은 설치 방법을 알려주는 역할만 합니다 — 브라우저 보안 정책상 웹 페이지가 PC 안의 프로그램을 직접
          부를 수 없기 때문입니다.
        </p>

        <div className="space-y-2 rounded-2xl border border-white/10 bg-black/25 p-3">
          <p className="flex items-start gap-2 text-sm font-bold text-white/80">
            <MonitorSmartphone className="mt-0.5 size-4 shrink-0" />
            PC에서 할 일
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-white/55">
            <li>
              <code className="text-white/75">agent\scripts\1-설치.cmd</code> 실행 (처음 한 번)
            </li>
            <li>
              <code className="text-white/75">agent\scripts\2-RailFlow실행.cmd</code> 실행
            </li>
            <li>자동으로 열린 로컬 RailFlow 화면에서 공식 화면 연결 → 읽기 전용 조회</li>
            <li>
              끝낼 때는 <code className="text-white/75">RailFlow종료.cmd</code>
            </li>
          </ol>
          <p className="text-xs leading-5 text-white/40">
            로컬 화면 주소: <span className="font-mono text-white/60">{LOCAL_CONSOLE_URL}</span> (Agent 실행 중에만
            열립니다)
          </p>
          {isLocalPage && (
            <Button asChild variant="ghost" className="border border-white/15">
              <a href={LOCAL_CONSOLE_URL} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" /> 로컬 RailFlow 화면 열기
              </a>
            </Button>
          )}
        </div>

        <div className="space-y-1.5 rounded-2xl border border-white/10 bg-black/25 p-3">
          <p className="flex items-start gap-2 text-sm font-bold text-white/80">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            지금 단계에서 하지 않는 것
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-white/55">
            <li>예약 버튼 클릭 · 구매 · 결제 (읽기 전용입니다)</li>
            <li>아이디·비밀번호·OTP 입력 또는 저장 (로그인은 직접 하십니다)</li>
            <li>쿠키·세션을 파일로 내보내기</li>
          </ul>
        </div>

        <p className="text-xs leading-5 text-white/35">
          Agent 창을 닫거나 PC가 절전에 들어가면 조회가 멈춥니다. 화면을 꺼도 계속 도는 서버 감시가 아닙니다.
        </p>
      </CardContent>
    </Card>
  );
}
