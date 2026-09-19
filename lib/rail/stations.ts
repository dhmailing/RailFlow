export const stationCatalog = [
  { name: "동탄", cityCode: "31", aliases: ["동탄"] },
  { name: "울산(통도사)", cityCode: "26", aliases: ["울산(통도사)", "울산"] },
  { name: "수서", cityCode: "11", aliases: ["수서"] },
  { name: "서울", cityCode: "11", aliases: ["서울"] },
  { name: "광명", cityCode: "31", aliases: ["광명"] },
  { name: "부산", cityCode: "21", aliases: ["부산"] },
] as const;

export const stationNames = stationCatalog.map((station) => station.name);

export function getStationConfig(name: string) {
  return stationCatalog.find((station) => station.name === name);
}

export function isSupportedStation(name: string): boolean {
  return stationCatalog.some((station) => station.name === name);
}

