# Play 배포·이의신청 준비 자료 (초안, 미제출)

**아무것도 제출하지 않았습니다.** 이 문서는 정과장님이 검토하고 수정한 뒤에
쓰실 초안입니다. 제가 계정을 만들거나 양식을 보내지 않았습니다.

## 1. 역할 구분

### 제가 처리한 것 / 처리할 수 있는 것

| 항목 | 상태 |
|---|---|
| `android:isAccessibilityTool="false"` 명시 | 완료 (실제 APK 에서 확인) |
| 쓰지 않는 `flagReportViewIds` 요청 제거 | 완료 |
| debuggable 이 아닌 release 빌드 타입 추가 | 완료 |
| CI 가 release APK 를 빌드하고, Secret 이 있으면 서명 | 완료 |
| 실제 APK 의 merged manifest·권한·서명·SDK 검사 | 완료 |
| 아래 §3~§5 문안 작성 | 완료(초안) |
| 개인정보처리방침 문안 | 기존 웹 문서를 Android 용으로 다듬어 제공 가능 |

### 정과장님만 할 수 있는 것

| 항목 | 비용·요건 | 비고 |
|---|---|---|
| Google Play Console 개발자 계정 생성 | 등록비 1회 25 USD, 신원 확인 | **서명 Secret 과 별개 사안**(§8). 지금 필요하지 않습니다 |
| JDK/keytool 확인 → 키스토어 생성 → 백업 → Secret 4개 등록 | **없음(무료)** | §2 의 2-1 ~ 2-5 단계. **키 파일과 비밀번호는 제게 주지 마십시오** |
| 접근성 API 사용 선언 양식 제출 | 없음 | Play Console 내 양식. §3 문안 사용 |
| 이의신청 제출 | 없음 | §5 문안 사용 |
| Play 프로텍트 차단 화면의 **버튼 구성 확인** | 없음 | §6. 이것이 다음 판단을 가릅니다 |

## 2. 서명 키 준비 — Windows 실행 순서

Android Studio 는 필요 없습니다. **JDK 에 포함된 `keytool` 하나만** 쓰면
됩니다. 아래를 순서대로 하십시오.

> **채팅으로 키 파일이나 비밀번호를 보내지 마십시오.** 저는 요구하지
> 않습니다. 저장소·로그·CI artifact 에도 들어가지 않습니다.

### 2-1단계. keytool 이 있는지 확인

PowerShell 을 엽니다(시작 → `powershell` 입력 → Enter).

```powershell
keytool -help
```

| 결과 | 다음 할 일 |
|---|---|
| 사용법이 길게 출력됨 | **2-2단계로** 넘어가십시오 |
| `'keytool'은(는) 내부 또는 외부 명령...` | JDK 가 없거나 PATH 에 없습니다. 아래를 이어서 하십시오 |

JDK 가 PATH 에 없을 때, 먼저 설치돼 있는지 찾습니다.

```powershell
Get-ChildItem "C:\Program Files\Java","C:\Program Files\Eclipse Adoptium","$env:LOCALAPPDATA\Programs" -Filter keytool.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 5 FullName
```

- **경로가 나오면** 그 경로를 그대로 써서 2-2단계를 진행하십시오.
  예: `& "C:\Program Files\Java\jdk-21\bin\keytool.exe" -help`
- **아무것도 안 나오면** JDK 를 설치해야 합니다. 둘 중 하나를 쓰십시오.

```powershell
# winget 이 있으면 (Windows 10 1809+ 는 보통 있습니다)
winget install EclipseAdoptium.Temurin.21.JDK
```

winget 이 없으면 `https://adoptium.net/` 에서 **Temurin 21 (JDK, Windows
x64, .msi)** 를 받아 설치하십시오. 설치 후 PowerShell 을 **새로 열어**
`keytool -help` 를 다시 확인하십시오.

### 2-2단계. 키스토어 만들기

키를 보관할 폴더를 만들고 거기서 실행합니다. **저장소 폴더 안에 만들지
마십시오** — 실수로 커밋될 수 있습니다.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\RailFlowKeys" | Out-Null
Set-Location "$env:USERPROFILE\RailFlowKeys"

keytool -genkeypair -v `
  -keystore railflow-upload.jks `
  -storetype PKCS12 `
  -keyalg RSA -keysize 4096 -validity 10000 `
  -alias railflow-upload
```

물어보는 것에 이렇게 답하십시오.

| 질문 | 입력 |
|---|---|
| 키 저장소 비밀번호 | **직접 정하십시오.** 6자 이상. 이것이 `RAILFLOW_KEYSTORE_PASSWORD` |
| 새 비밀번호 다시 입력 | 같은 값 |
| 이름과 성(CN) | 아무 값이나 가능. 예: `RailFlow` |
| 조직 단위·조직·구/군·시·도·국가 코드 | 비워도 됩니다(Enter). 국가 코드만 넣으려면 `KR` |
| `맞습니까?` | `y` 입력 후 Enter |

`PKCS12` 형식을 쓰면 키 비밀번호가 키스토어 비밀번호와 같아지므로
`RAILFLOW_KEY_PASSWORD` 에도 **같은 값**을 넣습니다. (JKS 형식은 둘을
따로 묻는데, PKCS12 가 현재 권장 형식이고 관리가 단순합니다.)

만들어졌는지 확인합니다.

```powershell
keytool -list -v -keystore railflow-upload.jks -storetype PKCS12
```

별칭 `railflow-upload` 와 인증서 지문(SHA-256)이 보이면 됩니다.

### 2-3단계. 백업

**이 파일을 잃으면 같은 서명으로 업데이트할 수 없습니다.** 앱을 지우고
다시 설치해야 합니다.

- `railflow-upload.jks` 를 **최소 두 곳**에 보관하십시오(예: 외장 USB,
  개인 클라우드 드라이브의 비공개 폴더).
- 비밀번호는 파일과 **같은 곳에 두지 마십시오.** 비밀번호 관리자나 종이
  메모에 따로 두십시오.
- 저장소 폴더(`RailFlow` 작업 폴더) 안에는 두지 마십시오.

### 2-4단계. base64 로 변환

GitHub Secret 은 텍스트만 담으므로 파일을 base64 문자열로 바꿉니다.

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\RailFlowKeys\railflow-upload.jks"))
$b64 | Set-Clipboard
Write-Host "길이: $($b64.Length) 자 — 클립보드에 복사했습니다"
```

길이가 수천 자 나오는 것이 정상입니다. 화면에 출력하지 않고 클립보드로만
옮겼습니다.

### 2-5단계. GitHub Secret 4개 등록

브라우저에서 아래 경로로 갑니다.

```
https://github.com/dhmailing/RailFlow/settings/secrets/actions
```

(또는 저장소 → **Settings** → 왼쪽 메뉴 **Secrets and variables** →
**Actions** → **Repository secrets** 의 **New repository secret**)

네 개를 각각 등록합니다. **이름을 정확히 그대로** 쓰십시오.

| # | Name | Secret 값 |
|---|---|---|
| 1 | `RAILFLOW_KEYSTORE_BASE64` | 2-4단계에서 복사한 base64 문자열 (Ctrl+V) |
| 2 | `RAILFLOW_KEYSTORE_PASSWORD` | 2-2단계에서 정한 키 저장소 비밀번호 |
| 3 | `RAILFLOW_KEY_ALIAS` | `railflow-upload` |
| 4 | `RAILFLOW_KEY_PASSWORD` | 2번과 같은 값 (PKCS12 이므로) |

등록 후 목록에 이름 4개가 보이면 됩니다. GitHub 은 값을 다시 보여주지
않습니다(정상입니다).

### 현재 상태 (2026-10-11 CI 확인)

| Secret | 등록 여부 |
|---|---|
| `RAILFLOW_KEYSTORE_BASE64` | **미등록** |
| `RAILFLOW_KEYSTORE_PASSWORD` | **미등록** |
| `RAILFLOW_KEY_ALIAS` | **미등록** |
| `RAILFLOW_KEY_PASSWORD` | **미등록** |

그래서 release APK 는 서명되지 않았고 **설치할 수 없다.** CI 가 파일명에
`-UNSIGNED-DO-NOT-INSTALL` 을 붙여 올린다. 서명 경로는 Secret 하나만
기다리는 상태로 끝까지 준비돼 있다.

### 2-6단계. 알려주시면 제가 할 일

"Secret 4개 등록했다"고만 알려 주십시오. **값은 보내지 마십시오.** 제가
CI 를 실행해 서명된 release APK 를 만들고, 다음을 확인해 보고합니다.

- `apksigner verify` 통과 여부
- 인증서 DN 과 SHA-256 지문
- `application-debuggable` 부재
- 실제 권한 목록과 접근성 설정 값
- APK 파일명과 SHA-256

CI 는 Secret 의 **존재 여부만** 보고하고 값을 출력하지 않습니다. 키스토어
파일은 CI 작업 폴더에서만 복원되며 artifact 에 포함되지 않습니다.

## 3. 접근성 API 사용 선언 문안 (초안)

Play Console 의 접근성 서비스 사용 선언 양식에 쓸 문안입니다. **과장하지
않았습니다.** 장애인 지원 도구라고 쓰지 않았습니다.

> **앱이 접근성 API 를 사용하는 이유**
>
> RailFlow 는 사용자가 직접 지정한 철도 예매 앱의 **검색 결과 화면**에서
> 열차번호, 출발·도착 시각, 좌석 표시 문구만 **읽습니다.** 사용자는 이
> 정보를 바탕으로 원하는 열차의 좌석 상태를 한곳에서 확인합니다.
>
> **왜 다른 API 로는 안 되는가**
>
> 해당 철도 사업자가 공개·승인한 잔여좌석 조회 API 를 확인하지 못했습니다.
> 공공데이터포털의 열차운행정보 API 는 시간표만 제공하고 좌석 정보를
> 포함하지 않습니다. 따라서 사용자가 자신의 화면에서 보고 있는 정보를
> 읽는 것 외의 방법이 없습니다.
>
> **접근성 API 로 하지 않는 것**
>
> - 화면을 누르거나 입력하거나 스와이프하지 않습니다. `performAction`,
>   `performGlobalAction`, `dispatchGesture` 를 호출하는 코드가 없고,
>   서비스 설정에 `canPerformGestures` 가 없습니다.
> - 예약이나 결제를 수행하지 않습니다.
> - 로그인·인증·결제·개인정보 화면은 처리하지 않습니다. 비밀번호 필드나
>   입력창이 있는 화면, 로그인·결제 관련 단어가 보이는 화면은 노드를 읽지
>   않고 건너뜁니다.
> - 사용자가 지정하지 않은 앱의 화면은 처리하지 않습니다. 대상 앱 목록이
>   비어 있으면 어떤 화면도 읽지 않습니다.
> - 화면 전체 원문이나 스크린샷을 저장하지 않고 외부로 전송하지 않습니다.
>   읽은 값은 앱 메모리에서 처리해 화면에 표시만 합니다.
> - 반복 조회(폴링)를 하지 않습니다. 사용자가 시작한 세션 동안 화면이 바뀔
>   때 들어오는 사건만 처리하고, 사용자가 중단하거나 권한을 끄면 즉시
>   멈춥니다.
>
> **수집·전송하는 데이터**
>
> 없습니다. 이 앱에는 `INTERNET` 권한이 없습니다. 네트워크로 데이터를 보낼
> 수 없습니다. 조건과 후보 열차는 기기 안에만 저장되며 사용자가 앱에서
> 삭제할 수 있습니다. 철도 계정 비밀번호·OTP·쿠키·세션을 입력받는 화면이
> 없고 저장 형식에 해당 필드가 없습니다.
>
> **`isAccessibilityTool`**
>
> `false` 로 선언했습니다. 이 앱은 장애인 지원 도구가 아닙니다.

## 4. 데이터 안전(Data safety) 답변 초안

| 질문 | 답변 |
|---|---|
| 데이터를 수집하거나 공유합니까? | 아니요 |
| 데이터를 암호화해 전송합니까? | 해당 없음 — 전송하지 않습니다(`INTERNET` 권한 없음) |
| 사용자가 데이터 삭제를 요청할 수 있습니까? | 예 — 앱 안에서 직접 삭제합니다(마이페이지 → 로컬 데이터 삭제) |
| 기기에 저장하는 데이터 | 출발·도착역, 날짜, 희망 시간 범위, 인원, 좌석등급, 후보 열차 목록, 사용자가 지정한 대상 앱 패키지명 |
| 민감 정보 저장 | 없음 |

## 5. 이의신청 문안 (초안, 미제출)

Play 프로텍트 차단에 대한 이의신청에 쓸 문안입니다. **차단이 유지되는 것이
정당할 수도 있습니다.** 아래는 사실 관계를 전달하는 문안이며, 결과를 보장
하지 않습니다.

> 이 앱(`com.railflow.android`)은 사용자가 직접 활성화하는 **읽기 전용**
> 접근성 서비스를 사용합니다. 차단 안내의 "민감한 정보 액세스" 는 이
> 접근성 서비스를 가리키는 것으로 이해합니다.
>
> 확인을 요청드리는 사실은 다음과 같습니다.
>
> 1. 이 앱은 화면을 **조작하지 않습니다.** 서비스 설정에
>    `canPerformGestures`·`canRequestFilterKeyEvents`·
>    `canRequestTouchExplorationMode` 가 없고, 그보다 중요하게 **코드에
>    조작 API 호출이 없습니다** — `performAction`, `performGlobalAction`,
>    `dispatchGesture`, `takeScreenshot`, `GLOBAL_ACTION_*`,
>    `ACTION_CLICK`, `ACTION_SET_TEXT`, `ACTION_SCROLL_*` 중 어느 것도
>    호출하지 않습니다. CI 가 매 빌드에서 이를 검사해 위반 시 빌드를
>    실패시킵니다. 서비스가 쓰는 `AccessibilityNodeInfo` 멤버는
>    `childCount`, `getChild`, `text`, `contentDescription`, `className`,
>    `isPassword`, `isEditable` 뿐입니다.
> 2. `INTERNET` 권한이 없어 **직접 네트워크 통신을 할 수 없습니다.**
>    네트워크·파일 쓰기·클립보드·공유 Intent·로그 출력·ContentProvider
>    경로가 코드에 없음을 확인했습니다. 다만 읽은 열차·좌석 요약이
>    **시스템 알림 본문**에 들어가므로, 잠금화면이나 사용자가 별도로 알림
>    접근 권한을 준 다른 앱을 통해 보일 수 있습니다. 자격증명·세션·화면
>    원문은 알림에 들어가지 않습니다.
> 3. 로그인·인증·결제·개인정보 화면은 처리하지 않도록 코드에 차단 규칙이
>    있습니다.
> 4. 사용자가 지정하지 않은 앱의 화면은 처리하지 않습니다.
> 5. `android:isAccessibilityTool="false"` 로 정직하게 선언했습니다.
> 6. 자격증명을 입력받는 화면이 없고 저장하지 않습니다.
>
> 소스는 공개 저장소에서 확인할 수 있습니다(해당 PR 링크). 추가로 필요한
> 자료가 있으면 알려 주십시오.

## 6. 차단 화면의 버튼 — 확인됨

사용자 캡처에 **`확인` 버튼 하나만** 있었습니다. "무시하고 설치" 류의
선택지가 없었으므로 **하드 차단**입니다.

여기서 바로 "Play 배포가 유일한 경로"라고 결론 내리지는 않습니다. 남은
경로가 적어도 셋입니다.

| 경로 | 비용·요건 | 확인된 정도 |
|---|---|---|
| 이의신청 | 무료 | 공식 주소 존재(§7). 처리 기준은 제가 원문을 못 읽어 미확인 |
| Play Console 내부 테스트 트랙 | 등록비 1회 25 USD | 앱이 Play 를 통해 배포되므로 출처 문제가 달라짐. 접근성 선언 심사를 통과해야 함 |
| 개발자 검증 제한 배포 계정 | 신원증명·등록비 없이 20대 기기 | `developer.android.com/developer-verification` 에서 확인. 다만 이 제도의 보호 시행은 2026-09-30 특정 4개국부터이며 한국은 2027년 이후여서, **지금 이 차단에 효과가 있는지는 미확인** |

어느 경로가 통할지 저는 모릅니다. 먼저 §2 로 서명된 release APK 를 만들어
**같은 코드가 서명·비-debuggable 상태에서도 차단되는지** 확인하는 것이
비용이 들지 않는 다음 단계입니다.

## 7. 공식 원문 — 주소와 열람 주체

| 용도 | 주소 |
|---|---|
| 차단 유형 개발자 안내 | `https://developers.google.com/android/play-protect/warning-dev-guidance` |
| 이의신청 | `https://support.google.com/googleplay/android-developer/contact/protectappeals` |

**정과장님 환경에서는 열람이 확인됐습니다. 제 작업 환경에서는 두 주소 모두
프록시가 차단해(CONNECT 403) 열지 못했습니다. 저는 이 문서들의 원문을 읽지
않았습니다.**

그래서 §3~§5 문안은 **원문이 요구하는 항목에 맞춘 것이 아니라 이 앱의 사실
관계를 정리한 것**입니다. 두 문서를 열어 아래를 알려 주시면 문안을 그에
맞춰 고치겠습니다.

- 차단 유형의 분류명과, Google 이 **명시한** 개발자 조치 항목
- 이의신청 양식의 **필수 입력란** 목록(앱 이름·패키지명·APK 해시·소스
  링크·연락처 등 무엇을 요구하는지)
- VirusTotal 등 외부 스캔 결과 제출을 요구하는지 여부

## 8. 준비와 실행의 구분

| 항목 | 상태 |
|---|---|
| 서명 Secret 설정 | **제가 CI 쪽을 준비 완료.** 등록은 정과장님 실행 |
| 서명된 release APK 생성 | Secret 등록 후 CI 가 자동 수행 |
| 이의신청 문안 | **초안 준비 완료.** 제출은 정과장님 실행 |
| 데이터 안전 답변 | **초안 준비 완료.** 입력은 정과장님 실행 |
| VirusTotal 업로드 | **준비도 실행도 하지 않았습니다.** APK 를 외부 스캔 서비스에 올리면 그 파일이 외부에 보관·공유됩니다. 이의신청에 필요하다고 확인되면 그때 정과장님이 판단해 올리시고, 제가 올리지 않습니다 |
| 유료 Play 계정 등록 | **하지 않았습니다.** 등록비 1회 25 USD 와 신원 확인이 필요하며, **서명 Secret 설정과는 완전히 별개입니다.** Secret 만 등록해도 서명된 APK 는 만들어집니다 |

### 서명 Secret 과 유료 Play 계정은 별개다

혼동하기 쉬운 부분이라 분리해 적습니다.

| | 서명 Secret 설정 | 유료 Play 계정 |
|---|---|---|
| 목적 | 설치 가능한 release APK 를 만든다 | Play 스토어를 통해 배포한다 |
| 비용 | 없음 | 등록비 1회 25 USD |
| 신원 확인 | 없음 | 필요 |
| 지금 필요한가 | **예** — 이것 없이는 설치 시험 자체가 불가능 | 아니오 — 나중 판단 사항 |
| 무엇을 만드나 | 자체 서명 APK(사이드로드용) | Play 배포본 |

자체 서명 키로 만든 APK 는 Play 에 올릴 수 없는 것이 아니고, Play 에
올릴 때는 Play 앱 서명이 별도로 붙습니다. 지금 만드는 키는 **사이드로드
설치 시험용**입니다.
