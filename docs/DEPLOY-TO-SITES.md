# RailFlow v0.3 → ChatGPT Sites 배포 가이드

이 문서는 GitHub 저장소(`dhmailing/RailFlow`, `main` 브랜치)에 반영된 v0.3 소스를 실제 공개 주소(https://railflow.dhmailing0310.chatgpt.site)에 배포하기 위한 절차다. **GitHub에 소스가 있는 것과 이 주소에 배포된 것은 별개다** — `main`을 아무리 갱신해도 Sites 쪽에서 실제로 가져가 배포하지 않으면 공개 주소는 바뀌지 않는다.

## 0. 전제

- 배포 대상 커밋: `main` 브랜치 `f5d39d9`(PR #1 병합 커밋) 이후 최신.
- 이 저장소(GitHub)는 Sites의 관리 Git과 별도다. Sites 쪽 배포 담당(Codex)이 이 커밋의 변경 내용을 Sites 프로젝트(`appgprj_6aad4d8939088191a3a5b4c5f6a5768c`, `.openai/hosting.json` 참고)에 반영해야 한다.
- 로컬(Claude Code 세션)에는 ChatGPT Sites에 대한 배포 권한/도구가 없다. 이 문서 작성 시점까지 공개 주소는 v0.2를 실행 중이며, `/api/trains/stations` 라우트가 없어 404를 반환한다(`docs/V0.3-validation.md`의 "공개 주소 404 장애 진단" 참고).

## 1. 배포 전 준비 (Codex 또는 배포 담당자)

1. 이 커밋 기준으로 Sites 프로젝트에 소스를 반영한다.
2. 새 TAGO 인증키를 [공공데이터포털](https://www.data.go.kr/data/15098552/openapi.do)에서 발급하거나, 기존 노출된 키를 폐기하고 재발급한다. **노출된 이전 키는 재사용하지 않는다.**
3. 새 키를 **Sites 호스팅의 Secret 등록 화면**에 다음 이름으로 등록한다.
   ```
   변수명: DATA_GO_KR_SERVICE_KEY
   값: (새로 발급한 키. 채팅에는 절대 입력하지 않는다)
   ```
   `NEXT_PUBLIC_` 접두사를 붙이지 않는다 — 붙이면 브라우저 번들에 노출된다. 코드는 서버 전용 환경변수로만 이 값을 읽는다(`lib/rail/tago-provider.ts`, `app/api/trains/*/route.ts`).
4. Sites 프로젝트 빌드 절차를 실행한다(`pnpm install --frozen-lockfile` → `pnpm build`). 일반 Next.js 배포 절차를 임의로 적용하지 않는다 — 이 프로젝트는 `build/sites-vite-plugin.ts`와 `.openai/hosting.json`을 사용하는 Cloudflare Workers 대상 빌드다.

## 2. 배포

- Sites 저장된 버전으로 배포를 진행한다. 새 프로젝트를 만들거나 `.openai/hosting.json`의 `project_id`를 바꾸지 않는다.
- 새 호스팅 서비스로 이전하지 않는다. 기존 주소(https://railflow.dhmailing0310.chatgpt.site)를 그대로 유지한다.

## 3. 배포 후 검증 (필수, 이 순서로)

아래 4개 호출을 **실제 공개 주소**에 대해 직접 실행한다. 이 세션은 해당 도메인에 접근이 차단되어 있어 이 검증을 대신 수행할 수 없다 — 배포 담당자가 직접 실행해야 한다.

```sh
curl -i "https://railflow.dhmailing0310.chatgpt.site/api/trains/status"
curl -i "https://railflow.dhmailing0310.chatgpt.site/api/trains/stations?mode=live"
curl -i "https://railflow.dhmailing0310.chatgpt.site/api/trains/stations?mode=demo"
```

기대 결과:

| 호출 | 배포 전(v0.2, 현재) | 배포 성공 + 키 미등록 | 배포 성공 + 키 등록 |
|---|---|---|---|
| `/api/trains/status` | 200 | 200, `configured:false` | 200, `configured:true` |
| `/api/trains/stations?mode=live` | **404** | **503** `NOT_CONFIGURED` | **200**, 공식 역 목록 |
| `/api/trains/stations?mode=demo` | (v0.2에는 이 라우트 자체가 없을 수 있음) | 200, 데모 6개 역 | 200, 데모 6개 역 |

**배포가 성공했다는 최소 증거는 `stations?mode=live`가 더 이상 404가 아닌 것이다.** 404가 계속되면 아직 v0.2가 실행 중이라는 뜻이므로 배포가 반영되지 않은 것이다.

키를 등록했다면 이어서 실제 조회를 확인한다.

```sh
curl -i "https://railflow.dhmailing0310.chatgpt.site/api/trains/search?departure=%EB%8F%99%ED%83%84&arrival=%EC%9A%B8%EC%82%B0(%ED%86%B5%EB%8F%84%EC%82%AC)&date=YYYY-MM-DD&departAfter=00:00&passengers=1&departureId=<stations 응답의 실제 id>&arrivalId=<stations 응답의 실제 id>&mode=live"
```

`departureId`/`arrivalId`는 반드시 직전 `stations?mode=live` 응답에서 받은 실제 값을 사용한다(임의로 만든 값은 400 처리됨). 200과 함께 열차 목록이 오면 실제 TAGO 연동 성공이다. 이때도 **좌석 잔여·자동예약이 된 것은 아니며**, 시간표·운임 조회만 확인된 것이다.

## 4. 문제 발생 시

- 위 검증에서 여전히 404: Sites 쪽에 소스가 반영되지 않았거나 배포가 완료되지 않은 것. 1~2단계를 다시 확인한다.
- `stations?mode=live`가 502/`STATIONS_FAILED`: 키는 설정됐지만 TAGO 쪽 인증/역 코드 해석에 실패한 것. `docs/V0.3-validation.md`의 cityCode 교차 확인 내용을 참고해 실제 응답 본문(`nodename`/`nodeid`)을 로그로 확인한다(키 값 자체는 로그에 남기지 않는다).
- 롤백: 기존 저장 버전 2로 되돌린다. 롤백해도 이미 폐기한 옛 키는 복원되지 않으므로, 롤백 후 다시 진행할 때도 새 Secret을 그대로 사용한다.

## 5. 배포 후 남은 항목 (이 문서 범위 밖)

- iPad Safari 실기기 검증(`docs/V0.3-validation.md` 참고 체크리스트).
- v0.2 대비 실제 성능 비교(v0.2 소스 필요).
- Android 앱 작업(별도 브랜치에서 진행 예정, 이 배포와 무관).
