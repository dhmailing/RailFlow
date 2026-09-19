"use client";
import { BellRing, ChevronRight, CreditCard, Download, MapPin, Settings2, Smartphone, Sparkles, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
export default function SettingsView({ notifications, setNotifications, autoLogin, setAutoLogin, autoPay, setAutoPay, isInstalled, canInstall, onInstall }: { notifications: boolean; setNotifications: (value: boolean) => void; autoLogin: boolean; setAutoLogin: (value: boolean) => void; autoPay: boolean; setAutoPay: (value: boolean) => void; isInstalled: boolean; canInstall: boolean; onInstall: () => void }) {
  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-6"><p className="mb-1 text-sm font-semibold text-[#ff9b3f]">마이페이지</p><h1 className="text-2xl font-extrabold tracking-[-0.035em] md:text-3xl">예약 환경 설정</h1></div>
      <div className="rounded-[26px] border border-white/10 bg-[#111] p-5">
        <p className="text-sm text-white/42">코레일 계정</p>
        <div className="mt-3 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3"><span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[#ff8a1f]/12 text-[#ff8a1f]"><UserRound className="size-6" /></span><div><p className="font-extrabold">계정 연결 전</p><p className="mt-1 text-xs text-white/38">실제 예약 연동 단계에서 연결합니다.</p></div></div>
          <Button variant="outline" disabled className="rounded-xl border-white/12 bg-transparent text-white/55">준비 중</Button>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-4 rounded-[22px] border border-[#ff8a1f]/20 bg-[#ff8a1f]/[0.06] p-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[#ff8a1f] text-black"><Smartphone className="size-5" /></span>
        <div className="min-w-0 flex-1"><p className="font-extrabold">갤럭시에 앱으로 설치</p><p className="mt-1 text-xs leading-5 text-white/42">홈 화면에서 전체 화면 앱처럼 사용할 수 있어요.</p></div>
        <Button onClick={onInstall} disabled={isInstalled} className="rounded-xl bg-[#ff8a1f] px-4 font-extrabold text-black hover:bg-[#ff9d45] disabled:bg-white/10 disabled:text-white/40">
          {isInstalled ? "설치됨" : canInstall ? <><Download className="size-4" /> 설치</> : "설치 안내"}
        </Button>
      </div>

      <div className="mt-5 space-y-3">
        <SettingSwitch icon={<BellRing />} label="예약 알림" description="좌석 확보·오류 상태를 즉시 알립니다." checked={notifications} onCheckedChange={setNotifications} />
        <SettingSwitch icon={<Sparkles />} label="자동 로그인" description="연결된 코레일 계정의 세션을 유지합니다." checked={autoLogin} onCheckedChange={setAutoLogin} />
        <SettingSwitch icon={<CreditCard />} label="예약 즉시 자동결제" description="결제 연동 전까지는 설정만 저장됩니다." checked={autoPay} onCheckedChange={setAutoPay} />
      </div>

      <div className="mt-7">
        <p className="mb-3 px-1 text-sm font-semibold text-white/42">추가 설정</p>
        <div className="overflow-hidden rounded-[22px] border border-white/10 bg-[#111]">
          <SettingRow icon={<MapPin />} label="자주 가는 역" value="동탄 · 울산" />
          <SettingRow icon={<CreditCard />} label="카드 관리" value="등록 전" />
          <SettingRow icon={<Settings2 />} label="좌석 선호" value="창측 우선" last />
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-[#ff8a1f]/15 bg-[#ff8a1f]/[0.055] p-4 text-sm leading-6 text-white/48"><span className="font-bold text-[#ffad62]">안전장치</span> · 자동결제에는 여정당 1회, 최대금액, 좌석등급 제한을 함께 적용할 예정입니다.</div>
    </section>
  );
}

function SettingSwitch({ icon, label, description, checked, onCheckedChange }: { icon: React.ReactNode; label: string; description: string; checked: boolean; onCheckedChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-4 rounded-[20px] border border-white/10 bg-[#111] p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-[#ff8a1f] [&>svg]:size-5">{icon}</span>
      <span className="min-w-0 flex-1"><span className="block font-bold">{label}</span><span className="mt-1 block text-xs leading-5 text-white/38">{description}</span></span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} className="scale-125 data-[state=checked]:bg-[#ff8a1f]" />
    </label>
  );
}

function SettingRow({ icon, label, value, last = false }: { icon: React.ReactNode; label: string; value: string; last?: boolean }) {
  return (
    <button type="button" className={`flex w-full items-center gap-4 p-4 text-left transition hover:bg-white/[0.035] ${last ? "" : "border-b border-white/[0.07]"}`}>
      <span className="text-[#ff8a1f] [&>svg]:size-5">{icon}</span><span className="flex-1 font-bold">{label}</span><span className="text-sm text-white/40">{value}</span><ChevronRight className="size-5 text-white/28" />
    </button>
  );
}
