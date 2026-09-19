import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { mockRailProvider } from "@/lib/rail/mock-provider";
import { isSupportedStation } from "@/lib/rail/stations";
import { createTagoRailProvider, TagoProviderError } from "@/lib/rail/tago-provider";
import type { TrainSearchCondition, TrainSearchResponse } from "@/lib/rail/types";

export const dynamic = "force-dynamic";

const searchSchema = z.object({
  departure: z.string().min(1).refine(isSupportedStation),
  arrival: z.string().min(1).refine(isSupportedStation),
  date: z.string().date("출발일을 올바르게 선택해주세요."),
  departAfter: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "출발시간을 확인해주세요."),
  departureId: z.string().regex(/^(NAT[A-Z0-9]+|demo-\d+)$/),
  arrivalId: z.string().regex(/^(NAT[A-Z0-9]+|demo-\d+)$/),
  passengers: z.coerce.number().int().min(1).max(4),
}).refine((value) => value.departure !== value.arrival, {
  message: "출발역과 도착역은 달라야 합니다.",
});

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const resultCache = new Map<string, { expiresAt: number; response: TrainSearchResponse }>();
const inFlight = new Map<string, Promise<TrainSearchResponse>>();

function isRateLimited(request: NextRequest) {
  const clientId = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "anonymous";
  const now = Date.now();
  for (const [key,value] of rateBuckets) if(value.resetAt <= now) rateBuckets.delete(key);
  const bucket = rateBuckets.get(clientId);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(clientId, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 12;
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(request: NextRequest) {
  if (isRateLimited(request)) {
    return errorResponse(429, "RATE_LIMITED", "잠시 후 다시 검색해주세요.");
  }

  const parsed = searchSchema.safeParse({
    departure: request.nextUrl.searchParams.get("departure"),
    arrival: request.nextUrl.searchParams.get("arrival"),
    date: request.nextUrl.searchParams.get("date"),
    departAfter: request.nextUrl.searchParams.get("departAfter"),
    passengers: request.nextUrl.searchParams.get("passengers") ?? "1",
    departureId: request.nextUrl.searchParams.get("departureId"),
    arrivalId: request.nextUrl.searchParams.get("arrivalId"),
  });
  if (!parsed.success) {
    return errorResponse(400, "INVALID_SEARCH", "출발역·도착역·날짜·시간을 확인해주세요. 두 역은 서로 달라야 합니다.");
  }

  const condition = parsed.data satisfies TrainSearchCondition;
  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY?.trim();
  const demo = request.nextUrl.searchParams.get("mode") === "demo";
  if (!demo && !serviceKey) return errorResponse(503,"NOT_CONFIGURED","실제 조회 연결을 준비 중입니다. 새 인증키 등록 후 이용할 수 있습니다.");
  if (!demo && (!condition.departureId.startsWith("NAT") || !condition.arrivalId.startsWith("NAT"))) return errorResponse(400,"INVALID_STATION","역 목록을 다시 불러온 후 선택해주세요.");
  const provider = demo ? mockRailProvider : createTagoRailProvider(serviceKey!);
  const cacheKey = `${provider.mode}:${condition.departureId}:${condition.arrivalId}:${condition.date}:${condition.departAfter}`;
  for (const [key,value] of resultCache) if(value.expiresAt<=Date.now()) resultCache.delete(key);
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.response, {
      headers: { "cache-control": "no-store", "server-timing":"cache;desc=HIT" },
    });
  }

  try {
    let pending = inFlight.get(cacheKey);
    if (!pending) {
      pending = provider.searchTrains(condition).then(trains => ({
      mode: provider.mode,
      sourceLabel: provider.sourceLabel,
      searchedAt: new Date().toISOString(),
      trains,
      } satisfies TrainSearchResponse)).finally(()=>inFlight.delete(cacheKey));
      inFlight.set(cacheKey,pending);
    }
    const response = await pending;
    if(resultCache.size>=200) resultCache.delete(resultCache.keys().next().value!);
    resultCache.set(cacheKey, { response, expiresAt: Date.now() + 60_000 });
    return NextResponse.json(response, {
      headers: { "cache-control": "no-store", "server-timing":"cache;desc=MISS" },
    });
  } catch (error) {
    if (error instanceof TagoProviderError) {
      const status = error.code === "RATE_LIMIT" ? 429 : error.code === "AUTH" ? 503 : 502;
      return errorResponse(status, `TAGO_${error.code}`, error.message);
    }
    return errorResponse(500, "SEARCH_FAILED", "열차 조회 중 오류가 발생했습니다.");
  }
}
