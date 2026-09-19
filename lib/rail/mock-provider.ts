import type { RailProvider, TrainResult, TrainSearchCondition } from "@/lib/rail/types";

const demoRows = [
  { number: "KTX 331", depart: "17:22", arrive: "19:18", durationMinutes: 116, fareKrw: 40_800, availability: "sold_out" as const },
  { number: "KTX 335", depart: "18:07", arrive: "20:05", durationMinutes: 118, fareKrw: 40_800, availability: "sold_out" as const },
  { number: "KTX 339", depart: "19:14", arrive: "21:10", durationMinutes: 116, fareKrw: 40_800, availability: "available" as const },
];

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}시간 ${rest}분`;
}

export const mockRailProvider: RailProvider = {
  mode: "demo",
  sourceLabel: "화면 검증용 데모 운행정보",
  async searchTrains(condition: TrainSearchCondition): Promise<TrainResult[]> {
    return demoRows
      .filter((row) => row.depart >= condition.departAfter)
      .map((row) => ({
        id: `demo-${row.number.replace(/\s/g, "-")}-${condition.date}-${row.depart}`,
        number: row.number,
        trainType: "KTX",
        depart: row.depart,
        arrive: row.arrive,
        departAt: `${condition.date}T${row.depart}:00+09:00`,
        arriveAt: `${condition.date}T${row.arrive}:00+09:00`,
        duration: formatDuration(row.durationMinutes),
        durationMinutes: row.durationMinutes,
        fare: `${row.fareKrw.toLocaleString("ko-KR")}원`,
        fareKrw: row.fareKrw,
        availability: row.availability,
        source: "demo",
      }));
  },
};

