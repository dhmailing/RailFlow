# 사이트 프로필

이 폴더에는 **완성된 프로필이 들어 있지 않습니다.** 일부러 그렇게 뒀습니다.

RailFlow를 만든 개발 환경에서는 공식 예매 사이트로 나가는 연결이 차단돼
있어(자세한 내용: `docs/V0.8-LIVE-BOOKING-AGENT.md` §2) 실제 화면을 볼 수
없었습니다. 화면을 보지 않고 "매진이라는 글자는 아마 이럴 것이다"라고
적어 두면 그건 추측이고, 잘못된 열차를 예약할 위험을 만듭니다.

그래서 프로필은 **사용자의 PC에서 실제 화면을 열어** 만듭니다.

```
node railflow-agent.mjs capture --url "https://<공식 예매 화면 주소>"
```

결과는 아래 경로에 저장됩니다(이 폴더가 아닙니다).

```
%USERPROFILE%\.railflow-agent\profiles\sr-srt.profile.json
```

`TEMPLATE.profile.json` 은 어떤 항목을 채워야 하는지 보여주는 빈 틀입니다.
값이 비어 있는 것이 정상이며, capture 결과의 `observed` 목록을 보고 실제
화면의 글자로 채우면 됩니다.

채운 뒤 확인:

```
node railflow-agent.mjs check
```

`verified` 가 `true` 가 아니거나 필수 항목이 비어 있으면 Agent는 조회도
클릭도 하지 않습니다(`PROVIDER_PROFILE_REQUIRED`).

자세한 절차: [Windows 실행 방법](../README-WINDOWS.md) 2단계
