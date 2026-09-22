// sessionStorage-only persistence for the public automation macro demo.
// Never localStorage, never a cookie, never a server request -- see
// types.ts's header. `storage` is injected so this module can be
// unit-tested under Node without a DOM (scripts/verify-automation-demo.cjs).
// Mirrors lib/demo/storage.ts's validation philosophy exactly: a value that
// fails schema/invariant validation is never surfaced as a partial "best
// effort" object -- readAutomationDemoState() returns null and the
// corrupted entry is deleted so a future write starts clean.
import { z } from "zod";

import { AUTOMATION_DEMO_STORAGE_KEY, type AutomationDemoState } from "@/lib/automation-demo/types";

export type AutomationDemoStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const STATUS_VALUES = ["READY", "WATCHING", "SEAT_FOUND", "PURCHASE_CLICKING", "RESERVING", "PAYMENT_PENDING", "COMPLETED", "PAYMENT_EXPIRED", "CANCELLED"] as const;
const CANDIDATE_STATUS_VALUES = ["waiting", "checking", "sold_out", "insufficient", "seat_found", "stopped"] as const;
const ACTIVE_STATUS_VALUES = ["WATCHING", "SEAT_FOUND", "PURCHASE_CLICKING", "RESERVING", "PAYMENT_PENDING"] as const;
const REQUIRES_FOUND_CANDIDATE_STATUS_VALUES = ["SEAT_FOUND", "PURCHASE_CLICKING", "RESERVING", "PAYMENT_PENDING", "COMPLETED", "PAYMENT_EXPIRED"] as const;
const REQUIRES_RESERVATION_STATUS_VALUES = ["PAYMENT_PENDING", "COMPLETED", "PAYMENT_EXPIRED"] as const;
// PAYMENT_EXPIRED requires startedAt/endedAt like a terminal status even
// though it isn't one in state-machine.ts (it can still lead to a fresh
// RESTART_WATCH journey, exactly like COMPLETED/CANCELLED).
const REQUIRES_END_TIMESTAMPS_STATUS_VALUES = ["COMPLETED", "CANCELLED", "PAYMENT_EXPIRED"] as const;

const MAX_WATCH_TICK = 10_000;

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be yyyy-MM-dd")
  .refine(isValidCalendarDate, "not a real calendar date");

const timeOnlySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:mm");

const isoDateTimeSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "not a valid ISO datetime");

const scenarioSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always_sold_out") }),
  z.object({
    kind: z.literal("seat_after_n_checks"),
    checksRequired: z.number().int().min(1).max(20),
    seatClass: z.enum(["standard", "special"]),
    seatCount: z.number().int().min(0).max(20),
  }),
]);

const candidateSchema = z.object({
  id: z.string().min(1),
  trainType: z.string().min(1),
  trainNumber: z.string().min(1),
  departAt: z.string().regex(/^\d{2}:\d{2}$/),
  arriveAt: z.string().regex(/^\d{2}:\d{2}$/),
  fareLabel: z.string().min(1),
  status: z.enum(CANDIDATE_STATUS_VALUES),
  checkCount: z.number().int().min(0).max(MAX_WATCH_TICK),
  scenario: scenarioSchema,
});

const conditionSchema = z.object({
  departure: z.string().min(1),
  arrival: z.string().min(1),
  date: dateOnlySchema,
  timeRangeStart: timeOnlySchema,
  timeRangeEnd: timeOnlySchema,
  passengers: z.number().int().min(1).max(4),
  seatClassPreference: z.enum(["standard_only", "standard_preferred", "any"]),
});

const historyEntrySchema = z.object({
  at: isoDateTimeSchema,
  from: z.enum(STATUS_VALUES).nullable(),
  to: z.enum(STATUS_VALUES),
});

const reservationNumberSchema = z.string().regex(/^RF-[A-Z0-9]{6,10}$/);

const automationDemoStateSchema = z
  .object({
    condition: conditionSchema,
    candidates: z.array(candidateSchema).min(1),
    selectedCandidateIds: z.array(z.string().min(1)),
    status: z.enum(STATUS_VALUES),
    intervalSeconds: z.number().int().min(1).max(5),
    watchTick: z.number().int().min(0).max(MAX_WATCH_TICK),
    foundCandidateId: z.string().min(1).nullable(),
    reservationNumber: reservationNumberSchema.nullable(),
    paymentDeadline: isoDateTimeSchema.nullable(),
    history: z.array(historyEntrySchema),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    endedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const candidateIds = value.candidates.map((candidate) => candidate.id);
    if (new Set(candidateIds).size !== candidateIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "candidate ids must be unique" });
    }
    const candidateIdSet = new Set(candidateIds);
    if (new Set(value.selectedCandidateIds).size !== value.selectedCandidateIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedCandidateIds"], message: "selected candidate ids must be unique" });
    }
    for (const id of value.selectedCandidateIds) {
      if (!candidateIdSet.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedCandidateIds"], message: `selected candidate ${id} does not exist in candidates` });
      }
    }

    if (value.foundCandidateId !== null && !value.selectedCandidateIds.includes(value.foundCandidateId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["foundCandidateId"], message: "foundCandidateId must be one of selectedCandidateIds" });
    }
    if ((REQUIRES_FOUND_CANDIDATE_STATUS_VALUES as readonly string[]).includes(value.status) && value.foundCandidateId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["foundCandidateId"], message: `status ${value.status} requires a non-null foundCandidateId` });
    }
    if ((REQUIRES_RESERVATION_STATUS_VALUES as readonly string[]).includes(value.status) && (value.reservationNumber === null || value.paymentDeadline === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reservationNumber"], message: `status ${value.status} requires reservationNumber and paymentDeadline` });
    }

    if (value.status === "READY") {
      if (value.startedAt !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startedAt"], message: "READY must not have startedAt" });
      if (value.endedAt !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: "READY must not have endedAt" });
    } else if ((ACTIVE_STATUS_VALUES as readonly string[]).includes(value.status)) {
      if (value.startedAt === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startedAt"], message: `status ${value.status} requires startedAt` });
      if (value.endedAt !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: `status ${value.status} must not have endedAt yet` });
    } else if ((REQUIRES_END_TIMESTAMPS_STATUS_VALUES as readonly string[]).includes(value.status)) {
      if (value.startedAt === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startedAt"], message: `status ${value.status} requires startedAt` });
      if (value.endedAt === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: `status ${value.status} requires endedAt` });
      if (value.startedAt !== null && value.endedAt !== null && new Date(value.endedAt).getTime() < new Date(value.startedAt).getTime()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: "endedAt must not be before startedAt" });
      }
    }
  });

export function readAutomationDemoState(storage: AutomationDemoStorageLike): AutomationDemoState | null {
  try {
    const raw = storage.getItem(AUTOMATION_DEMO_STORAGE_KEY);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      clearAutomationDemoState(storage);
      return null;
    }
    const result = automationDemoStateSchema.safeParse(parsed);
    if (!result.success) {
      clearAutomationDemoState(storage);
      return null;
    }
    return result.data as AutomationDemoState;
  } catch {
    return null;
  }
}

export function writeAutomationDemoState(storage: AutomationDemoStorageLike, state: AutomationDemoState): void {
  try {
    storage.setItem(AUTOMATION_DEMO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage unavailable (private mode, blocked, quota exceeded) --
    // the demo keeps working in-memory for the rest of the tab's life.
  }
}

export function clearAutomationDemoState(storage: AutomationDemoStorageLike): void {
  try {
    storage.removeItem(AUTOMATION_DEMO_STORAGE_KEY);
  } catch {
    // ignore
  }
}
