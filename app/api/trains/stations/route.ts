import { NextResponse } from "next/server";
import { stationCatalog } from "@/lib/rail/stations";
import { resolveStationId, TagoProviderError } from "@/lib/rail/tago-provider";

export const dynamic = "force-dynamic";
type Station = { name: string; id: string };
let cached: { items: Station[]; expires: number } | undefined;
let pending: Promise<Station[]> | undefined;
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("mode") === "demo") {
    return NextResponse.json({ stations: stationCatalog.map((s, i) => ({name:s.name,id:`demo-${i}`})), mode:"demo" });
  }
  const key = process.env.DATA_GO_KR_SERVICE_KEY?.trim();
  if (!key) return NextResponse.json({ error:{code:"NOT_CONFIGURED",message:"실제 조회 연결을 준비 중입니다. 새 인증키 등록 후 이용할 수 있습니다."} },{status:503});
  try {
    if (!cached || cached.expires < Date.now()) {
      pending ??= Promise.all(stationCatalog.map(async s => ({ name:s.name,id:await resolveStationId(key,s.name) }))).finally(()=>{pending=undefined;});
      cached={items:await pending,expires:Date.now()+86400000};
    }
    return NextResponse.json({stations:cached.items,mode:"live"},{headers:{"cache-control":"private, max-age=86400"}});
  } catch (error) {
    return NextResponse.json({error:{code:"STATIONS_FAILED",message:error instanceof TagoProviderError?error.message:"역 목록을 불러오지 못했습니다. 다시 시도해주세요."}},{status:502});
  }
}
