import type { Metadata } from "next";

import BookingAutomationDemo from "@/components/automation-demo/booking-automation-demo";

// 공개 경로 -- 로그인 없이 접근 가능하다. lib/automation-demo/types.ts의
// 헤더 코멘트 참고: AUTH_STORE는 NODE_ENV로 판정되어 Vercel Preview
// (NODE_ENV=production으로 빌드됨)에서 오늘 당장은 사용할 수 없으므로, 이
// 페이지는 로그인·서버 저장소·실제 자동화 API를 전혀 쓰지 않는 완전히
// 독립된 클라이언트 전용 시연이다. 이 파일은 서버 컴포넌트 셸일 뿐이며,
// 실제 상태와 상호작용은 전부 클라이언트 전용 BookingAutomationDemo
// 안에서만 일어난다.
export const metadata: Metadata = {
  title: "RailFlow 자동 좌석조회·예약 매크로 시연 | 로그인 불필요",
  description: "로그인 없이 자동 좌석조회부터 가상 예약 성공까지 자동 좌석조회·예약 매크로 흐름을 체험하는 클라이언트 전용 가상 시연 화면입니다.",
};

export default function BookingAutomationDemoPage() {
  return <BookingAutomationDemo />;
}
