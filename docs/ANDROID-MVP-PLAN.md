# RailFlow Android MVP 준비 현황 (v0.5)

이번 PR은 APK를 빌드하지도, Play Store에 배포하지도 않는다. 아래는 §5가 요구한 "다음 기반"의 실제 구현 상태를 항목별로 정확히 기록한다 — 되어 있는 것과 아직 안 된 것을 구분한다. 더 넓은 배경은 `docs/ANDROID-ROADMAP.md`(v0.4에서 작성, 기술 스택 선정: Kotlin + Jetpack Compose, API 36+)를 그대로 따르며, 이 문서는 v0.5 MVP 단계에서 구체적으로 무엇이 준비됐는지를 보충한다.

## 1. PWA manifest — 되어 있음(기존)

`public/manifest.webmanifest`: `name`, `short_name`, `start_url`, `display: standalone`, `theme_color`/`background_color` (`#070707`), `icons`(192px maskable + favicon). v0.5에서 내용을 바꾸지 않았다.

## 2. 설치 가능 여부 — 되어 있음(기존)

`app/page.tsx`의 `beforeinstallprompt` 핸들러가 설치 배너를 캡처해 마이페이지 탭의 "설치" 버튼과 연결돼 있다(`components/rail-settings.tsx`). 변경 없음.

## 3. Android 아이콘·테마색 — 부분적으로 되어 있음

`theme_color`/`background_color`는 브랜드 색(`#070707`/`#FF8A1F` 포인트)과 일치한다. **아이콘은 SVG 하나(192px maskable)뿐**이다 — 실제 Play Store 등록에는 적응형 아이콘(전경/배경 레이어 PNG, 108dp 기준)과 512px 스토어 등록용 아이콘이 별도로 필요하며, 이는 디자인 자산 제작이 필요해 이번 PR 범위 밖이다(다음 단계 준비 항목).

## 4. 알림 권한 요청 흐름 — 되어 있음(신규, 이번 PR)

`components/watch-jobs.tsx`에 브라우저 `Notification.requestPermission()`을 호출하는 실제 동작하는 버튼이 있다(허용/거부/요청 전 상태를 표시). **다만 이것은 OS/브라우저 권한 요청 자체이며, 실제 FCM 등록이나 Web Push 구독으로는 아직 이어지지 않는다** — `lib/watch/notification/`의 모든 실제 채널 Adapter가 `NOT_CONFIGURED`이기 때문이다(ADR 0002 §5). 알림 수신처 등록 자체는 이메일·텔레그램 chat id 입력으로만 가능하다(`POST /api/devices`).

## 5. 앱 링크·딥링크 설계 — 설계만, 파일은 아직 생성하지 않음

**의도적으로 생성하지 않은 파일**: `public/.well-known/assetlinks.json`. TWA(Trusted Web Activity, ADR 0002 §6)로 출시하려면 이 파일에 실제 Android 패키지명과 앱 서명 인증서의 SHA-256 지문을 넣어 Digital Asset Links를 검증해야 하는데, 아직 패키지명도 서명 키도 존재하지 않는다. 지금 채워 넣으면 검증되지 않는(또는 틀린) 보안 설정 파일을 배포하는 것이므로, 실제 Android 프로젝트와 서명 키가 만들어진 뒤 그 값으로 채워 넣는 것을 다음 단계 작업으로 남긴다.

RailFlow 자체의 딥링크(코레일+로 이동)는 §V0.5-SEAT-WATCH.md §6대로 공식 확인 전까지 절대 만들지 않는다 — 웹 폴백(공식 URL + 복사 가능한 조건 문구)만 제공한다.

## 6. 오프라인 안내 화면 — 되어 있음(신규, 이번 PR)

`app/offline/page.tsx`를 추가하고 `public/sw.js`의 `APP_SHELL`에 사전 캐시했다(`CACHE_NAME`을 `railflow-v3`→`v4`로 올림). 네비게이션 요청이 네트워크에도, 캐시된 `/`에도 실패하면 이 화면으로 폴백한다.

## 7. 개인정보처리방침 및 계정 삭제 진입점 — 되어 있음(신규, 이번 PR)

- `app/privacy/page.tsx`: 로그인 없이 접근 가능한 공개 페이지. 수집 정보, 현재 저장 방식(메모리, 재시작 시 소실)을 있는 그대로 적었다.
- 앱 내 계정 삭제: 마이페이지 탭의 RailFlow 계정 카드 → "계정 삭제"(`components/auth-panel.tsx` → `DELETE /api/auth/account`).
- **외부 웹 계정삭제 페이지**: 네이티브 앱이 아직 없으므로, 이 웹/PWA 앱 자체가 그 "외부 웹" 경로를 겸한다 — `/privacy` 페이지가 삭제 방법을 안내하고, 로그인 후 같은 도메인에서 즉시 삭제할 수 있다. Google Play 정책이 요구하는 "앱을 설치하지 않고도 도달 가능한 계정 삭제 경로"를 현재 시점에서 충족한다.

## 8. AAB, Play App Signing, 내부/폐쇄 테스트 — 아직 없음(계획만)

이번 PR 범위 밖. Android 프로젝트 자체가 없으므로 빌드할 AAB도 없다. TWA 선택 시(ADR 0002 §6) 예상 절차:

1. Bubblewrap 또는 Android Studio로 TWA 프로젝트 생성, 패키지명 확정.
2. `public/.well-known/assetlinks.json`에 실제 서명 SHA-256 등록(§5).
3. Play Console에서 AAB 업로드, **Play App Signing**에 위임(권장 — 키 분실 위험 제거).
4. 내부 테스트 트랙 → 비공개(폐쇄) 테스트 트랙.
5. **신규 개인 개발자 계정**이라면, 프로덕션 공개 전 Play 정책상 **비공개 테스트 12명 이상 · 14일 이상** 요건을 충족해야 한다(`docs/ANDROID-ROADMAP.md`에서 이미 확정한 요건, 변경 없음). 일정에 이 기간을 반드시 반영한다.

## 9. TWA/Capacitor 전환 문서 — ADR 0002 §6

전환 방식 비교(TWA/Capacitor/완전 네이티브)와 채택 이유는 별도 문서를 새로 쓰지 않고 `docs/adr/0002-auth-storage-notification.md` §6에 정리했다 — TWA를 1차 목표로, FCM/네이티브 알림이 꼭 필요해지면 Capacitor로 전환하는 것을 권장한다.

## 10. 휴대폰 화면이 꺼지거나 앱이 종료돼도 감시가 유지되는가

**서버 쪽 설계는 이미 그렇게 되어 있다**: 감시 작업(`WatchJob`)은 클라이언트가 아니라 서버(`lib/watch/store.ts`, `worker.ts`)에 저장되며, 클라이언트는 상태를 조회만 한다. 다만 이번 PR의 저장소가 인메모리라 서버 재시작에는 살아남지 못하고(§ 남은 위험), Worker를 주기적으로 깨우는 백그라운드 스케줄러도 아직 없다(개발 환경에서는 수동 "검증값" 버튼으로 한 스텝씩 진행) — 두 가지 모두 실제 서비스 전환 시 필요한 다음 단계다(ADR 0001/0002의 Queue/Worker·저장소 절 참고).
