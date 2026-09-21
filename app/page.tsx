"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ArrowLeftRight,
  BellRing,
  CalendarDays,
  Clock3,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  Ticket,
  TrainFront,
  UserRound,
  UsersRound,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Combobox, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxEmpty } from "@/components/ui/combobox";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { stationNames } from "@/lib/rail/stations";
import type { RailProviderMode, TrainResult, TrainSearchResponse } from "@/lib/rail/types";
import type { AuthUser } from "@/components/auth-panel";
import { toast } from "sonner";

type Reservation = TrainResult & {
  route: string;
  date: string;
  status: "watching" | "secured";
  createdAt: string;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const stations: string[] = [...stationNames];
const SettingsView = dynamic(()=>import("@/components/rail-settings"),{loading:()=> <p role="status">설정 불러오는 중</p>});
const AuthPanel = dynamic(()=>import("@/components/auth-panel"),{loading:()=> <p role="status">로그인 상태 불러오는 중</p>});
const WatchJobsPanel = dynamic(()=>import("@/components/watch-jobs"),{loading:()=> <p role="status">취소표 감시 상태 불러오는 중</p>});
const AutomationJobsPanel = dynamic(()=>import("@/components/automation/automation-jobs"),{loading:()=> <p role="status">자동화 작업 상태 불러오는 중</p>});

function kstDate(offsetDays: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

const today = kstDate(0);
const defaultTravelDate = kstDate(7);

const storageKey = "railflow-reservations";
const settingsKey = "railflow-settings";

export default function Home() {
  const [activeTab, setActiveTab] = useState("booking");
  const [departure, setDeparture] = useState("");
  const [arrival, setArrival] = useState("");
  const [date, setDate] = useState(defaultTravelDate);
  const [time, setTime] = useState("00:00");
  const [stationOptions, setStationOptions] = useState<{name:string;id:string}[]>([]);
  const [stationLoading, setStationLoading] = useState(true);
  const [stationError, setStationError] = useState("");
  const [searchError, setSearchError] = useState("");
  const [mode, setMode] = useState<RailProviderMode>("live");
  const [stationRetry, setStationRetry] = useState(0);
  const searchRequest = useRef<{controller:AbortController;key:string}|null>(null);
  const [searchedCondition, setSearchedCondition] = useState({departure:"",arrival:"",date:""});
  const [passengers, setPassengers] = useState("1");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [trains, setTrains] = useState<TrainResult[]>([]);
  const [providerMode, setProviderMode] = useState<RailProviderMode | "checking">("checking");
  const [resultMode, setResultMode] = useState<RailProviderMode>("demo");
  const [sourceLabel, setSourceLabel] = useState("연결 상태 확인 중");
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [notifications, setNotifications] = useState(true);
  const [autoLogin, setAutoLogin] = useState(true);
  const [autoPay, setAutoPay] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const sessionCheckedRef = useRef(false);

  // §10 검토: 로그인이 필요한 화면(자동예약/마이페이지)이 실제로 열릴 때만
  // 세션을 확인하는 lazy 방식. 예매 탭만 보는 비로그인 사용자는 애초에
  // /api/auth/session을 호출하지 않으므로, 항상 예상되는 401이라도 메인
  // 화면 첫 로드에서 발생시키지 않는다. 한 번 확인한 뒤에는(로그인/로그아웃
  // 등으로 authUser가 바뀌는 경우를 제외하고) 탭을 오갈 때마다 다시 부르지
  // 않는다.
  useEffect(() => {
    if (activeTab !== "automation" && activeTab !== "settings") return;
    if (sessionCheckedRef.current) return;
    sessionCheckedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (response.ok) {
          const payload = (await response.json()) as { user: AuthUser };
          if (!cancelled) setAuthUser(payload.user);
        } else if (!cancelled) {
          setAuthUser(null);
        }
      } catch {
        if (!cancelled) setAuthUser(null);
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  useEffect(() => {
    const restoreFrame = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) setReservations(JSON.parse(saved));
        const savedSettings = window.localStorage.getItem(settingsKey);
        if (savedSettings) {
          const settings = JSON.parse(savedSettings);
          setNotifications(settings.notifications ?? true);
          setAutoLogin(settings.autoLogin ?? true);
          setAutoPay(settings.autoPay ?? false);
        }
      } catch {
        window.localStorage.removeItem(storageKey);
      }

      setIsInstalled(window.matchMedia("(display-mode: standalone)").matches);
      setStorageReady(true);
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    return () => {
      window.cancelAnimationFrame(restoreFrame);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem(storageKey, JSON.stringify(reservations));
    window.localStorage.setItem(settingsKey, JSON.stringify({ notifications, autoLogin, autoPay }));
  }, [reservations, notifications, autoLogin, autoPay, storageReady]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/trains/stations?mode=${mode}`, { signal: controller.signal })
      .then((response) => response.json() as Promise<{stations?:{name:string;id:string}[];error?:{message:string}}>)
      .then((payload) => {
        if(controller.signal.aborted) return;
        if(payload.error) throw new Error(payload.error.message);
        setStationOptions(payload.stations ?? []);
        setProviderMode(mode);
        setSourceLabel(mode === "live" ? "국토교통부 TAGO 운행시간표" : "화면 검증용 데모 운행정보");
        setStationError("");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setStationError(error instanceof Error ? error.message : "역 목록을 불러오지 못했습니다.");
        setProviderMode("checking");
      }).finally(()=>{if(!controller.signal.aborted) setStationLoading(false);});
    return () => controller.abort();
  }, [mode, stationRetry]);

  useEffect(()=>()=>searchRequest.current?.controller.abort(),[]);

  const resetConditions = () => {
    searchRequest.current?.controller.abort(); searchRequest.current=null;
    setDeparture("");setArrival("");setDate(kstDate(7));setTime("00:00");setPassengers("1");
    setOnlyAvailable(false);setHasSearched(false);setTrains([]);setSearchError("");setSearching(false);
    setSearchedCondition({departure:"",arrival:"",date:""});
  };

  const visibleTrains = useMemo(
    () => (onlyAvailable && providerMode !== "live" ? trains.filter((train) => train.availability === "available") : trains),
    [onlyAvailable, providerMode, trains],
  );

  const swapStations = () => {
    changeCondition(()=>{setDeparture(arrival);setArrival(departure);});
  };

  const changeCondition = (update:()=>void) => {
    searchRequest.current?.controller.abort();searchRequest.current=null;
    setSearching(false);setHasSearched(false);setSearchError("");
    setSearchedCondition({departure:"",arrival:"",date:""});
    update();
  };

  const searchTrains = async () => {
    if(!departure || !arrival || !date) {
      setSearchError("출발역·도착역과 출발일을 선택해주세요.");return;
    }
    if (departure === arrival) {
      setSearchError("출발역과 도착역은 서로 다르게 선택해주세요.");
      return;
    }

    const params = new URLSearchParams({
      departure,
      arrival,
      date,
      departAfter: time,
      passengers,
      departureId:stationOptions.find(s=>s.name===departure)?.id ?? "",
      arrivalId:stationOptions.find(s=>s.name===arrival)?.id ?? "",
      mode,
    });
    const key=params.toString();
    if(searchRequest.current?.key===key) return;
    searchRequest.current?.controller.abort();
    const controller=new AbortController();
    searchRequest.current={controller,key};
    const timeout=window.setTimeout(()=>controller.abort("timeout"),25000);
    setSearching(true);setSearchError("");setHasSearched(false);
    setSearchedCondition({departure,arrival,date});

    try {
      const response = await fetch(`/api/trains/search?${key}`, { cache: "no-store", signal:controller.signal });
      const payload = await response.json() as TrainSearchResponse & { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "열차를 조회하지 못했습니다.");
      if(controller.signal.aborted) return;

      setTrains(payload.trains);
      setResultMode(payload.mode);
      setProviderMode(payload.mode);
      setSourceLabel(payload.sourceLabel);
      setHasSearched(true);
      toast.success(payload.mode === "live" ? "실제 운행시간표를 불러왔어요" : "데모 열차 조회가 완료됐어요", {
        description: payload.mode === "live"
          ? "좌석 잔여 여부는 코레일+에서 최종 확인해야 합니다."
          : "공공데이터 인증키가 연결되면 실제 시간표로 전환됩니다.",
      });
    } catch (error) {
      if(controller.signal.aborted && controller.signal.reason!=="timeout") return;
      setSearchError(controller.signal.reason === "timeout" ? "열차정보 응답이 지연되고 있습니다. 다시 시도해주세요." : error instanceof Error ? error.message : "열차 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      window.clearTimeout(timeout);
      if(searchRequest.current?.controller===controller) {setSearching(false);searchRequest.current=null;}
    }
  };

  const addReservation = (train: TrainResult) => {
    if (reservations.some((reservation) => reservation.id === train.id)) {
      toast.info("이미 자동예약 중인 열차예요");
      setActiveTab("automation");
      return;
    }

    const reservation: Reservation = {
      ...train,
      route: `${searchedCondition.departure} → ${searchedCondition.arrival}`,
      date: searchedCondition.date,
      status: train.availability === "available" ? "secured" : "watching",
      createdAt: new Date().toISOString(),
    };

    setReservations((current) => [reservation, ...current]);
    toast.info("자동예약 탭에서 취소표 감시를 등록해주세요", {
      description: `${train.number} · ${train.depart} 출발 · 실시간 좌석 감시는 로그인 후 자동예약 탭에서 조건을 등록해야 시작됩니다.`,
    });
    setActiveTab("automation");
  };

  const installApp = async () => {
    if (!installPrompt) {
      toast.info("브라우저 메뉴에서 ‘홈 화면에 추가’를 선택해주세요");
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setIsInstalled(true);
      setInstallPrompt(null);
      toast.success("RailFlow가 앱으로 설치됐어요");
    }
  };

  useEffect(() => {
    const modelContext = (document as Document & {
      modelContext?: {
        registerTool: (tool: {
          name: string;
          title: string;
          description: string;
          inputSchema: object;
          annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
          execute: (input: unknown) => Promise<object>;
        }, options: { signal: AbortSignal }) => void | Promise<void>;
      };
    }).modelContext;
    if (!modelContext?.registerTool) return;

    const lifecycle = new AbortController();
    void Promise.resolve(modelContext.registerTool({
      name: "start_train_search",
      title: "열차 검색 시작",
      description: "RailFlow 화면에 출발역, 도착역, 날짜와 시간을 입력해 열차 검색을 준비합니다.",
      inputSchema: {
        type: "object",
        properties: {
          departure: { type: "string", enum: stations },
          arrival: { type: "string", enum: stations },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          time: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
        },
        required: ["departure", "arrival", "date", "time"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        const value = input as { departure?: string; arrival?: string; date?: string; time?: string };
        if (!stations.includes(value.departure ?? "") || !stations.includes(value.arrival ?? "")) {
          throw new Error("지원하지 않는 역입니다.");
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date ?? "") || !/^\d{2}:\d{2}$/.test(value.time ?? "")) {
          throw new Error("날짜 또는 시간 형식이 올바르지 않습니다.");
        }
        setDeparture(value.departure!);
        setArrival(value.arrival!);
        setDate(value.date!);
        setTime(value.time!);
        setHasSearched(false);
        setActiveTab("booking");
        return { status: "ready", message: "검색 조건을 입력했습니다. 열차 검색 버튼으로 조회를 시작합니다." };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);

    return () => lifecycle.abort();
  }, []);

  return (
    <main className="min-h-dvh bg-[#070707] text-white">
      <div className="mx-auto min-h-dvh max-w-6xl border-x border-white/[0.06] bg-[radial-gradient(circle_at_50%_-12%,rgba(255,137,31,0.15),transparent_34%)]">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/10 bg-[#070707]/90 px-5 backdrop-blur-xl md:h-20 md:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-[#ff8a1f] text-black shadow-[0_0_24px_rgba(255,138,31,0.32)]">
              <TrainFront className="size-5" strokeWidth={2.4} />
            </span>
            <div>
              <p className="text-lg font-extrabold tracking-[-0.03em]">RailFlow v0.3</p>
              <p className="hidden text-xs text-white/45 sm:block">빠르게 잡고, 놓치지 않게</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/60">
            <span className={`size-2 rounded-full ${providerMode === "live" ? "bg-emerald-400 shadow-[0_0_12px_#34d399]" : providerMode === "demo" ? "bg-[#ff8a1f] shadow-[0_0_12px_#ff8a1f]" : "bg-white/35"}`} />
            {providerMode === "live" ? "공식 운행정보" : providerMode === "demo" ? "데모 모드" : "연결 준비"}
          </div>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-[calc(100dvh-4rem)] gap-0 md:min-h-[calc(100dvh-5rem)]">
          <div className="px-4 pb-28 pt-5 md:px-8 md:pb-10 md:pt-8">
            <TabsContent value="booking" className="m-0">
              <section className="grid gap-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1.08fr)]">
                <div>
                  <div className="mb-5 flex items-end justify-between">
                    <div>
                      <p className="mb-1 text-sm font-semibold text-[#ff9b3f]">열차 조회</p>
                      <h1 className="text-2xl font-extrabold tracking-[-0.035em] md:text-3xl">어디로 이동할까요?</h1>
                    </div>
                    <span className="hidden text-sm text-white/38 sm:block">KTX·SRT 고속열차</span>
                  </div>

                  <Card className="min-w-0 rounded-[28px] border-white/10 bg-[#111]/90 py-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.38)]">
                    <CardContent className="p-4 sm:p-5">
                      <div className="station-grid">
                        <StationSelect label="출발역" value={departure} onChange={value=>changeCondition(()=>setDeparture(value))} options={stationOptions} loading={stationLoading} />
                        <Button
                          type="button"
                          aria-label="출발역과 도착역 바꾸기"
                          onClick={swapStations}
                          className="swap-button size-11 self-center justify-self-center rounded-full border border-white/15 bg-[#191919] p-0 text-[#ff8a1f] hover:bg-[#242424]"
                        >
                          <ArrowLeftRight className="size-5" />
                        </Button>
                        <StationSelect label="도착역" value={arrival} onChange={value=>changeCondition(()=>setArrival(value))} options={stationOptions} loading={stationLoading} />
                      </div>

                      <div className="date-grid mt-3 grid grid-cols-2 gap-3">
                        <FieldShell label="출발일" icon={<CalendarDays className="size-5" />}>
                          <input
                            aria-label="출발일"
                            type="date"
                            min={today}
                            value={date}
                            onChange={(event) => changeCondition(()=>setDate(event.target.value))}
                            className="min-w-0 flex-1 bg-transparent text-base font-bold outline-none [color-scheme:dark] sm:text-lg"
                          />
                        </FieldShell>
                        <FieldShell label="출발시간" icon={<Clock3 className="size-5" />}>
                          <input
                            aria-label="출발시간"
                            type="time"
                            value={time}
                            onChange={(event) => changeCondition(()=>setTime(event.target.value))}
                            className="min-w-0 flex-1 bg-transparent text-base font-bold outline-none [color-scheme:dark] sm:text-lg"
                          />
                        </FieldShell>
                      </div>

                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/35 p-4">
                        <div className="flex items-center gap-3">
                          <UsersRound className="size-5 text-[#ff8a1f]" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-white/48">인원</p>
                            <select aria-label="인원" value={passengers} onChange={event=>changeCondition(()=>setPassengers(event.target.value))} className="min-h-11 w-full border-0 bg-[#111] text-base font-bold">
                              {[1,2,3,4].map(count=><option key={count} value={String(count)}>성인 {count}명</option>)}
                            </select>
                          </div>
                        </div>
                      </div>

                      <label className="mt-5 flex cursor-pointer items-center justify-between gap-4 rounded-2xl px-1 py-2">
                        <span className="flex items-center gap-3 text-base font-semibold">
                          <Zap className="size-5 fill-[#ff8a1f] text-[#ff8a1f]" />
                          {mode === "live" ? "좌석 잔여정보 미제공" : "즉시 예약 가능한 열차만"}
                        </span>
                        <Switch checked={onlyAvailable} onCheckedChange={setOnlyAvailable} disabled={mode === "live"} className="scale-125 data-[state=checked]:bg-[#ff8a1f]" />
                      </label>

                      <Button
                        type="button"
                        onClick={searchTrains}
                        disabled={searching || stationLoading || !departure || !arrival || departure===arrival || !date}
                        className="mt-5 h-14 w-full rounded-2xl bg-[#ff8a1f] text-base font-extrabold text-black shadow-[0_10px_30px_rgba(255,138,31,0.22)] hover:bg-[#ff9d45]"
                      >
                        {searching ? <LoaderCircle className="size-5 animate-spin" /> : <Search className="size-5" />}
                        {searching ? "열차 확인 중" : "열차 검색"}
                      </Button>
                      <div className="mt-3 flex flex-wrap gap-3">
                        <Button variant="ghost" onClick={resetConditions}>검색 조건 초기화</Button>
                        <Button variant="ghost" onClick={()=>{resetConditions();setStationOptions([]);setStationLoading(true);setStationError("");setMode(mode==="live"?"demo":"live");}}>{mode==="live"?"샘플 시간표 보기":"실제 조회로 전환"}</Button>
                      </div>
                      {!departure || !arrival ? <p className="mt-2 text-sm text-white/60">출발역과 도착역을 선택해주세요.</p> : departure===arrival ? <p role="alert" className="mt-2 text-sm text-orange-300">출발역과 도착역은 서로 다르게 선택해주세요.</p> : null}
                      {stationError && <div role="alert" className="mt-3 text-sm text-orange-300">{stationError}<Button variant="ghost" onClick={()=>{setStationLoading(true);setStationRetry(v=>v+1);}}>역 목록 다시 불러오기</Button></div>}
                    </CardContent>
                  </Card>

                  <div className="mt-4 flex items-start gap-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.025] p-4 text-sm leading-6 text-white/46">
                    <BellRing className="mt-0.5 size-5 shrink-0 text-[#ff9b3f]" />
                    {mode === "live"
                      ? "운행시간과 운임은 공식 공공데이터입니다. 좌석 잔여와 예약은 아직 코레일+에서 확인합니다."
                      : "샘플 시간표 모드입니다. 표시되는 열차와 예약 결과는 실제가 아닙니다."}
                  </div>

                  <Link
                    href="/demo"
                    className="mt-3 flex items-center gap-3 rounded-2xl border border-[#ff8a1f]/25 bg-[#ff8a1f]/[0.06] p-4 text-sm leading-6 text-white/60 transition hover:border-[#ff8a1f]/40"
                  >
                    <Sparkles className="mt-0.5 size-5 shrink-0 text-[#ff9b3f]" />
                    <span>
                      <span className="font-bold text-[#ffad62]">취소표 감시 가상 시연</span>
                      <br />
                      여기서는 열차 시간표·운임을 조회하고, 이 링크는 취소표 감시 등록부터 좌석 발견·알림까지의 흐름을 로그인 없이 눌러보는 가상 시연으로 이동합니다. 둘 다 실제 좌석 조회·예약·결제는 아닙니다.
                    </span>
                  </Link>
                </div>

                <div className="min-w-0">
                  {searching ? <div role="status" className="rounded-2xl border border-white/10 p-6"><LoaderCircle className="mb-3 size-6 animate-spin text-orange-400"/>열차 정보를 조회하고 있습니다</div> : searchError ? <div role="alert" className="rounded-2xl border border-orange-400/30 p-5">{searchError}<Button className="mt-3" onClick={searchTrains}>다시 시도</Button></div> : <TrainResults hasSearched={hasSearched} trains={visibleTrains} departure={searchedCondition.departure || departure || "출발역"} arrival={searchedCondition.arrival || arrival || "도착역"} date={searchedCondition.date || date} mode={resultMode} sourceLabel={sourceLabel} onReserve={addReservation} />}
                </div>
              </section>
            </TabsContent>

            <TabsContent value="automation" className="m-0">
              {activeTab === "automation" && (
                <div className="space-y-8">
                  <WatchJobsPanel user={authUser} />
                  <div className="mx-auto max-w-3xl border-t border-white/10 pt-6">
                    <AutomationJobsPanel user={authUser} />
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="settings" className="m-0">
              {activeTab === "settings" && (
                <div className="mx-auto max-w-3xl space-y-4">
                  <AuthPanel user={authUser} loading={authLoading} onAuthChanged={setAuthUser} />
                  <SettingsView
                    notifications={notifications}
                    setNotifications={setNotifications}
                    autoLogin={autoLogin}
                    setAutoLogin={setAutoLogin}
                    autoPay={autoPay}
                    setAutoPay={setAutoPay}
                    isInstalled={isInstalled}
                    canInstall={Boolean(installPrompt)}
                    onInstall={installApp}
                  />
                </div>
              )}
            </TabsContent>
          </div>

          <TabsList className="fixed inset-x-0 bottom-0 z-40 mx-auto grid h-[78px] w-full max-w-6xl grid-cols-3 rounded-none border-t border-white/10 bg-[#090909]/95 p-0 text-white/45 shadow-[0_-18px_50px_rgba(0,0,0,0.35)] backdrop-blur-xl md:sticky md:bottom-5 md:h-16 md:w-[420px] md:rounded-[22px] md:border">
            <NavTab value="booking" icon={<Ticket />} label="예매" />
            <NavTab value="automation" icon={<RefreshCw />} label="자동예약" count={reservations.length} />
            <NavTab value="settings" icon={<UserRound />} label="마이페이지" />
          </TabsList>
        </Tabs>
      </div>
      <Toaster theme="dark" richColors position="top-center" />
    </main>
  );
}

function NavTab({ value, icon, label, count }: { value: string; icon: React.ReactNode; label: string; count?: number }) {
  return (
    <TabsTrigger value={value} className="group h-full flex-col gap-1 rounded-none border-0 text-white/42 after:hidden data-[state=active]:bg-transparent data-[state=active]:text-[#ff8a1f] md:rounded-[18px] md:data-[state=active]:bg-white/[0.05]">
      <span className="relative [&>svg]:size-5">
        {icon}
        {!!count && <span className="absolute -right-3 -top-2 grid min-w-5 place-items-center rounded-full bg-[#ff8a1f] px-1 text-[10px] font-black text-black">{count}</span>}
      </span>
      <span className="text-xs font-bold">{label}</span>
    </TabsTrigger>
  );
}

function StationSelect({ label, value, onChange, options, loading }: { label: string; value: string; onChange: (value: string) => void; options:{name:string;id:string}[];loading:boolean }) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/10 bg-black/35 p-3">
      <p className="mb-2 text-sm text-white/48">{label}</p>
      <Combobox autoHighlight openOnInputClick items={options.map(s=>s.name)} value={value || null} onValueChange={(next)=>onChange(next ?? "")}>
        <ComboboxInput aria-label={`${label} 선택`} placeholder={`${label} 선택`} disabled={loading} className="w-full min-w-0" onClick={(event)=>event.currentTarget.select()} onFocus={(event)=>{const input=event.currentTarget;window.requestAnimationFrame(()=>input.select());}} />
        <ComboboxContent><ComboboxEmpty>해당하는 역이 없습니다.</ComboboxEmpty><ComboboxList>{(station:string)=><ComboboxItem key={station} value={station}>{station}</ComboboxItem>}</ComboboxList></ComboboxContent>
      </Combobox>
      {loading && <p role="status" className="mt-2 text-sm text-white/60">역 목록 로딩 중</p>}
    </div>
  );
}

function FieldShell({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
      <p className="mb-2 text-sm text-white/48">{label}</p>
      <div className="flex items-center gap-2 text-[#ff8a1f]">
        {icon}
        <div className="min-w-0 flex-1 text-white">{children}</div>
      </div>
    </div>
  );
}

function TrainResults({
  hasSearched,
  trains,
  departure,
  arrival,
  date,
  mode,
  sourceLabel,
  onReserve,
}: {
  hasSearched: boolean;
  trains: TrainResult[];
  departure: string;
  arrival: string;
  date: string;
  mode: RailProviderMode;
  sourceLabel: string;
  onReserve: (train: TrainResult) => void;
}) {
  return (
    <section className="min-h-[460px] rounded-[28px] border border-white/[0.08] bg-[#0d0d0d]/80 p-4 sm:p-5 lg:min-h-[650px]">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="text-sm text-white/42">검색 결과</p>
          <h2 className="mt-1 text-xl font-extrabold tracking-tight">{departure} <span className="px-1 text-[#ff8a1f]">→</span> {arrival}</h2>
        </div>
        <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/45">{date || "날짜 선택"}</span>
      </div>

      {!hasSearched ? (
        <div className="grid min-h-[360px] place-items-center text-center lg:min-h-[530px]">
          <div className="max-w-xs">
            <span className="mx-auto grid size-16 place-items-center rounded-2xl border border-white/10 bg-white/[0.035] text-white/26"><Search className="size-8" /></span>
            <h3 className="mt-5 text-lg font-bold">열차를 검색해보세요</h3>
            <p className="mt-2 text-sm leading-6 text-white/38">역과 날짜를 선택하면 열차 시간표와 운임을 확인할 수 있어요.</p>
          </div>
        </div>
      ) : trains.length === 0 ? (
        <div className="grid min-h-[360px] place-items-center text-center">
          <div><Zap className="mx-auto size-10 text-white/25" /><h3 className="mt-4 font-bold">조건에 맞는 고속열차가 없어요</h3><p className="mt-2 text-sm text-white/38">출발시간을 앞당기거나 다른 날짜로 다시 검색해보세요.</p></div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className={`rounded-xl px-3 py-2 text-xs font-semibold ${mode === "live" ? "bg-emerald-400/10 text-emerald-300" : "bg-[#ff8a1f]/10 text-[#ffad62]"}`}>
            {sourceLabel}{mode === "live" ? " · 좌석 잔여 미제공" : ""}
          </div>
          {trains.map((train) => (
            <article key={train.id} className="rounded-2xl border border-white/10 bg-black/35 p-4 transition hover:border-white/20">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-[#ff9b3f]">{train.number}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${train.availability === "available" ? "bg-emerald-400/12 text-emerald-300" : "bg-white/[0.07] text-white/45"}`}>
                      {train.availability === "available" ? "예약 가능" : train.availability === "sold_out" ? "매진" : "좌석 확인 필요"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center gap-3"><strong className="text-2xl tracking-tight">{train.depart}</strong><span className="h-px w-8 bg-white/20" /><strong className="text-2xl tracking-tight">{train.arrive}</strong></div>
                  <p className="mt-1 text-xs text-white/38">{train.duration} · 성인 1인 {train.fare}</p>
                </div>
                {train.source === "tago" ? (
                  <Button asChild className="h-11 rounded-xl bg-white/10 px-4 font-extrabold text-white hover:bg-white/15">
                    <a href="https://www.korail.com/" target="_blank" rel="noreferrer">공식 예매 <ExternalLink className="size-4" /></a>
                  </Button>
                ) : (
                  <Button type="button" onClick={() => onReserve(train)} className={`h-11 rounded-xl px-4 font-extrabold ${train.availability === "available" ? "bg-emerald-400 text-black hover:bg-emerald-300" : "bg-[#ff8a1f] text-black hover:bg-[#ff9d45]"}`}>
                    {train.availability === "available" ? "바로예약" : "자동예약"}
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

