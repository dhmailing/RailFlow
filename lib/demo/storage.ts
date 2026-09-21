// sessionStorage-only persistence for the Demo Showcase (§9). Never
// localStorage, never a cookie, never a server request -- see
// lib/demo/types.ts's header. `storage` is injected (rather than reading
// `window.sessionStorage` directly) so this module can be unit-tested under
// Node with a plain in-memory object (scripts/verify-demo-showcase.cjs)
// without a DOM.
//
// (재검토 §2) sessionStorage is writable by the user (devtools, extensions,
// a stale/older build's shape) -- readDemoState() never trusts it blindly.
// Every field, including cross-field invariants (a found candidate must be
// one of the selected ones, terminal states must have a fixed endedAt,
// etc.), is validated with zod before this module hands a value back to the
// reducer. A value that fails validation is never surfaced as a partial or
// "best effort" object: readDemoState() returns null and the corrupted
// sessionStorage entry is deleted so a future write starts clean (§2:
// "손상됐거나 이전 스키마와 호환되지 않으면... 안전한 초기화를 우선").
import { z } from "zod";

import { DEMO_STORAGE_KEY, type DemoJobState } from "@/lib/demo/types";

export type DemoStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const STATUS_VALUES = ["READY", "REGISTERED", "WATCHING", "SEAT_FOUND", "NOTIFIED", "FINISHED", "CANCELLED"] as const;
const CANDIDATE_STATUS_VALUES = ["watching", "seat_found", "stopped"] as const;
// 진행 중(활성) 상태: startedAt은 있어야 하고 endedAt은 아직 없어야 한다.
const ACTIVE_STATUS_VALUES = ["REGISTERED", "WATCHING", "SEAT_FOUND", "NOTIFIED"] as const;
// 이 세 상태는 발견된 후보가 반드시 존재해야 한다(§2 요구사항 그대로).
const REQUIRES_FOUND_CANDIDATE_STATUS_VALUES = ["SEAT_FOUND", "NOTIFIED", "FINISHED"] as const;
const TERMINAL_STATUS_VALUES = ["FINISHED", "CANCELLED"] as const;

const MAX_WATCH_TICK = 10_000; // "0 이상의 제한된 정수" -- 임의로 부풀려진 값을 걸러내는 보수적 상한.

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // new Date(...)는 2026-02-30 같은 값을 3월로 자동 굴려버리므로(overflow),
  // 되돌린 결과가 입력과 정확히 같은지 다시 확인해야 진짜로 유효한 달력
  // 날짜인지 알 수 있다.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be yyyy-MM-dd")
  .refine(isValidCalendarDate, "not a real calendar date");

const isoDateTimeSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "not a valid ISO datetime");

const candidateSchema = z.object({
  id: z.string().min(1),
  trainType: z.string().min(1),
  trainNumber: z.string().min(1),
  departAt: z.string().regex(/^\d{2}:\d{2}$/),
  arriveAt: z.string().regex(/^\d{2}:\d{2}$/),
  fareLabel: z.string().min(1),
  status: z.enum(CANDIDATE_STATUS_VALUES),
});

const conditionSchema = z.object({
  departure: z.string().min(1),
  arrival: z.string().min(1),
  date: dateOnlySchema,
  passengers: z.number().int().min(1).max(4),
});

const historyEntrySchema = z.object({
  at: isoDateTimeSchema,
  from: z.enum(STATUS_VALUES).nullable(),
  to: z.enum(STATUS_VALUES),
});

const notificationSchema = z.object({
  id: z.string().min(1),
  at: isoDateTimeSchema,
  title: z.string().min(1),
  body: z.string().min(1),
});

const demoJobStateSchema = z
  .object({
    condition: conditionSchema,
    candidates: z.array(candidateSchema).min(1),
    selectedCandidateIds: z.array(z.string().min(1)),
    status: z.enum(STATUS_VALUES),
    intervalSeconds: z.number().int().min(1).max(5),
    watchTick: z.number().int().min(0).max(MAX_WATCH_TICK),
    foundCandidateId: z.string().min(1).nullable(),
    history: z.array(historyEntrySchema),
    notifications: z.array(notificationSchema),
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

    // 시작/종료 시각 상태 불변식(§2): READY는 둘 다 없어야 하고, 진행 중
    // 상태는 시작만 있어야 하며, 종료 상태는 둘 다 있어야 하고 역전되면
    // 안 된다.
    if (value.status === "READY") {
      if (value.startedAt !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startedAt"], message: "READY must not have startedAt" });
      if (value.endedAt !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: "READY must not have endedAt" });
    } else if ((ACTIVE_STATUS_VALUES as readonly string[]).includes(value.status)) {
      if (value.startedAt === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startedAt"], message: `status ${value.status} requires startedAt` });
      if (value.endedAt !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: `status ${value.status} must not have endedAt yet` });
    } else if ((TERMINAL_STATUS_VALUES as readonly string[]).includes(value.status)) {
      if (value.startedAt === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startedAt"], message: `status ${value.status} requires startedAt` });
      }
      if (value.endedAt === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: `status ${value.status} requires endedAt` });
      }
      if (value.startedAt !== null && value.endedAt !== null && new Date(value.endedAt).getTime() < new Date(value.startedAt).getTime()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: "endedAt must not be before startedAt" });
      }
    }
  });

export function readDemoState(storage: DemoStorageLike): DemoJobState | null {
  try {
    const raw = storage.getItem(DEMO_STORAGE_KEY);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 파싱조차 안 되는 값 -- 손상된 항목이므로 삭제하고 null.
      clearDemoState(storage);
      return null;
    }
    const result = demoJobStateSchema.safeParse(parsed);
    if (!result.success) {
      // 스키마 검증 실패 -- 입력 원문은 로그로 남기지 않는다(§2). 손상되었거나
      // 이전 스키마와 호환되지 않는 항목은 지우고 안전한 기본 상태로
      // 시작하는 쪽을 택한다(마이그레이션을 시도하지 않는다 -- 이 데모는
      // 실제 사용자 데이터 저장소가 아니다).
      clearDemoState(storage);
      return null;
    }
    return result.data as DemoJobState;
  } catch {
    return null;
  }
}

export function writeDemoState(storage: DemoStorageLike, state: DemoJobState): void {
  try {
    storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage unavailable (private mode, blocked, quota exceeded) --
    // the Demo Showcase keeps working in-memory for the rest of the tab's
    // life even when persistence silently fails.
  }
}

export function clearDemoState(storage: DemoStorageLike): void {
  try {
    storage.removeItem(DEMO_STORAGE_KEY);
  } catch {
    // ignore -- nothing left to clear if the store itself is unavailable
  }
}
