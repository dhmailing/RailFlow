import type { Metadata } from "next";

import BookingSimulator from "@/components/automation/booking-simulator";

// 공개 경로 -- 로그인 없이 접근 가능하다. 이 페이지는 RailFlow가 관리하는
// 가상의 예매 사이트일 뿐이며, 코레일의 로고·상표·화면을 복제하지 않는다
// (§3-A). 이 파일 자체는 어떤 실제 철도 API도 호출하지 않는다 -- 화면과
// 상호작용은 전부 클라이언트 전용 BookingSimulator와, RailFlow 자신의
// /api/automation/mock-site/** 라우트(둘 다 RailFlow 서버 안에서만 도는
// 가짜 데이터)만 사용한다.
export const metadata: Metadata = {
  title: "RailFlow Booking Simulator | Mock 예매 사이트",
  description: "자동 좌석조회·예약 매크로가 실제로 클릭하며 시연되는 RailFlow 자체 Mock 예매 사이트입니다. 실제 철도 사이트가 아닙니다.",
};

export default function BookingSimulatorPage() {
  return <BookingSimulator />;
}
