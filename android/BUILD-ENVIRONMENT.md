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

## 해결 방법

### 1안 (권장) — 환경 네트워크 정책에 `dl.google.com` 허용

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

### 3안 — GitHub Actions 로 빌드

`ubuntu-latest` 러너에는 Android SDK 가 설치돼 있다. 워크플로를 추가하면
CI 가 APK 를 artifact 로 만든다. 이 환경의 네트워크 정책과 무관하게
동작한다. 다만 서명 키 관리와 artifact 다운로드 절차가 추가된다.

## 버전 고정 방침

동적 버전(`latest`, `+`, 범위)을 쓰지 않는다. 네트워크가 열린 뒤 실제로
해석되는 조합을 확인하고 정확한 버전을 `gradle/libs.versions.toml` 에
고정한다. 확인 전에 기억에 의존해 버전을 적어 두지 않는다.
