# ADR 0002 — 인증·영속 저장소·알림·Queue/Worker·Android 출시방식 비교

- 상태: 채택 대기(이번 PR은 인증만 실제 구현하고, 나머지는 설계/비교만 한다)
- 배경: `docs/V0.5-SEAT-WATCH.md`, PR #6 `docs/V0.4-INTEGRATION-RESEARCH.md`(코레일-SR 통합 조사)

## 1. 공식 좌석정보/예약 연동 가능성 (현재 상태)

PR #6 조사와 이번 PR 작업 시점 기준으로 재확인한 결과, 코레일-SR 기업결합(`코레일+`, 2026-09-01 통합 운행·예매)은 승인·출시됐지만 **공식 셀프서비스 실시간 잔여좌석·예약·결제 API는 여전히 확인되지 않았다.** Klook 등 외부 판매 사례는 B2B 판매계약이지 공개 API의 증거가 아니라는 결론도 유효하다. 따라서:

- `SeatAvailabilityProvider`의 Production 기본값은 `unavailableSeatAvailabilityProvider`이고, 계약 체결 전까지 바뀌지 않는다.
- `BookingLaunchProvider`는 딥링크를 절대 지어내지 않는다(§V0.5 문서 §6).
- 향후 공식 연동이 가능해지면 두 인터페이스에 새 구현체를 추가하는 것만으로 교체되며, 상태 모델·API·UI는 바뀌지 않는다.

## 2. 인증 방식

| 후보 | 설명 | 장점 | 단점 | 외부 자원 필요 |
| --- | --- | --- | --- | --- |
| **불투명 서버 세션(채택)** | `crypto.randomBytes` 토큰 + 서버측 세션 레코드, httpOnly(+Production `__Host-`) 쿠키로만 전달 | 즉시 revocation(행 삭제), 서명 키 관리 불필요, 계정 삭제/kill switch가 단순 delete | 매 요청마다 저장소 조회 필요(세션 검증에 DB/캐시 hit 1회), 네이티브(Android) 클라이언트를 위한 별도 토큰 전달 방식이 필요(아래 참고) | 없음 |
| 서명된 Stateless JWT | HMAC/RSA로 서명한 자체 검증 토큰 | 저장소 조회 없이 검증 가능(지연 낮음) | 즉시 revocation이 어려움(블록리스트 별도 필요), 서명 키 로테이션 관리 필요, 계정 삭제해도 만료 전까지 토큰이 유효해 보일 수 있음 | 서명 비밀키(자체 생성은 가능하지만 키 관리 부담) |
| NextAuth.js/Auth.js + OAuth Provider(Google 등) | 소셜 로그인 위임 | 비밀번호 저장 불필요, 구현 빠름 | 실제 OAuth 앱(Google Cloud 프로젝트 등)을 새로 만들어야 함 — "새 외부 프로젝트·유료 리소스 생성 금지" 원칙과 충돌 | Google/기타 OAuth 앱 등록 필요 |
| 완전 위임형 인증 서비스(Auth0, Clerk 등) | SaaS 인증 | 기능 풍부(MFA 등) | 유료/외부 서비스 신규 생성 필요 | 유료 서비스 계정 |

**결론**: 이번 단계 제약(외부 프로젝트·유료 리소스 생성 금지) 아래에서는 불투명 서버 세션이 유일하게 지금 바로 구현 가능한 선택지다. OAuth/외부 인증 서비스는 그 제약이 풀리면 재검토 대상이다.

**정정(검토 후 반영)**: 최초 초안은 이 방식이 "Android Bearer 토큰으로도 바로 재사용 가능"하다고 적었으나, 이는 잘못된 판단이었다. 세션 토큰을 `Authorization: Bearer` 헤더로도 받아들이는 것은 (1) 토큰이 쿠키 밖에서 로그·프록시·브라우저 확장 등에 노출될 경로를 늘리고, (2) httpOnly 쿠키가 주는 XSS 내성을 헤더 전달에는 적용할 수 없게 만든다. 그래서 이번 PR은 Bearer 지원을 제거하고 쿠키 전용으로 되돌렸다 — 세션 토큰은 로그인/회원가입 응답 JSON에도 담기지 않는다. Android 네이티브 클라이언트는 이 쿠키 세션을 그대로 재사용하지 않고, 토큰 회전·폐기·안전한 저장소(Android Keystore 등)를 포함한 별도의 모바일 인증 설계가 필요하며 이는 향후 별도 PR/ADR의 범위다.

## 3. 영속 저장소

| 후보 | 장점 | 단점 |
| --- | --- | --- |
| **PostgreSQL(채택, 설계만)** | 관계형 제약(unique, FK, partial index)으로 중복 방지·소유권을 DB 레벨에서도 보장 가능(§Postgres 스키마), Vercel과 궁합이 좋은 관리형 옵션이 다수 존재, ADR 0001(v0.4)의 결론과 일관성 유지 | 관리형 인스턴스를 실제로 붙이려면 새 인프라(비용) 필요 — 이번 PR 범위 밖 |
| SQLite/Turso(엣지 SQLite) | 서버리스 친화적, 저비용 시작 | 동시 쓰기·복잡한 partial unique index 지원이 Postgres보다 약함, 기존 `db/schema.ts`(D1/SQLite)와 이름이 겹쳐 혼동 소지 |
| 계속 인메모리 | 추가 작업 없음 | 재시작 시 전체 소실 — 실제 서비스로는 쓸 수 없음. 이번 PR이 이미 이 상태이며, 다음 단계에서 반드시 벗어나야 할 임시 상태로 문서화한다 |
| 기존 `db/schema.ts`(Cloudflare D1) 재사용 | 이미 저장소에 존재 | Cloudflare Workers 런타임 전용(`cloudflare:workers` import, `db/index.ts`)이라 Vercel Node.js 런타임과 호환되지 않는다(v0.4 ADR 0001에서 이미 확인된 제약) — v0.5도 동일한 결론 |

**결론**: PostgreSQL을 목표로 스키마를 설계했고(`db/postgres/migrations/0001_init.sql`), 실제 연결은 이번 PR 범위 밖(§10 작업 중단 조건: 새 유료 인프라 생성 금지)이므로 다음 승인 단계로 남긴다.

## 4. Queue/Worker

v0.4의 ADR 0001과 동일한 결론이 v0.5의 취소표 감시에도 그대로 적용된다: Vercel Serverless 함수는 실행 시간 상한이 있고 인스턴스 간 메모리를 공유하지 않으므로, "장시간 감시"를 요청 하나에 묶을 수 없다. `lib/watch/queue.ts`/`worker.ts`는 v0.4와 동일하게 **인메모리·테스트 전용** 큐(멱등키, 잠금, kill switch 포함)이며, 실제 운영 후보 비교(PostgreSQL 폴링 / Redis+BullMQ / Cloud Run 상시 Worker / Vercel Cron)는 ADR 0001을 그대로 참조한다 — 두 기능(예약 작업, 취소표 감시)이 결국 같은 인프라 결정을 공유하게 될 가능성이 높으므로, 실제 전환 시 하나의 Worker 인프라로 통합하는 것을 권장한다.

## 5. 알림 서비스

| 채널 | 장점 | 단점 | 비용 | 이번 PR 상태 |
| --- | --- | --- | --- | --- |
| **Firebase Cloud Messaging(FCM)** | Android 네이티브 푸시의 사실상 표준, 무료 티어로 충분 | Firebase 프로젝트 신규 생성 필요, 서버 키/서비스 계정 관리 | 무료(사용량 기준 Firebase 요금제 내) | 인터페이스만 정의, `NOT_CONFIGURED` |
| **PWA Web Push** | 앱 설치 없이 브라우저에서 푸시 가능, 표준 기술(VAPID) | VAPID 키 페어 발급·관리 필요, 브라우저별 지원 편차 | 무료 | 인터페이스만 정의, `NOT_CONFIGURED` |
| **텔레그램 봇 API** | 봇 생성이 무료·즉시 가능, 별도 앱 설치 불필요 | 사용자가 텔레그램을 써야 함(국내 채택률 낮음), 봇 토큰 보안 필요 | 무료 | 인터페이스만 정의, `NOT_CONFIGURED` |
| **이메일(SES/SMTP 등)** | 누구나 즉시 사용 가능, 별도 앱 불필요 | 실시간성이 푸시보다 떨어짐(수신함 확인 지연), 발신 도메인 인증(SPF/DKIM) 필요 | 저비용~무료 티어 존재 | 인터페이스만 정의, `NOT_CONFIGURED` |
| **테스트용 InMemory(채택, 기본)** | 외부 계정·키 전혀 불필요, 즉시 E2E 테스트 가능 | 실제 사용자에게 아무것도 보내지 않음 | 없음 | **구현·기본 사용** |

**결론**: 이번 PR은 "외부 계정이나 실서비스 키를 요구하지 않는 테스트 Adapter 기본 구현"이 명시적 요구사항이므로 InMemory만 구현했다. 실제 서비스 단계에서는 FCM(Android 네이티브)과 Web Push(PWA)를 우선순위로 두고, 텔레그램·이메일을 보조 채널로 두는 순서를 권장한다 — 단, FCM/Web Push 모두 새 프로젝트/키 발급이 필요해 "다음 단계에서 준비해야 할 계정" 목록에 포함된다(완료 보고 참고).

## 6. Android 출시 방식

| 방식 | 설명 | 장점 | 단점 |
| --- | --- | --- | --- |
| **TWA(Trusted Web Activity)** | 기존 PWA를 안드로이드 앱 셸로 감싸 Play Store에 배포 | 코드 재사용 100%(이 저장소의 Next.js 앱을 그대로 사용), 유지보수 단일화, Digital Asset Links로 Chrome 커스텀탭 없이 전체화면 실행 | 네이티브 API(AccessibilityService 등은 애초에 금지 대상이라 무관) 접근이 제한적, FCM 연동에 Android용 별도 설정(`google-services.json`) 필요 |
| **Capacitor** | 웹 앱을 네이티브 셸+플러그인으로 감싸 배포 | 네이티브 플러그인(푸시, 클립보드 등) 접근 폭이 TWA보다 넓음, 여전히 웹 코드 재사용 | 빌드 파이프라인이 TWA보다 복잡, 네이티브 프로젝트(Android Studio) 유지 필요 |
| 완전 네이티브(Kotlin + Jetpack Compose) | 처음부터 네이티브로 새로 작성 | 최상의 UX, 완전한 플랫폼 통합 | 이 저장소의 웹 코드와 별도 유지보수 — 두 코드베이스 동기화 비용, 개발 기간 가장 김 |

**결론**: `docs/ANDROID-MVP-PLAN.md`는 **TWA를 1차 목표, Capacitor를 FCM/네이티브 알림 채널이 꼭 필요해질 때의 전환 후보**로 제시한다. 완전 네이티브 재작성은 이 앱의 핵심 가치(서버가 감시하고 알리기만 하면 됨, 클라이언트는 얇아도 됨)에 비해 비용이 크므로 권장하지 않는다.
