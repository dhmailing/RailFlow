import "server-only";

import { getStationConfig } from "@/lib/rail/stations";
import type { RailProvider, TrainResult, TrainSearchCondition } from "@/lib/rail/types";

const TAGO_BASE_URL = "https://apis.data.go.kr/1613000/TrainInfoService";
const STATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type TagoItem = Record<string, string | number | null | undefined>;
type StationCacheEntry = { expiresAt: number; items: TagoItem[] };

const stationCache = new Map<string, StationCacheEntry>();
const stationRequests = new Map<string, Promise<TagoItem[]>>();

export class TagoProviderError extends Error {
  constructor(
    readonly code: "AUTH" | "RATE_LIMIT" | "UPSTREAM" | "SCHEMA" | "STATION_NOT_FOUND" | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "TagoProviderError";
  }
}

function normalizedServiceKey(rawKey: string) {
  const trimmed = rawKey.trim();
  if (!/%[0-9a-f]{2}/i.test(trimmed)) return trimmed;

  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function asItems(value: unknown): TagoItem[] {
  const invalid = () => new TagoProviderError("SCHEMA", "열차정보 응답 형식을 확인할 수 없습니다.");
  if (!value || typeof value !== "object") throw invalid();
  const response = (value as { response?: unknown }).response;
  if (!response || typeof response !== "object") throw invalid();
  const body = (response as { body?: unknown }).body;
  if (!body || typeof body !== "object") throw invalid();
  const items = (body as { items?: unknown }).items;
  if (items === "" || (body as {totalCount?:unknown}).totalCount === 0) return [];
  if (!items || typeof items !== "object") throw invalid();
  const item = (items as { item?: unknown }).item;
  if (Array.isArray(item)) return item.filter((entry): entry is TagoItem => Boolean(entry) && typeof entry === "object");
  if(item === undefined && Number((body as {totalCount?:unknown}).totalCount)===0) return [];
  if(!item || typeof item!=="object") throw invalid();
  return [item as TagoItem];
}

function readResultCode(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const response = (value as { response?: unknown }).response;
  if (!response || typeof response !== "object") return null;
  const header = (response as { header?: unknown }).header;
  if (!header || typeof header !== "object") return null;
  return String((header as { resultCode?: unknown }).resultCode ?? "");
}

async function fetchTago(serviceKey: string, path: string, params: Record<string, string>, attempt = 0): Promise<unknown> {
  const url = new URL(`${TAGO_BASE_URL}/${path}`);
  url.searchParams.set("serviceKey", normalizedServiceKey(serviceKey));
  url.searchParams.set("_type", "json");
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new TagoProviderError("TIMEOUT", "열차정보 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.");
    }
    if(attempt===0 && error instanceof TypeError) return fetchTago(serviceKey,path,params,1);
    throw new TagoProviderError("UPSTREAM", "공식 열차정보 서버에 연결하지 못했습니다.");
  }

  if (response.status === 429) {
    throw new TagoProviderError("RATE_LIMIT", "공식 열차정보 조회 한도를 잠시 초과했습니다.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new TagoProviderError("AUTH", "열차정보 인증을 확인할 수 없습니다. 서비스 관리자에게 문의해주세요.");
  }
  if (!response.ok) {
    throw new TagoProviderError("UPSTREAM", "공식 열차정보 서버가 정상 응답하지 않았습니다.");
  }

  let payload: unknown;
  try {
    const body = await response.text();
    if (/<(?:returnReasonCode|resultCode)>(?:20|30|31|32)<\//.test(body)) throw new TagoProviderError("AUTH", "열차정보 인증을 확인할 수 없습니다. 서비스 관리자에게 문의해주세요.");
    if (/<(?:returnReasonCode|resultCode)>(?:22|23)<\//.test(body)) throw new TagoProviderError("RATE_LIMIT", "공식 열차정보 조회 한도를 초과했습니다. 잠시 후 다시 시도해주세요.");
    payload = JSON.parse(body);
  } catch(error) {
    if(error instanceof TagoProviderError) throw error;
    if(error instanceof Error && error.name === "TimeoutError") throw new TagoProviderError("TIMEOUT", "열차정보 응답이 지연되고 있습니다. 다시 시도해주세요.");
    throw new TagoProviderError("SCHEMA", "공식 열차정보 응답 형식을 확인할 수 없습니다.");
  }

  const resultCode = readResultCode(payload);
  if (!resultCode) throw new TagoProviderError("SCHEMA", "열차정보 응답 형식을 확인할 수 없습니다.");
  if (resultCode !== "00" && resultCode !== "0000") {
    if (["20", "30", "31"].includes(resultCode)) {
      throw new TagoProviderError("AUTH", "공공데이터 인증키를 확인해주세요.");
    }
    if (["22", "23"].includes(resultCode)) {
      throw new TagoProviderError("RATE_LIMIT", "공식 열차정보 조회 한도를 잠시 초과했습니다.");
    }
    throw new TagoProviderError("UPSTREAM", "공식 열차정보 조회가 처리되지 않았습니다.");
  }

  return payload;
}

function normalizeStationName(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/역$/, "")
    .toLowerCase();
}

async function getStationsByCity(serviceKey: string, cityCode: string) {
  const cached = stationCache.get(cityCode);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  const existing = stationRequests.get(cityCode);
  if(existing) return existing;
  const request = fetchTago(serviceKey, "getCtyAcctoTrainSttnList", {
    cityCode,
    numOfRows: "200",
    pageNo: "1",
  }).then(payload=>{
    const items=asItems(payload);
    stationCache.set(cityCode,{items,expiresAt:Date.now()+STATION_CACHE_TTL_MS});
    return items;
  }).finally(()=>stationRequests.delete(cityCode));
  stationRequests.set(cityCode,request);
  return request;
}

export async function resolveStationId(serviceKey: string, stationName: string) {
  const config = getStationConfig(stationName);
  if (!config) throw new TagoProviderError("STATION_NOT_FOUND", "지원하지 않는 역입니다.");

  const aliases = config.aliases.map(normalizeStationName);
  const stations = await getStationsByCity(serviceKey, config.cityCode);
  const match = stations.find((station) => aliases.includes(normalizeStationName(station.nodename)));
  const nodeId = match?.nodeid;
  if (!nodeId) throw new TagoProviderError("STATION_NOT_FOUND", `${stationName} 역 코드를 찾지 못했습니다.`);
  return String(nodeId);
}

function timestampParts(value: unknown) {
  const timestamp = String(value ?? "").replace(/\D/g, "");
  if (timestamp.length !== 14) return null;
  return {
    raw: timestamp,
    date: `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`,
    time: `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}`,
  };
}

function durationMinutes(departure: string, arrival: string) {
  const parse = (value: string) => Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(8, 10)),
    Number(value.slice(10, 12)),
    Number(value.slice(12, 14)),
  );
  return Math.max(0, Math.round((parse(arrival) - parse(departure)) / 60_000));
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}분`;
  return `${hours}시간 ${rest}분`;
}

function formatFare(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return { label: "운임 공식 앱 확인", amount: null };
  return { label: `${amount.toLocaleString("ko-KR")}원`, amount };
}

function isHighSpeedTrain(name: string) {
  return /KTX|SRT/i.test(name);
}

export function createTagoRailProvider(serviceKey: string): RailProvider {
  return {
    mode: "live",
    sourceLabel: "국토교통부 TAGO 실제 운행시간표",
    async searchTrains(condition: TrainSearchCondition): Promise<TrainResult[]> {
      const [departureId, arrivalId] = await Promise.all([
        resolveStationId(serviceKey, condition.departure),
        resolveStationId(serviceKey, condition.arrival),
      ]);
      if ((condition.departureId && condition.departureId!==departureId) || (condition.arrivalId && condition.arrivalId!==arrivalId)) throw new TagoProviderError("STATION_NOT_FOUND", "선택한 역 정보를 다시 불러와주세요.");

      const payload = await fetchTago(serviceKey, "getStrtpntAlocFndTrainInfo", {
        depPlaceId: departureId,
        arrPlaceId: arrivalId,
        depPlandTime: condition.date.replace(/-/g, ""),
        numOfRows: "100",
        pageNo: "1",
      });

      const total=Number((payload as {response?:{body?:{totalCount?:unknown}}}).response?.body?.totalCount ?? 0);
      if(!Number.isFinite(total) || total>1000) throw new TagoProviderError("SCHEMA", "열차정보 응답 범위를 확인할 수 없습니다.");
      const remaining=await Promise.all(Array.from({length:Math.max(0,Math.ceil(total/100)-1)},(_,i)=>fetchTago(serviceKey,"getStrtpntAlocFndTrainInfo",{depPlaceId:departureId,arrPlaceId:arrivalId,depPlandTime:condition.date.replace(/-/g,""),numOfRows:"100",pageNo:String(i+2)})));
      return [payload,...remaining].flatMap(asItems)
        .map((item): TrainResult | null => {
          const departure = timestampParts(item.depplandtime);
          const arrival = timestampParts(item.arrplandtime);
          const trainType = String(item.traingradename ?? "열차").trim();
          if (!departure || !arrival || !isHighSpeedTrain(trainType)) return null;
          if (departure.date !== condition.date || departure.time < condition.departAfter) return null;

          const minutes = durationMinutes(departure.raw, arrival.raw);
          const fare = formatFare(item.adultcharge);
          const trainNumber = String(item.trainno ?? "").trim();

          return {
            id: `tago-${trainNumber || trainType}-${departure.raw}`,
            number: trainNumber ? `${trainType} ${trainNumber}` : trainType,
            trainType,
            depart: departure.time,
            arrive: arrival.time,
            departAt: `${departure.date}T${departure.time}:00+09:00`,
            arriveAt: `${arrival.date}T${arrival.time}:00+09:00`,
            duration: formatDuration(minutes),
            durationMinutes: minutes,
            fare: fare.label,
            fareKrw: fare.amount,
            availability: "unknown",
            source: "tago",
          };
        })
        .filter((train): train is TrainResult => train !== null)
        .sort((a, b) => a.departAt.localeCompare(b.departAt));
    },
  };
}
