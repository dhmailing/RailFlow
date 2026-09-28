import "server-only";

import {
  getAutobookStoreMode,
  isAutobookStoreUsable,
  isKillSwitchOn,
} from "@/lib/autobook/feature-flags";
import { createMemoryAutobookStore } from "@/lib/autobook/memory-store";
import { readPostgresConfig } from "@/lib/autobook/postgres/config";
import { unavailableStore, type AutobookStore } from "@/lib/autobook/store";

// 저장소 선택기.
//
// 규칙은 네 줄이다.
//
//  1. kill switch 가 켜져 있으면 무엇도 고르지 않는다.
//  2. memory 는 개발·테스트 전용이다. Production 에서는 값과 무관하게 막는다.
//  3. postgres 는 연결 설정이 있을 때만 고른다.
//  4. **설정이 잘못되면 memory 로 후퇴하지 않는다.** 실패한 채로 남는다.
//
// 4번이 이 파일의 핵심이다. 후퇴는 편하지만, 그 순간 "서버가 대신 지켜보는"
// 약속이 "이 인스턴스가 살아 있는 동안만"으로 조용히 바뀐다.
//
// PostgreSQL 어댑터는 **동적 import** 로만 들어온다. 기본 fail-closed 경로에서
// Node 전용 드라이버를 끌어오지 않기 위해서다(lib/autobook/postgres/client.ts).

export type StoreResolution = {
  store: AutobookStore;
  mode: "memory" | "postgres" | "disabled";
  usable: boolean;
  /** 못 쓰는 이유. 화면에 그대로 보여줄 수 있는 문구이며 연결 정보는 없다. */
  reason: string | null;
};

export async function resolveAutobookStore(): Promise<StoreResolution> {
  if (isKillSwitchOn()) {
    const reason = "강제 중단 스위치가 켜져 있어 저장소를 사용하지 않습니다.";
    return { store: unavailableStore(reason), mode: "disabled", usable: false, reason };
  }

  const mode = getAutobookStoreMode();

  if (mode === "disabled") {
    const reason = "AUTOBOOK_STORE 가 설정되지 않았습니다(기본값은 비활성입니다).";
    return { store: unavailableStore(reason), mode: "disabled", usable: false, reason };
  }

  if (mode === "memory") {
    if (!isAutobookStoreUsable()) {
      const reason = "메모리 저장소는 운영 환경에서 사용할 수 없습니다.";
      return { store: unavailableStore(reason), mode: "memory", usable: false, reason };
    }
    return { store: createMemoryAutobookStore(), mode: "memory", usable: true, reason: null };
  }

  // postgres
  const config = readPostgresConfig();
  if (!config.ok) {
    // 여기서 memory 를 돌려주지 않는다. 그것이 fail-open 이다.
    return { store: unavailableStore(config.message), mode: "postgres", usable: false, reason: config.message };
  }

  const { createPostgresAutobookStore } = await import("@/lib/autobook/postgres-store");
  return { store: createPostgresAutobookStore(), mode: "postgres", usable: true, reason: null };
}
