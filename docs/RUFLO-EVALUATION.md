# Ruflo 시험 설치 평가 메모

작성일: 2026-10-02. 브랜치: `chore/ruflo-evaluation` (origin/main `274f434` 기준).

**이 문서는 도구 평가 기록이다.** RailFlow 제품 기능과 무관하고, 실제 좌석
조회·예약과도 아무 관계가 없다.

---

## 결론 — 평가 목적은 달성됐다

| 확인 항목 | 결과 |
|---|---|
| 설치 가능 여부 | **가능.** `npx -y ruflo@latest init --minimal --no-global --no-signup --no-skills-sh` 가 비대화형으로 완주했다 |
| MCP 설정 생성 | **생성됨.** `.mcp.json` 에 `claude-flow` 서버 1개 |
| MCP 연결 가능성 | **확인됨.** stdio 로 `initialize` 를 보내 응답을 받았다 (`serverInfo: {name:"ruflo", version:"3.0.0"}`). 이후 Claude Code 세션이 실제로 서버를 붙이고 약 355개 도구를 등록하는 것까지 관찰했다 |
| 코드 오염 | **없음.** 저장소 추적 파일 변경은 `.gitignore` +8줄뿐 |

**Ruflo 를 실제로 쓸지는 완전히 별도 결정으로 미룬다.** 이 메모는 "설치가
되는가"에만 답한다. "써야 하는가"에는 답하지 않는다.

---

## 설치가 만든 것

생성 13개 파일 / 디렉터리 12개. 수정 1개(`.gitignore`, append).

- `.mcp.json` — `claude-flow` MCP 서버 (`npx -y ruflo@latest mcp start`)
- `.claude/settings.json` — 권한·모델·env·claudeFlow 설정
- `.claude/skills/` × 8 — hooks-automation, pair-programming, skill-builder,
  sparc-methodology, stream-chain, swarm-advanced, swarm-orchestration,
  verification-quality
- `.claude-flow/{config.yaml, CAPABILITIES.md, .gitignore}` + 빈 런타임 디렉터리
- `.claude/{agents,commands,helpers}` 는 **빈 디렉터리** (`--minimal` 이 해당
  컴포넌트를 만들지 않는다 — 정상 동작)

### 보호 대상은 전부 무사하다

| 대상 | 결과 |
|---|---|
| `CLAUDE.md` | md5 `6d6b167cdcb21fec6f09cb14ea5c7e64` — **실행 전후 동일.** `--force` 를 쓰지 않아 skip 됐다 |
| `package.json` | md5 `53cd1bae97512b017441cd93c359e334` — 동일 |
| `app/`, `lib/`, `components/`, `tests/` | 무변경 |
| `~/.claude/CLAUDE.md` (전역) | **생성조차 되지 않음.** `--no-global` 동작 확인 |
| PR #19 (`claude/wonderful-mccarthy-611sg5`) | `df07138` 그대로. local·remote 일치 |

회귀 검증: `tsc` 통과 · `eslint` 통과 · `verify-autobook` 44/44 PASS ·
`verify-seat-watch` PASS · `verify-reservation` PASS · `test:autobook`
64 pass / 1 skipped(PostgreSQL 통합 테스트 NOT RUN).

---

## 현재 상태 — 무력화해 두었다

로드 경로에서 빼냈다. 내용은 보존했다.

| 원래 경로 | 현재 경로 |
|---|---|
| `.mcp.json` | `.mcp.json.ruflo-eval` |
| `.claude/` | `.claude.ruflo-eval/` |

`.claude-flow/` 는 그대로 두었다 — Claude Code 가 읽는 경로가 아니다.

이렇게 둔 이유는 §아래의 권한 범위 때문이다. 다시 켜려면 두 경로를 원래
이름으로 되돌리면 된다.

---

## 보류한 이유 — 권한 범위가 과하다

`.claude/settings.json` 의 `permissions.allow` 에 다음이 있었다.

```
mcp__claude-flow__*
```

와일드카드 한 줄이 **약 355개 도구 전부를 프롬프트 없이 사전 승인한다.**
그 안에 포함된 것들:

| 분류 | 예 |
|---|---|
| 임의 셸 실행 | `terminal_execute`, `terminal_create` |
| 임의 외부 요청 | `http_fetch` |
| 브라우저 조작·쿠키 | `browser_act`, `browser_cookie_use`, `browser_session_replay` |
| 제3자 코드 다운로드 | `transfer_store-download`, `transfer_ipfs-resolve` |
| 외부 피어 게시·동기화 | `federation_bbs_publish`, `x_federation_publish` |
| 자율 모드 | `autopilot_enable` |
| 파괴적 | `system_reset` |

**브라우저 조작·쿠키 계열은 이 저장소의 지침과 정면으로 충돌한다.**
`CLAUDE.md` 「하지 않는 것」이 "공식 예매 화면을 브라우저로 조작하는 방식"과
쿠키 저장을 금지하고, `docs/adr/0003-abandon-browser-agent.md` 가 그 Agent 를
폐기했다. `scripts/verify-autobook.cjs` 는 `lib/autobook` 소스만 검사하므로
이 경로를 잡지 못한다(실제로 44/44 PASS 했다).

그 밖에 확인된 설정 결함:

- `statusLine` 이 `.claude/helpers/statusline.cjs` 를 가리키지만 `--minimal`
  은 그 파일을 만들지 않는다. 프로젝트·홈 양쪽에 없어 실행되면 실패한다.
- `adr.directory: "/docs/adr"`, `ddd.directory: "/docs/ddd"` — 선행 슬래시
  절대경로. 이 저장소의 실제 경로는 상대 `docs/adr/` 이고 `adr.autoGenerate`
  가 `true` 다.
- `model: "claude-sonnet-5"` 와 `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"`
  — 도구 설치가 세션 모델과 실험 기능까지 바꾼다.
- `command: npx -y ruflo@latest` — 기동마다 최신 버전을 내려받는다. 재현성이
  없고, 패키지 자체 주석이 콜드 캐시에서 ONNX 모델 때문에 60초를 넘겨 MCP
  stdio 30초 창에서 SIGTERM 날 수 있다고 적고 있다.

---

## 쓰기로 결정할 경우에만 할 일

이 목록은 **결정이 난 뒤에** 착수한다. 지금은 하지 않는다.

1. 버전 핀 고정 — `ruflo@latest` → `ruflo@3.50.0`
2. `mcp__claude-flow__*` 와일드카드 제거 후, 실제로 쓸 도구만 명시적 allow
3. 명시적 deny 추가 — `terminal_execute`, `http_fetch`, `browser_*`,
   `federation_*`, `autopilot_*`
4. `model`·`env` 오버라이드 제거
5. 깨진 `statusLine` 제거(또는 helpers 설치)와 절대경로(`/docs/adr`,
   `/docs/ddd`) 수정

---

## 확인된 사실과 미확인 사항

| 항목 | 등급 |
|---|---|
| 패키지 실존, MIT, `ruvnet/claude-flow` 리브랜딩 | 확인됨 (npm 레지스트리 조회) |
| 비대화형 init 완주, 생성 파일 목록 | 확인됨 (직접 실행) |
| MCP `initialize` 응답 | 확인됨 (직접 stdio 요청) |
| MCP `tools/list` 응답 | **미확인** — smoke test 창(150초) 안에 응답하지 않았다 |
| 세션 자동 로드 | 확인됨 — 스킬 8개와 도구 약 355개가 실제로 등록됐다 |
| 등록된 도구의 실제 동작 | **미확인** — 한 개도 호출하지 않았다 |
