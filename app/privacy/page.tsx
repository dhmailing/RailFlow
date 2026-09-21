import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "개인정보처리방침(초안) | RailFlow",
  description: "RailFlow가 수집하는 정보와 계정 삭제 방법을 안내합니다.",
};

// A public, no-login-required page: Google Play policy requires an account-
// deletion path reachable by URL even without the app installed, and this
// page (plus the in-app "계정 삭제" button in 마이페이지) is intended to be
// that path once a real Android app exists (§5). This document is a DRAFT --
// it has not been reviewed by counsel and must not be presented as a
// finished legal document until that review happens (§8 검토사항).
export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-[#070707] px-5 py-10 text-white">
      <div className="mx-auto max-w-2xl space-y-8 text-sm leading-7 text-white/70">
        <div>
          <p className="text-sm font-semibold text-[#ff9b3f]">RailFlow</p>
          <h1 className="mt-1 text-2xl font-extrabold text-white">개인정보처리방침 (초안)</h1>
          <p className="mt-2 text-xs text-white/40">최종 갱신: v0.5 검토 반영 · 기준일 2026-09-21</p>
          <p className="mt-3 rounded-xl border border-orange-400/30 bg-orange-400/[0.08] p-3 text-xs leading-6 text-orange-200">
            이 문서는 초안입니다. 실제 법령 준수 여부는 별도의 법률 검토를 거치기 전까지 확정되지 않습니다.
            아래 내용은 현재 코드가 실제로 수행하는 동작을 사실대로 설명하는 것을 목표로 하며, 법적 효력을 갖는
            최종 개인정보처리방침으로 제시하는 것이 아닙니다.
          </p>
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
          <h2 className="text-lg font-bold text-white">처리 목적</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>RailFlow 자체 계정 회원가입·로그인·세션 유지 및 계정 보안(비정상 접근 탐지).</li>
            <li>사용자가 등록한 취소표 감시 조건에 따른 감시 작업 수행 및 결과 안내.</li>
            <li>좌석 발생·감시 종료 등 이벤트를 사용자가 지정한 채널(이메일·텔레그램 등)로 통지.</li>
            <li>부정 사용 방지, 장애 대응, 법령상 의무 이행을 위한 보안 감사 기록 보관.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">수집 항목</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li><strong className="text-white/85">계정 정보</strong>: 이메일 주소, 비밀번호(원문이 아닌 salt+scrypt 해시 값만 저장).</li>
            <li><strong className="text-white/85">취소표 감시 조건</strong>: 출발/도착역, 날짜, 시간 범위, 인원, 좌석 등급, 선택한 열차 정보.</li>
            <li><strong className="text-white/85">알림 수신처</strong>: 사용자가 직접 등록한 이메일 주소·텔레그램 chat id 등(향후 FCM/웹 푸시 토큰 포함 예정). 소유권이 확인되기 전까지는 &ldquo;미확인&rdquo; 상태로 표시되며 실제 알림을 발송하지 않습니다.</li>
            <li><strong className="text-white/85">이용 기록</strong>: 로그인, 감시 작업 생성·취소·완료, 기기 등록 등 보안 감사 로그(비밀번호·세션 토큰·알림 수신처 원문은 기록하지 않습니다).</li>
            <li><strong className="text-white/85">자동 수집 정보</strong>: 요청 시 브라우저가 전송하는 IP 주소 일부(요청 빈도 제한 목적, 개발/테스트 환경에서만 사용되는 인메모리 처리이며 별도로 저장·조회되지 않습니다).</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">보유 기간 및 파기 방법</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li><strong className="text-white/85">계정·감시 작업·알림 수신처·동의 이력</strong>: 회원 탈퇴(계정 삭제) 시 즉시 파기합니다. 이 버전(v0.5)에서는 서버 메모리에만 저장되므로 서버 재시작 시에도 함께 사라집니다.</li>
            <li><strong className="text-white/85">보안 감사 로그(AuditEvent)</strong>: 계정 삭제 후에도 부정 사용 조사·보안 사고 대응을 위해 한시적으로 보관하되, 삭제 시점에 사용자 식별자를 원래 계정과 연결할 수 없는 임의의 값으로 되돌릴 수 없게 치환(가명처리)합니다. 이메일·비밀번호·토큰·알림 수신처 원문은 애초에 이 로그에 기록되지 않습니다.</li>
            <li>파기 방법: 인메모리 저장소이므로 논리적 삭제(해당 레코드 제거)로 파기하며, 영구 저장소(PostgreSQL) 연결 이후에는 데이터베이스 삭제(DELETE) 및 필요 시 백업 만료 주기에 따른 파기로 전환할 예정입니다.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">위탁 및 제3자 제공</h2>
          <p className="mt-2">
            현재 버전은 이메일·텔레그램 발송을 실제로 수행하지 않는 테스트용 어댑터만 동작합니다(개발/테스트 환경 한정).
            실제 이메일·텔레그램·FCM/웹 푸시 발송이 연결되면, 그 채널을 운영하는 사업자(예: 이메일 발송 대행사, Telegram
            Bot API, Google FCM)에게 알림 수신처와 알림 내용 일부가 전달됩니다. 이는 개인정보 처리위탁에 해당할 수
            있으며, 실제 연동 시점에 위탁받는 자, 위탁 업무 내용, 위탁 기간을 이 문서에 구체적으로 명시하고
            갱신하겠습니다. 그 외에는 개인정보를 제3자에게 제공하지 않습니다.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">현재 저장 방식(중요)</h2>
          <p className="mt-2">
            이 버전(v0.5)의 계정·감시 작업 데이터는 서버 메모리에만 저장되며, 서버가 재시작되면 사라집니다.
            영구 저장소(PostgreSQL)는 설계만 되어 있고 아직 연결되지 않았습니다(<code className="text-white/60">AUTH_STORE</code>,{" "}
            <code className="text-white/60">WATCH_STORE</code> 환경변수가 모두 <code className="text-white/60">disabled</code>인 동안
            회원가입·로그인·감시 작업 등록·기기 등록 기능 자체가 서버에서 거부됩니다). 운영 환경에서 실제로
            서비스가 시작되면 이 문구는 영구 저장소 연결 여부에 맞춰 갱신됩니다.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">정보주체의 권리</h2>
          <p className="mt-2">
            사용자는 언제든지 자신의 계정 정보 열람(마이페이지), 정정(재가입), 삭제(계정 삭제)를 요청할 수 있습니다.
            계정 삭제는 비밀번호 재확인 후 즉시 처리되며, 처리가 지연되거나 거부될 것으로 예상되는 사유는 현재
            없습니다. 계정 삭제 외의 방식(열람·정정 등)으로 권리를 행사하려는 경우 아래 문의 방법으로 연락해주세요.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">계정 삭제</h2>
          <p className="mt-2">
            로그인 후 <strong className="text-white/85">마이페이지 → RailFlow 계정 → 계정 삭제</strong>에서 비밀번호를
            다시 확인한 뒤 삭제할 수 있습니다. 삭제 시 계정, 감시 작업, 알림 수신처, 알림 발송 기록, 동의 이력이
            함께 삭제됩니다. 보안 감사 로그는 위 &ldquo;보유 기간 및 파기 방법&rdquo;에서 설명한 대로 사용자
            식별자를 가명처리한 상태로 한시적으로 보관될 수 있습니다.
          </p>
          <p className="mt-2 text-xs text-white/40">
            참고: 이 URL 기반 계정 삭제 경로는 Google Play의 계정 삭제 안내 요건을 충족하기 위한 목적으로도
            준비하고 있으나, 네이티브 Android 앱이 아직 출시되지 않아 실제로 그 요건에 대해 심사받거나 확정된
            것은 아닙니다. 앱 출시 시점에 이 URL이 요건을 충족하는지 다시 확인하겠습니다.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white">문의</h2>
          <p className="mt-2">
            이 저장소의 GitHub 이슈를 통해 문의해주세요. 별도의 개인정보보호책임자 지정 및 상시 연락 채널은 아직
            운영 환경 출시 전이라 확정되지 않았으며, 확정되는 대로 이 문서에 이름·연락처를 명시하겠습니다.
          </p>
        </section>
      </div>
    </main>
  );
}
