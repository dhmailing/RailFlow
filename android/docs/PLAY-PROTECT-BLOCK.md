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
| 차단 화면 버튼 | **`확인` 하나뿐** (사용자 캡처로 확인) → **하드 차단**. "무시하고 설치" 선택지가 없었다 |
| 보고자 | 사용자 실기기 관찰 |

**이전 보고 정정:** CI 빌드 성공을 설치 가능으로 읽지 않았고 실기기 검증은
NOT RUN 으로 적어 두었다. 이제 그 항목은 NOT RUN 이 아니라 **BLOCKED** 다.

## 1-2. 이전 보고에서 정정하는 단정

이 문서와 이전 대화에서 제가 과하게 단정한 부분이다. 정정 내용을 먼저 적는다.

| 이전 표현 | 정정 |
|---|---|
| "`isAccessibilityTool="false"` 명시의 **부작용**으로 `accessibilityDataSensitive="yes"` 뷰를 읽을 수 없게 된다" | **틀렸다.** 이 속성의 기본값이 이미 false 였으므로(R.attr, API 31), 명시는 **런타임 동작을 바꾸지 않는다.** 그 읽기 제한은 차단된 `f19f554` 에도 똑같이 적용되고 있었다. 명시의 효과는 선언을 manifest 에 드러내는 것뿐이다 |
| "하드 차단이라 **Play 배포가 사실상 유일한 경로**다" | **철회한다.** 차단 화면에 `확인` 만 있었던 것은 사실이지만, 그로부터 Play 배포가 유일한 경로라는 결론은 나오지 않는다. 이의신청 경로가 있고(§4-2 의 공식 주소), 개발자 검증의 제한 배포 계정 같은 다른 경로도 있다. 어느 경로가 통할지는 확인하지 못했다 |
| "`INTERNET` 권한이 없으므로 **모든 외부 전달이 불가능하다**" | **과했다.** 정확히는 **앱이 직접 네트워크 통신을 할 수 없다**는 것이다. 간접 경로는 코드 검토로 따로 확인했다(§3-6). 실제로 **알림을 통한 노출 경로가 하나 있다** |
| 읽기 전용 근거를 "`canPerformGestures` 등 제스처 플래그가 없다"로만 제시 | 플래그 부재는 선언 수준의 근거일 뿐이다. **실제 조작 API 호출이 없다는 것**을 코드에서 확인한 결과로 바꿔 제시한다(§3-7). CI 가 이를 강제한다 |

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

`INTERNET` 이 없다는 것은 **앱이 직접 네트워크 통신을 할 수 없다**는 뜻이다.
플랫폼이 강제하는 제한이며 코드 약속이 아니다.

이것을 "모든 외부 전달이 불가능하다" 로 넓혀 말하지 않는다. 간접 경로는
따로 코드를 검토해 §3-6 에 적었고, **알림을 통한 노출 경로가 하나 있다.**

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

### 3-6. 데이터가 앱 밖으로 나갈 수 있는 경로 — 코드 검토 결과

`INTERNET` 권한 부재가 보장하는 것은 **직접 네트워크 통신 불가**다. 그 밖의
경로를 코드에서 하나씩 확인했다(검색 대상: `app/src`, `observer/src` 전체).

| 경로 | 결과 |
|---|---|
| 네트워크 API (`HttpURLConnection`, `openConnection`, OkHttp, Retrofit, `Socket`, `WebView`) | **없음** |
| 파일 쓰기 (`FileOutputStream`, `getExternalFilesDir`, `writeText`) | **없음.** DataStore 가 앱 전용 저장소에만 쓴다 |
| 클립보드 (`ClipboardManager`, `setPrimaryClip`) | **없음** |
| 로그 출력 (`Log.*`, `println`, `printStackTrace`) | **없음** |
| 공유 Intent (`ACTION_SEND`, `createChooser`, `EXTRA_TEXT`, `FileProvider`) | **없음** |
| `ContentProvider` 노출 | **없음** |
| 클라우드 백업 | `android:allowBackup="false"` |
| `startActivity` | **3곳.** 모두 시스템 설정 화면으로 이동할 뿐이며 관찰 데이터를 담지 않는다 — `Settings.ACTION_ACCESSIBILITY_SETTINGS` 2곳, `Settings.ACTION_APPLICATION_DETAILS_SETTINGS` 1곳(자기 앱 패키지 URI만 전달) |

**찾은 노출 경로 하나 — 시스템 알림.**

`MainViewModel.applyObservation()` 이 읽기 성공 시 알림을 띄우고, 그 본문에
관찰 결과가 들어간다.

```kotlin
"${train.trainLabel} ${train.departAt ?: "시각 불명"} · 일반실 ${label(...)} · 특실 ${label(...)}"
```

따라서 다음 경우에 관찰 내용이 앱 밖에서 보일 수 있다.

- 잠금화면·알림 그늘에 표시된다.
- 사용자가 **별도로** 알림 접근 권한(`BIND_NOTIFICATION_LISTENER_SERVICE`)을
  준 다른 앱이 그 본문을 읽을 수 있다. 그 권한은 이 앱이 아니라 그 앱이
  갖는 것이며, 사용자가 직접 허용해야 한다.

알림 본문에 자격증명·세션·화면 원문은 들어가지 않는다. 열차번호·시각·좌석
표시만 들어간다. 그래도 **"모든 외부 전달이 불가능하다"고는 말할 수 없다.**

### 3-7. 읽기 전용의 실제 근거 — 조작 API 호출 부재

선언 플래그 부재(§3-3)는 근거의 절반이다. 나머지 절반은 **코드가 조작 API 를
호출하지 않는다**는 것이다. 주석과 문자열 리터럴을 지운 뒤 검사한 결과,
아래 호출이 `app/src`·`observer/src` 전체에 **하나도 없다.**

```
performAction, performGlobalAction, dispatchGesture, takeScreenshot,
setServiceInfo, GLOBAL_ACTION_*, ACTION_CLICK, ACTION_SET_TEXT,
ACTION_SCROLL_FORWARD, ACTION_SCROLL_BACKWARD
```

(`RailObserverService.kt` 의 주석에 이 이름들이 적혀 있으나 호출이 아니다.
검사는 주석을 제거한 뒤 수행한다.)

서비스가 `AccessibilityNodeInfo` 에서 실제로 쓰는 멤버는 읽기 전용 7개뿐이다.

```
childCount, getChild(), text, contentDescription, className,
isPassword, isEditable, recycle()
```

이 사실은 CI 의 **읽기 전용 강제 검사** 단계가 매 빌드마다 확인한다. 조작
API 나 네트워크 API 가 들어오면 빌드가 실패한다. 문서의 약속이 아니라
빌드 게이트다.

## 4. 공식 문서와의 대조 — 사실 / 해석 / 추정

### 4-1. 확인된 사실 (이번에 원문을 직접 읽음)

| 근거 | 내용 |
|---|---|
| `developer.android.com/reference/android/R.attr` (API 31) | `isAccessibilityTool` = "접근성 서비스가 **장애인 지원**에 쓰이는지". **기본값 false.** "If this flag is false, system will show a notification after a duration to inform the user about the privacy implications of the service" |
| 같은 문서 (API 34) | `accessibilityDataSensitive` — 뷰가 `isAccessibilityTool=true` 인 서비스만 상호작용하도록 요구할 수 있다. 기본 `auto` 는 시스템이 민감성을 판단 |
| `.../privacy-and-security/risks/android-debuggable` | "Always make sure to set the android:debuggable flag to false when shipping your application" |
| `.../privacy-and-security/risks/test-debug` | 디버그 기능이 남은 빌드를 배포하면 보안 수준이 떨어진다 |
| `developer.android.com/developer-verification` | 개발자 검증 보호는 **2026-09-30** 브라질·인도네시아·싱가포르·태국의 참여 스토어부터, **2027년** 전 세계로 확대. Play Console 이 패키지명을 등록. 학생·교사·취미 개발자를 위한 **제한 배포 계정**은 신원증명·등록비 없이 최대 20대 기기에 공유 가능 |

### 4-2. 공식 원문 — 주소와 열람 상태

이 차단 유형과 이의신청의 **공식 원문 주소**는 다음 두 곳이다.

| 용도 | 주소 |
|---|---|
| 차단 유형 개발자 안내 | `https://developers.google.com/android/play-protect/warning-dev-guidance` |
| 이의신청 | `https://support.google.com/googleplay/android-developer/contact/protectappeals` |

**열람 상태를 주체별로 구분한다.**

| 주체 | 상태 |
|---|---|
| 사용자(정과장님) 환경 | **열람 확인됨** |
| 이 작업 환경(Claude) | **열지 못했다.** 두 주소 모두 프록시가 CONNECT 에 403 으로 응답한다(`developers.google.com`, `support.google.com` 차단) |

따라서 **나는 이 두 문서의 원문을 읽지 않았다.** 아래 항목은 원문을
대조하지 못한 상태로 남는다.

- 차단 유형의 정확한 분류명과 판정 기준
- 개발자가 취할 수 있는 조치로 Google 이 **명시한** 항목
- 이의신청 양식이 요구하는 필수 입력 항목과 처리 기간
- 차단 화면이 "무시하고 설치" 를 제공하는 조건

정과장님이 두 문서를 열어 **개발자 조치 항목과 이의신청 필수 입력란**을
알려 주시면, 그 내용에 맞춰 `PLAY-SUBMISSION-MATERIALS.md` 의 문안을
고치겠다. 지금 문안은 원문 요구사항에 맞춘 것이 아니라 **이 앱의 사실
관계를 정리한 것**이다.

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

### `isAccessibilityTool="false"` 명시가 바꾸는 것과 바꾸지 않는 것

**런타임 동작을 바꾸지 않는다.** 이 속성의 기본값이 이미 `false` 이므로
(R.attr, API 31), 차단된 `f19f554` 도 `false` 로 동작하고 있었다.

| | 바뀌었나 |
|---|---|
| 접근성 서비스가 읽을 수 있는 범위 | **안 바뀜.** `accessibilityDataSensitive="yes"` 뷰를 읽을 수 없는 제한은 전부터 있었다 |
| 시스템의 개인정보 고지 알림 | **안 바뀜.** `false` 일 때 띄우는 동작이 전부터 적용됐다 |
| manifest 에 드러나는 선언 | **바뀜.** 속성이 APK 에 명시적으로 들어간다 |

즉 이 수정의 효과는 **정직성과 검토 가능성**이다. 검토자가 APK 를 열면
`isAccessibilityTool=false` 를 바로 볼 수 있고, 우리가 장애인 지원 도구라고
주장하지 않는다는 것이 기록된다. 동작 개선이나 새 제한이 아니다.

`flagReportViewIds` 제거는 **실제로 요청 범위를 줄인다.** 서비스가 뷰 ID 를
쓰지 않는데 요청하고 있었다.

### 코드 수정으로 해결됐는지

**모른다.** 추정 3 그대로다. 설치 결과를 받기 전에는 차단 해결이라고
보고하지 않는다.

검증하려면 **서명된 release APK** 가 필요하다. 서명 Secret 이 등록되기
전까지 release APK 는 서명되지 않으며, 설치할 수 없다. CI 는 그 경우
파일명에 `-UNSIGNED-DO-NOT-INSTALL` 을 붙여 설치용으로 오인되지 않게 한다.

절차는 `android/docs/PLAY-SUBMISSION-MATERIALS.md` 에 있다.

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
