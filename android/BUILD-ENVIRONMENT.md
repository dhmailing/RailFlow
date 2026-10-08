# 빌드 환경 확인 결과 (2026-10-08)

## 사용 가능한 것

| 도구 | 버전 | 경로 |
|---|---|---|
| JDK | OpenJDK 21.0.10 | `/usr/lib/jvm/java-21-openjdk-amd64` |
| Gradle | 8.14.3 | `/opt/gradle-8.14.3` |
| 디스크 여유 | 23 GB | — |

## 막혀 있는 것 — **APK 를 만들 수 없는 원인**

이 개발 환경의 네트워크 정책이 `dl.google.com` 을 차단한다
(프록시가 CONNECT 에 403 응답). 확인한 결과:

| 호스트 | 결과 | 영향 |
|---|---|---|
| `dl.google.com` | **403 (차단)** | Android SDK 전부, Google Maven 전부 |
| `maven.google.com` | 301 → `dl.google.com` → **차단** | AGP, androidx, Compose 전부 |
| `developer.android.com` | 200 | 문서 조회만 가능 |
| `repo.maven.apache.org`, `repo1.maven.org` | 200 | Kotlin stdlib 등 Maven Central 만 |
| `services.gradle.org`, `plugins.gradle.org` | 200 | Gradle 배포본 |
| `maven.aliyun.com`, `mirrors.cloud.tencent.com`, `repo.huaweicloud.com` | 차단 | 미러도 불가 |

따라서 아래 세 가지를 하나도 받을 수 없다.

1. **Android SDK** (platform, build-tools, platform-tools, cmdline-tools)
2. **Android Gradle Plugin** — Google Maven 전용 배포
3. **androidx / Jetpack Compose** — Google Maven 전용 배포

Ubuntu 패키지로 `aapt`, `apksigner`, `zipalign`, `android-sdk-build-tools`,
`android-sdk-platform-23` 을 받을 수는 있다. 그러나 **API 23 플랫폼과
AGP·androidx 부재로는 Jetpack Compose 앱을 빌드할 수 없다.** 구형 View 기반
앱으로 바꾸는 것은 지시된 기술 구성(네이티브 Kotlin + Jetpack Compose)과
다르므로 임의로 대체하지 않는다.

## 선택한 해결 방법 — GitHub Actions 빌드 (3안)

사용자 결정에 따라 CI 에서 빌드한다.
`.github/workflows/railflow-android.yml` 이 `android/**` 경로 변경과 수동
실행에서만 돌고, 단위 테스트 → 린트 → 디버그 APK → SHA-256 을 artifact 로
올린다. 서명 키·인증정보는 올리지 않는다. 이 환경의 네트워크 정책과 무관하게
동작한다.

**이 선택의 한계:** 개발 환경에서 컴파일·린트를 먼저 돌려볼 수 없으므로,
CI 실패 로그를 읽고 고쳐 다시 돌리는 왕복이 생긴다.

## 고정한 버전

| 항목 | 버전 | 근거 |
|---|---|---|
| JDK | 17 (temurin) | AGP 8.7.x 가 요구하는 버전 |
| Gradle | 8.11.1 (wrapper) | AGP 8.7.3 요구 최소 8.9 이상 |
| AGP | 8.7.3 | compileSdk 35 지원 |
| Kotlin | 2.0.21 | Compose 컴파일러 플러그인 같은 버전 |
| Compose BOM | 2024.12.01 | Kotlin 2.0.21 과 함께 쓰이는 조합 |
| compileSdk / targetSdk | 35 | |
| minSdk | 26 | 적응형 아이콘과 알림 채널 기준 |

`gradle/libs.versions.toml` 에 모두 고정했다. `latest`·`+`·범위를 쓰지 않는다.

## 참고 — 다른 방법

### 1안 — 환경 네트워크 정책에 `dl.google.com` 허용

세션 제목줄의 cloud environment 메뉴 → Edit → Network access 에서
`dl.google.com` 을 Allowed domains 에 추가한다(Allow package managers 는
켠 상태로 둔다). 절차: https://code.claude.com/docs/en/cloud-environments#network-access

`maven.google.com` 은 `dl.google.com` 으로 리다이렉트되므로 둘 다 넣는
것이 안전하다.

허용되면 이 환경에서 바로 다음을 수행할 수 있다.
SDK cmdline-tools 설치 → platform/build-tools 설치 → Gradle 빌드 →
`assembleDebug` → APK + SHA-256 산출.

### 2안 — 로컬 Windows PC 에서 빌드

소스를 이 브랜치에서 받아 Android Studio 로 빌드한다. 다만 정과장님께
Android Studio 설치를 요구하지 않는다는 조건이 있으므로 1안이 우선이다.

(3안을 채택했다. 위 "선택한 해결 방법" 참조.)
