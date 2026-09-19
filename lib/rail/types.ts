export type RailProviderMode = "demo" | "live";

export type TrainAvailability = "available" | "sold_out" | "unknown";

export type TrainSearchCondition = {
  departure: string;
  arrival: string;
  date: string;
  departAfter: string;
  passengers: number;
  departureId?: string;
  arrivalId?: string;
};

export type TrainResult = {
  id: string;
  number: string;
  trainType: string;
  depart: string;
  arrive: string;
  departAt: string;
  arriveAt: string;
  duration: string;
  durationMinutes: number;
  fare: string;
  fareKrw: number | null;
  availability: TrainAvailability;
  source: "demo" | "tago";
};

export type TrainSearchResponse = {
  mode: RailProviderMode;
  sourceLabel: string;
  searchedAt: string;
  trains: TrainResult[];
};

export interface RailScheduleProvider {
  readonly mode: RailProviderMode;
  readonly sourceLabel: string;
  searchTrains(condition: TrainSearchCondition): Promise<TrainResult[]>;
}
