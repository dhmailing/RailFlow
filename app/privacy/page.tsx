import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "개인정보처리방침 | RailFlow",
  description: "RailFlow가 수집하는 정보와 계정 삭제 방법을 안내합니다.",
};

// A public, no-login-required page: Google Play policy requires an account-
// deletion path reachable by URL even without the app installed, and this
// page (plus the in-app "계정 삭제" button in 마이페이지) is that path for
// now, ahead of any native Android app existing (§5).
export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-[#070707] px-5 py-10 text-white">
      <div className="mx-auto max-w-2xl space-y-8 text-sm leading-7 text-white/70">
        <div>
          <p className="text-sm font-semibold text-[#ff9b3f]">RailFlow</p>
          <h1 className="mt-1 text-2xl font-extrabold text-white">개인정보처리방침</h1>
          <p className="mt-2 text-xs text-white/40">최종 갱신: v0.5 (취소표 감시 기능 추가)</p>
        </div>

        <section>
          <h2 className="text-lg font-bold text-white">RailFlow가 하지 않는 것</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>승차권을 판매하거나 결제를 대행하지 않습니다.</li>
            <li>코레일·SR 계정의 아이디·비밀번호·세션·쿠키를 요청하거나 저장하지 않습니다.</li>
            <li>카드번호·카드 비밀번호를 저장하거나 무인 자동결제를 수행하지 않습니다.</li>
            <li>이 페이지가 설명하는 것 이상으로 개인정보를 제3자에게 판매·제공하지 않습니다.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">수집하는 정보</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li><strong className="text-white/85">계정 정보</strong>: 이메일 주소, 비밀번호(원문이 아닌 solt+scrypt 해시 값만 저장).</li>
            <li><strong className="text-white/85">취소표 감시 조건</strong>: 출발/도착역, 날짜, 시간 범위, 인원, 좌석 등급, 선택한 열차 정보.</li>
            <li><strong className="text-white/85">알림 수신처</strong>: 사용자가 직접 등록한 이메일 주소·텔레그램 chat id 등(향후 FCM/웹 푸시 토큰 포함 예정).</li>
            <li><strong className="text-white/85">이용 기록</strong>: 로그인, 감시 작업 생성·취소·완료 등 보안 감사 로그(비밀번호·토큰·알림 수신처 원문은 기록하지 않습니다).</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">현재 저장 방식(중요)</h2>
          <p className="mt-2">
            이 버전(v0.5)의 계정·감시 작업 데이터는 서버 메모리에만 저장되며, 서버가 재시작되면 사라집니다.
            영구 저장소(PostgreSQL)는 설계만 되어 있고 아직 연결되지 않았습니다. 운영 환경에서 실제로 서비스가 시작되면
            이 문구는 영구 저장소 연결 여부에 맞춰 갱신됩니다.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">계정 삭제</h2>
          <p className="mt-2">
            로그인 후 <strong className="text-white/85">마이페이지 → RailFlow 계정 → 계정 삭제</strong>에서 즉시 삭제할 수 있습니다.
            삭제 시 계정, 감시 작업, 알림 수신처, 알림 발송 기록, 동의 이력이 함께 삭제됩니다. 보안 감사 로그는
            개인정보(이메일·토큰·알림 수신처 원문 등)를 포함하지 않는 형태로 한시적으로 보관될 수 있습니다.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">문의</h2>
          <p className="mt-2">이 저장소의 GitHub 이슈를 통해 문의해주세요.</p>
        </section>
      </div>
    </main>
  );
}
