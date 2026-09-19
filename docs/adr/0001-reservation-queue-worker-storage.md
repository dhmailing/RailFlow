# ADR 0001 — 예약 작업 Queue·Worker·저장소 후보 비교

- 상태: 채택 대기 (이번 PR은 "테스트/데모용 인메모리" 구현만 포함하며, 아래 실제 후보 중 어느 것도 아직 도입하지 않았다.)
- 배경: `docs/V0.4-ARCHITECTURE.md` §3

## 문제

RailFlow는 Vercel Serverless Functions 위에서 동작한다. 자동예약 작업은 사용자가 앱을 끄거나 화면을 꺼도 서버가 계속 감시해야 하는데, Serverless 함수는 (1) 실행 시간에 상한이 있고 (2) 요청이 끝나면 인스턴스가 재사용된다는 보장이 없으며 (3) 인스턴스 간 메모리를 공유하지 않는다. 따라서 "장시간 실행되는 백그라운드 루프"를 Vercel 함수 하나에 넣을 수 없다.

## 이번 PR의 선택: 인메모리 Queue/Worker (테스트·데모 전용)

`lib/reservation/queue.ts` + `lib/reservation/worker.ts`. 장점: 외부 인프라·비용 없이 인터페이스 분리, 상태 전이, 멱등키, 잠금, kill switch를 실제로 검증할 수 있다. 단점: 프로세스 재시작 시 전체 소실, 인스턴스 간 미공유, 진짜 예약 실행에는 사용 불가. **운영에는 사용하지 않는다.**

## 후보 비교 (실제 도입 시)

| 후보 | Queue | 실행 트리거 | 장점 | 단점 | 비고 |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL (작업 테이블 + `SELECT ... FOR UPDATE SKIP LOCKED`) | DB 자체 | 외부 Cron이 주기적으로 폴링 | 이미 필요한 영속 저장소와 큐를 하나의 인프라로 통합. 트랜잭션으로 멱등성·잠금을 자연스럽게 보장 | 폴링 지연(초 단위), 고빈도 처리에는 비효율 | 이번 규모(개인 사용자 대상 자동예약)에는 가장 무난한 시작점 |
| Redis + BullMQ | Redis | Worker 프로세스(상시 실행) 또는 서버리스 컨슈머 | 재시도·지연 큐·우선순위 등 기능이 이미 구현됨, 지연 낮음 | 상시 실행 Worker가 필요 → Vercel 단독으로는 불충분, 별도 컴퓨트 필요, 관리형 Redis 비용 | Vercel + 별도 Worker 호스트 조합이 필요 |
| Cloud Run(or 유사 상시 컨테이너) Worker + 관리형 큐(SQS/Pub·Sub) | 클라우드 큐 | 상시 컨테이너가 큐를 폴링 | Serverless 실행시간 제약에서 완전히 자유로움, 가시성 타임아웃 등 검증된 안전장치 제공 | 새 유료 인프라, 배포 파이프라인 이원화 | "장시간 감시"가 핵심 기능이 될수록 유리 |
| Vercel Cron + 짧은 폴링 함수 | 없음(DB를 큐처럼 사용) | Vercel Cron이 1분 등 주기로 함수 호출 | 별도 인프라 없이 Vercel 안에서 완결 | 무료 티어 실행 빈도 제한, "즉시성"이 떨어짐(폴링 주기만큼 지연) | 초기 단계 프로토타입에 적합, 트래픽이 늘면 한계 |

## 저장소(Job Store)

이번 PR의 `lib/reservation/job-store.ts`는 `Map`이다. 실제 도입 시 최소 요구사항: 사용자별 작업 이력의 영속성, 동시 갱신에 대한 원자적 업데이트(상태 전이 경합 방지), `userId·departureId·arrivalId·date·passengers` 조합에 대한 유니크 제약(중복 방지를 DB 레벨에서도 보장). `db/index.ts`(기존, Cloudflare Workers 런타임 전용 `cloudflare:workers`에 의존)는 Vercel Node.js 런타임과 호환되지 않으므로 그대로 재사용할 수 없다 — 새 DB 연결 계층이 필요하다.

## 권고

트래픽과 실행 빈도가 아직 검증되지 않은 단계이므로, 공식 Provider 연동이 승인된 뒤 **PostgreSQL 기반 작업 테이블 + Vercel Cron 폴링**으로 먼저 전환하고, 실시간성이 부족하다고 판명되면 그때 Redis/BullMQ 또는 상시 Worker 컴퓨트로 옮기는 단계적 접근을 권고한다. 이 결정은 새로운 유료 인프라 도입에 해당하므로, 실제 전환 PR 이전에 사용자 승인을 받는다(§10 작업 중단 조건).
