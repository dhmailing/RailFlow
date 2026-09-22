# RailFlow AI 작업 규칙

전체 배경과 제품 요구사항은 프로젝트와 함께 제공된 `RailFlow_Claude_Context_v0.1.md`를 우선한다.

## 사용자 환경

사용자는 개인 PC가 아니라 iPad를 사용한다. 사용자에게 터미널 명령 실행, 로컬 서버 구동, Android Studio/Node 설치, 파일의 수동 일괄 수정을 요구하지 않는다. 결과는 완전한 파일 또는 내려받을 수 있는 전체 프로젝트 ZIP으로 제공한다.

## 현재 상태

- React/Next.js/Vinext 기반 모바일 웹/PWA, 공개 v0.2 유지 및 v0.3 검증 중
- TAGO 실제 시간표 provider 구현. 새 Secret으로 실조회 검증 필요. 좌석 잔여·예약·결제 미구현
- 데모 열차는 `lib/rail/mock-provider.ts`, 데모 예약 상태는 localStorage에 있음
- v0.3 변경사항·검증과 배포 조건은 `docs/V0.3-validation.md` 참조
- 검정 `#070707`, 주황 `#FF8A1F` 디자인

## 개발 원칙

- 데모와 실제 기능을 명확히 구분한다.
- 실제 연동 전에 `RailProvider` 인터페이스와 `MockRailProvider`를 분리한다.
- 비공개 API를 추측하거나 CAPTCHA, 봇 차단, 속도 제한을 우회하지 않는다.
- 비밀번호, 카드정보, OTP, 쿠키를 요청하거나 저장하지 않는다.
- 결제 전 사용자 확인을 기본값으로 한다.
- 과도한 반복 조회, 중복 예약, 무제한 재시도를 구현하지 않는다.
- 수정 후 타입 검사/빌드를 실행하고 결과를 기록한다. 실행할 수 없다면 미검증으로 명시한다.
- `CHANGELOG.md`에 사용자 관점의 변경사항을 남긴다.

## 현재 목표(v0.3)

1. `RailProvider`, `MockRailProvider`, TAGO 실제 시간표 provider를 유지·검증한다.
2. 공공데이터 인증키는 `DATA_GO_KR_SERVICE_KEY` 서버 비밀값으로만 사용한다.
3. 실제 시간표와 좌석 잔여 여부를 절대 혼동하지 않는다.
4. 좌석 잔여·예약 기능은 공식·승인된 연동 방식이 확인된 뒤 별도 구현한다.
5. 기존 예매/자동예약/마이페이지 UX와 PWA 동작을 유지한다.
6. 노출된 키 재사용 금지. 채팅으로 새 키를 요구하지 않는다. 서버 Secret에만 등록한다.
7. 실제 조회·Safari 검증 전 공개 배포본을 교체하지 않는다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
