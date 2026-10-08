# Play 프로텍트 차단 조사

## 1. 실기기 설치 결과: **BLOCKED**

| 항목 | 값 |
|---|---|
| 기기 | 삼성 갤럭시 Z Flip6 |
| APK | PR #20, 커밋 `f19f554`, 디버그 빌드 |
| APK SHA-256 | `6f40e1df050600520b62adbd81b5ceaf46b595bb281a7f1e55694d9dfa1e83d2` |
| 결과 | **설치 차단 (BLOCKED)** |
| 차단 주체 | Google Play 프로텍트 |
| 표시 문구 | "기기 보호를 위해 앱 차단됨" / "이 앱에서 민감한 정보에 대한 액세스 권한을 요청할 수 있습니다. 이로 인해 신원 도용이나 금융 사기 위험이 높아질 수 있습니다." |
| 보고자 | 사용자 실기기 관찰 |

**이전 보고 정정:** CI 빌드 성공을 설치 가능으로 읽지 않았고 실기기 검증은
NOT RUN 으로 적어 두었다. 이제 그 항목은 NOT RUN 이 아니라 **BLOCKED** 다.

## 2. 조사 범위

- 소스 manifest 가 아니라 **실제 APK 의 merged manifest**
- APK 안의 접근성 서비스 설정(`res/xml/rail_observer_config.xml`)
- APK 에 포함된 SDK·라이브러리
- APK 서명 정보
- Google 공식 문서와의 대조

CI 의 `APK 검사` 단계가 실제 APK 를 읽어 결과를 annotation 과
`railflow-apk-inspection` artifact 로 남긴다.

## 3. 실제 APK 검사 결과 (확인된 사실)

CI 가 **만들어진 APK 자체**를 읽었다. 소스 manifest 추측이 아니다. 전체
출력은 `railflow-apk-inspection` artifact 에 있다.
도구: `apkanalyzer manifest print/permissions`, `aapt2 dump badging`,
`aapt2 dump xmltree`, `apksigner verify --print-certs`, `gradlew :app:dependencies`.

### 3-1. 패키지와 SDK

| 항목 | debug APK | release APK |
|---|---|---|
| 패키지 | `com.railflow.android.debug` | `com.railflow.android` |
| versionName | `0.1.0-readonly-debug` | `0.1.0-readonly` |
| targetSdkVersion | 35 | 35 |
| compileSdkVersion | 35 | 35 |
| `application-debuggable` | **있음 (= true)** | **없음 (= false)** |

### 3-2. 선언된 권한 — 실제 APK 기준

debug APK 의 `uses-permission` 은 **2줄**이다.

| 권한 | 출처 |
|---|---|
| `android.permission.POST_NOTIFICATIONS` | 우리가 선언 |
| `com.railflow.android.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | **androidx/AGP 가 자동 주입**한 signature 수준 커스텀 권한. 앱 내부 브로드캐스트를 외부에 노출하지 않기 위한 것이며 사용자에게 노출되는 권한이 아니다 |

**없다고 확인된 권한** (실제 APK 에서 검사):
`INTERNET`, `SYSTEM_ALERT_WINDOW`, `READ_SMS`, `RECEIVE_SMS`,
`BIND_NOTIFICATION_LISTENER_SERVICE`, `MANAGE_EXTERNAL_STORAGE`,
`READ_CONTACTS`.

`INTERNET` 이 없다는 것은 중요하다. **이 앱은 읽은 값을 외부로 보낼 수
없다.** 코드 약속이 아니라 플랫폼이 강제하는 사실이다.

### 3-3. 접근성 서비스 선언 — merged manifest 실제 값

```
android:name="com.railflow.observer.RailObserverService"
android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
android:exported="true"
```

`exported="true"` 는 접근성 서비스에 **필수**다. 시스템이 바인드해야 하고,
`BIND_ACCESSIBILITY_SERVICE` 권한이 시스템만 바인드할 수 있게 제한한다.

APK 안의 `res/xml/rail_observer_config.xml` 실제 값:

| 속성 | 차단된 APK (`f19f554`) | 현재 |
|---|---|---|
| `isAccessibilityTool` | **속성 자체가 없었음** (기본값 false 로 동작) | **`false` 명시** |
| `canRetrieveWindowContent` | true | true |
| `accessibilityEventTypes` | `0x820` (WindowStateChanged\|WindowContentChanged) | 같음 |
| `accessibilityFeedbackType` | `0x10` (feedbackGeneric) | 같음 |
| `accessibilityFlags` | `0x10` (flagReportViewIds) | **제거** (코드가 뷰 ID 를 읽지 않음) |
| `notificationTimeout` | 300 | 300 |
| `canPerformGestures` | 없음 | 없음 |
| `canRequestFilterKeyEvents` | 없음 | 없음 |
| `canRequestTouchExplorationMode` | 없음 | 없음 |

즉 **차단된 APK 에도 화면을 조작할 수단이 없었다.** 쓰기 관련 플래그가
하나도 선언돼 있지 않다.

### 3-4. 서명

| 항목 | debug APK | release APK |
|---|---|---|
| 서명자 수 | 1 | — |
| v1 (JAR) | false | — |
| v2 | **true** | — |
| v3 / v3.1 / v3.2 / v4 | false | — |
| 검증 결과 | 통과 | **DOES NOT VERIFY (서명되지 않음)** |

debug APK 는 Android SDK 가 자동 생성하는 **디버그 키**로 서명됐다.
release APK 는 서명 Secret 이 아직 등록되지 않아 **서명되지 않았고 설치할 수
없다**(§4-1).

### 3-5. 포함된 SDK

androidx 계열만 들어 있다. 광고·분석·추적·크래시 리포팅 SDK 가 없다.

```
androidx.compose:compose-bom:2024.12.01
androidx.compose.ui:ui / ui-graphics / ui-tooling / ui-tooling-preview  1.7.6
androidx.compose.material3:material3  1.3.1
androidx.activity:activity-compose  1.9.3
androidx.core:core-ktx  1.15.0
androidx.datastore:datastore-preferences  1.1.1
androidx.lifecycle:*  2.8.7
org.jetbrains.kotlinx:kotlinx-serialization-json  1.7.3
org.jetbrains.kotlinx:kotlinx-coroutines-core  1.9.0
```

## 4. 공식 문서와의 대조 — 사실 / 해석 / 추정

### 4-1. 확인된 사실 (이번에 원문을 직접 읽음)

| 근거 | 내용 |
|---|---|
| `developer.android.com/reference/android/R.attr` (API 31) | `isAccessibilityTool` = "접근성 서비스가 **장애인 지원**에 쓰이는지". **기본값 false.** "If this flag is false, system will show a notification after a duration to inform the user about the privacy implications of the service" |
| 같은 문서 (API 34) | `accessibilityDataSensitive` — 뷰가 `isAccessibilityTool=true` 인 서비스만 상호작용하도록 요구할 수 있다. 기본 `auto` 는 시스템이 민감성을 판단 |
| `.../privacy-and-security/risks/android-debuggable` | "Always make sure to set the android:debuggable flag to false when shipping your application" |
| `.../privacy-and-security/risks/test-debug` | 디버그 기능이 남은 빌드를 배포하면 보안 수준이 떨어진다 |
| `developer.android.com/developer-verification` | 개발자 검증 보호는 **2026-09-30** 브라질·인도네시아·싱가포르·태국의 참여 스토어부터, **2027년** 전 세계로 확대. Play Console 이 패키지명을 등록. 학생·교사·취미 개발자를 위한 **제한 배포 계정**은 신원증명·등록비 없이 최대 20대 기기에 공유 가능 |

### 4-2. 원문을 확인하지 못한 것

**Google Play 프로텍트의 이 차단 유형을 설명하는 공식 페이지를 읽지
못했다.** 해당 문서는 `support.google.com`, `play.google.com`,
`developers.google.com` 에 있고 이 개발 환경의 네트워크 정책이 세 호스트
모두를 차단한다(프록시가 CONNECT 에 403). 따라서 아래는 확인할 수 없었다.

- 차단 규칙의 정확한 문구와 트리거 목록
- 이의신청 양식의 정확한 주소와 처리 절차
- 차단 화면이 "무시하고 설치" 를 제공하는 조건

이 항목들은 정과장님이 Windows PC 에서 직접 열어 확인하실 수 있다.

### 4-3. 해석 (사실에서 바로 따라오는 것)

차단 문구는 "민감한 정보에 대한 **액세스 권한을 요청할 수 있습니다**" 라고
말한다. 이 APK 가 선언한 민감 접근은 **접근성 서비스 하나뿐**이다(§3-2).
SMS·알림 읽기·화면 오버레이·화면 캡처·파일 접근 권한이 없고, 인터넷 권한도
없다. 따라서 문구가 가리키는 대상은 접근성 서비스로 좁혀진다.

### 4-4. 추정 (확신도를 붙임)

| # | 추정 | 확신도 | 근거와 한계 |
|---|---|---|---|
| 추정 1 | 차단 트리거는 **접근성 서비스 선언** 자체다 | **높음** | §4-3 의 해석. 다만 Google 의 판정 규칙 원문을 대조하지 못했다 |
| 추정 2 | `debuggable=true` 가 위험도를 높였을 수 있으나 단독 원인은 아니다 | 중간 | 차단 문구가 디버그가 아니라 "접근 권한 요청" 을 말한다. §3-1 에서 debuggable 이 사실로 확인됐으므로 요인 가능성은 실재한다 |
| 추정 3 | `isAccessibilityTool="false"` 명시와 비-debuggable release 빌드로 **차단이 풀릴지는 모른다** | **확신 없음** | 두 수정 모두 문서화된 요구를 맞추는 일이지만, 추정 1 이 맞다면 이것으로는 풀리지 않는다. **검증 불가** — release APK 가 서명되지 않아 설치할 수 없다(§3-4) |
| 추정 4 | 디버그 키 서명이 요인일 수 있다 | 낮음 | 차단 문구가 서명을 말하지 않는다. 다만 debuggable 과 묶여 "개발 빌드" 신호가 된다 |

### 4-5. 개발자 검증은 이 차단의 원인이 아니다

`developer.android.com/developer-verification` 의 시행 일정은 2026-09-30
브라질·인도네시아·싱가포르·태국이고 한국은 2027년 이후다. 차단 문구도
검증 미등록이 아니라 민감 정보 접근을 말한다. **이 차단과 개발자 검증은
다른 사안이다.** 다만 중기적으로는 검증 등록이 필요해지며, 그때
**제한 배포 계정**(신원증명·등록비 없이 20대 기기)이 정과장님 상황에
맞는 선택지가 될 수 있다.

## 5. 적용한 수정

읽기 기능을 그대로 두고, 문서화된 요구사항에 맞지 않던 것만 고쳤다.

| 수정 | 근거 | 효과 |
|---|---|---|
| `android:isAccessibilityTool="false"` **명시** | R.attr 정의. 이 앱은 장애인 지원 도구가 아니다 | 선언을 정직하게 드러낸다. `true` 로 바꿔 지원 도구라고 주장하지 않았다 |
| `accessibilityFlags` 에서 `flagReportViewIds` **제거** | 코드가 뷰 ID 를 읽지 않는다(`ObservedNode` 에 그 자리가 없다) | 쓰지 않는 정보를 요청하지 않는다. 요청 범위가 줄었다 |
| debuggable 이 아닌 **release 빌드 타입** 추가 | `.../risks/android-debuggable` | 배포·검토용 빌드가 debuggable 이 아니다(§3-1 에서 확인) |
| release 서명을 Secret 으로 분리 | — | 키스토어를 저장소·artifact 에 두지 않는다 |

### 알려드리는 부작용

`isAccessibilityTool="false"` 로 선언하면, 대상 앱이 `accessibilityDataSensitive`
를 `yes` 로 표시한 뷰는 **읽을 수 없게 된다**(R.attr, API 34). 공식 앱이
좌석 표시를 그렇게 표시해 두었다면 그 화면은 읽기 불가가 된다. 그래도
거짓 선언보다 이쪽이 맞다. 읽기 불가로 나오면 그대로 보고한다.

### 코드 수정으로 해결됐는지

**모른다.** 추정 3 그대로다. 그리고 지금은 **검증할 수도 없다** — release
APK 가 서명되지 않아 설치할 수 없기 때문이다. 다음 단계는
`android/docs/PLAY-SUBMISSION-MATERIALS.md` 에 있다.

## 6. 쓰지 않는 해결책

사용자 지시이자 이 프로젝트의 원칙이다.

- **Play 프로텍트 해제·우회를 해결책으로 쓰지 않는다.** 기기 보안 기능을
  끄도록 안내하지 않는다.
- **패키지명을 바꿔 차단을 피하지 않는다.** 탐지 회피에 해당한다.
- **권한을 숨기거나 용도를 허위로 선언하지 않는다.** 특히
  `android:isAccessibilityTool` 을 `true` 로 두어 장애인 지원 도구라고
  선언하지 않는다. 이 앱은 그런 도구가 아니다.
- 읽기 기능 자체를 없애서 차단만 피하지 않는다. 기능을 유지한 상태에서
  고칠 수 있는 것을 고치고, 고칠 수 없으면 그렇게 보고한다.
