import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "오프라인 | RailFlow",
};

// Service worker navigate-fallback target (public/sw.js) when neither the
// network nor the cached "/" shell is available -- see §5's "오프라인 안내
// 화면" requirement.
export default function OfflinePage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[#070707] px-6 text-center text-white">
      <div>
        <p className="text-sm font-semibold text-[#ff9b3f]">RailFlow</p>
        <h1 className="mt-2 text-xl font-extrabold">인터넷 연결을 확인해주세요</h1>
        <p className="mt-2 text-sm leading-6 text-white/50">
          오프라인 상태에서는 열차 조회와 취소표 감시 상태를 불러올 수 없습니다.
          <br />
          연결이 복구되면 자동으로 다시 시도됩니다.
        </p>
      </div>
    </main>
  );
}
