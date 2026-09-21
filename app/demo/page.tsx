import type { Metadata } from "next";

import DemoShowcase from "@/components/demo/demo-showcase";

// 공개 경로 -- 로그인 없이 접근 가능하다(§4.1). 이 페이지는 서버 컴포넌트
// 셸일 뿐이며, 실제 상태와 상호작용은 전부 클라이언트 전용 DemoShowcase
// 안에서만 일어난다. 이 파일은 어떤 운영 API도 호출하지 않는다.
export const metadata: Metadata = {
  title: "RailFlow Demo Showcase | 가상 시연",
  description: "실제 좌석 조회·예약 없이 취소표 감시와 알림 흐름을 눌러보는 클라이언트 전용 가상 시연 화면입니다.",
};

export default function DemoPage() {
  return <DemoShowcase />;
}
