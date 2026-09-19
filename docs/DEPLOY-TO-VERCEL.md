# RailFlow v0.3 → Vercel 배포 가이드

이 문서는 기존 ChatGPT Sites(Vinext·Cloudflare Workers) 배포와 **별개로**, 동일한 소스를 Vercel에 배포하기 위한 절차다. 두 배포 경로는 서로 다른 빌드 스크립트를 사용하도록 분리했으므로 어느 한쪽을 배포해도 다른 쪽에 영향을 주지 않는다.

## 0. 호환성 점검 결과 (선반영)

- 이 저장소의 실제 애플리케이션 코드(`app/page.tsx`, `app/api/trains/*/route.ts`, `app/layout.tsx`)는 처음부터 표준 Next.js App Router 문법으로 작성돼 있었다. Vinext·Vite·Cloudflare 관련 설정은 `vite.config.ts`, `build/sites-vite-plugin.ts` 등 **별도의 빌드 파이프라인**일 뿐, 애플리케이션 코드 자체를 Cloudflare 전용으로 만들지 않는다.
- 실제로 `pnpm exec next build`(Next.js 자체 CLI, Turbopack)를 이 저장소에 그대로 실행해 확인했다. **코드 수정 없이 빌드 성공**, 이어서 `next start`로 실행해 세 API(`/api/trains/status`, `/api/trains/stations`, `/api/trains/search`)가 기존과 동일하게 응답함을 확인했다.
- `db/index.ts`(`import { env } from "cloudflare:workers"` 사용)와 `examples/d1/**`는 RailFlow 화면·API 어디서도 import되지 않는 스타터 템플릿 잔재임을 확인했다. Next.js 빌드는 실제로 참조되는 파일만 번들에 포함하므로 영향이 없다. **삭제하지 않았다** — 사용하지 않지만 존재해도 무해하다.
- `vite.config.ts`, `build/sites-vite-plugin.ts`, `.openai/hosting.json`, `scripts/*` 등 Sites 전용 파일은 전혀 수정하지 않았다. `next build`는 이 파일들을 아예 사용하지 않는다(Next.js CLI는 `vite.config.ts`를 읽지 않는다).

## 1. 이번에 추가·수정한 파일 (전부 안전하게 분리됨)

| 파일 | 내용 |
|---|---|
| `package.json` | `scripts`에 `"vercel-build": "next build"` 한 줄만 추가. 기존 `dev`/`build`/`start`(Sites용)는 그대로 유지. |
| `vercel.json` | 신규. Vercel 프로젝트 설정을 코드로 명시(아래 §2). |
| `docs/DEPLOY-TO-VERCEL.md` | 이 문서. |

`.env*`는 이미 `.gitignore`에서 `.env.example`만 예외로 제외돼 있어 `.env`/`.env.local`은 원래부터 Git에 올라가지 않는다(추가 조치 불필요, 기존 규칙 확인만 함).

## 2. Vercel 프로젝트 설정

Vercel 대시보드에서 이 저장소를 새 프로젝트로 연결할 때 아래 값을 사용한다(`vercel.json`에도 동일하게 명시해뒀으므로, 대시보드에서 "Import" 시 자동으로 채워질 수 있다 — 다를 경우 아래 값으로 직접 맞춘다).

| 항목 | 값 |
|---|---|
| Framework Preset | **Next.js** |
| Root Directory | `.` (저장소 루트. 모노레포 아님 — `pnpm-workspace.yaml`은 `packages:` 목록이 없는 설정 전용 파일이라 서브패키지가 없다) |
| Build Command | `next build` (또는 비워두면 `vercel-build` 스크립트가 자동 인식됨) |
| Install Command | `pnpm install --frozen-lockfile` |
| Output 설정 | **커스텀 지정 없음.** Next.js 프레임워크로 인식되면 Vercel이 `.next`를 자체 Build Output API로 처리한다. `outputDirectory`를 직접 지정하지 않는다 — 지정하면 오히려 서버리스 함수 생성이 깨질 수 있다. |
| Node.js 버전 | 22.x 권장(`package.json`의 `engines.node: >=22.13.0`과 일치하도록 Vercel 프로젝트의 Node 버전 설정 확인) |

## 3. 등록할 환경변수

Vercel 프로젝트의 **Environment Variables** 화면에서 Production과 Preview 양쪽 모두에 등록한다.

```
변수명: DATA_GO_KR_SERVICE_KEY
값: (새로 발급한 키. 채팅에는 절대 입력하지 않는다. 노출된 이전 키는 재사용하지 않는다)
```

- `NEXT_PUBLIC_` 접두사를 붙이지 않는다 — 붙이면 브라우저 번들에 노출된다.
- 코드는 `process.env.DATA_GO_KR_SERVICE_KEY`로만 읽는다(`app/api/trains/*/route.ts`, `lib/rail/tago-provider.ts`). ChatGPT Sites와 완전히 동일한 변수명이므로 두 배포 환경에 각각 등록하되 이름은 통일해야 한다.
- Preview 배포(PR별 자동 미리보기)에서도 실제 조회를 확인하려면 Preview 환경에도 같은 키를 등록해야 한다. 등록하지 않으면 Preview에서는 `stations?mode=live`가 503(`NOT_CONFIGURED`)으로 응답한다 — 이는 결함이 아니라 설계된 동작이다.

## 4. Production·Preview 양쪽에서 API가 동작하는 이유

세 라우트 모두 `export const dynamic = "force-dynamic"`가 선언된 표준 Next.js Route Handler(`app/api/trains/*/route.ts`)다. Vercel은 Next.js 프레임워크로 인식하는 즉시 이런 라우트를 서버리스 함수로 자동 배포하며, 이는 Production 배포와 PR Preview 배포 모두에 동일하게 적용된다(별도 설정 불필요). 요청 시 매번 실행되는 서버 전용 코드이므로 `DATA_GO_KR_SERVICE_KEY`는 클라이언트에 노출되지 않는다.

## 5. 기존 ChatGPT Sites 버전에 미치는 영향

**영향 없음.** `pnpm build`(Sites/vinext 경로)는 이번 변경 전후로 동일하게 동작함을 다시 빌드해 확인했다. `vite.config.ts`, `build/sites-vite-plugin.ts`, `.openai/hosting.json`, `scripts/run-framework.mjs` 등 Sites가 사용하는 파일은 하나도 건드리지 않았고, 추가한 `vercel.json`·`vercel-build` 스크립트는 Sites 빌드 과정에서 전혀 참조되지 않는다. 두 배포는 같은 소스에서 나온 서로 독립적인 산출물이며, 어느 하나를 배포해도 다른 쪽 공개 주소에는 아무 영향이 없다.

## 6. 배포 후 검증

Vercel이 발급한 주소(예: `https://<project>.vercel.app`)에 대해 `docs/DEPLOY-TO-SITES.md`의 §3과 동일한 방식으로 확인한다.

```sh
curl -i "https://<project>.vercel.app/api/trains/status"
curl -i "https://<project>.vercel.app/api/trains/stations?mode=live"
curl -i "https://<project>.vercel.app/api/trains/stations?mode=demo"
```

키 미등록 시 `stations?mode=live`는 503(`NOT_CONFIGURED`)이 정상이며, 키 등록 후에는 200과 공식 역 목록이 와야 한다. 이 세션은 Vercel에 실제 배포할 계정·권한이 없어 위 curl은 배포 담당자가 직접 실행해야 한다.
