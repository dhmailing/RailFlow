# 웹에서 추출한 디자인 토큰

출처: `app/globals.css` (웹 기준 커밋 `274f434`), `app/page.tsx:645-647`.
Android 화면은 이 값을 그대로 쓴다. 눈대중으로 비슷한 색을 만들지 않는다.

## 색

| 역할 | 값 | 비고 |
|---|---|---|
| background | `#070707` | 앱 배경 |
| foreground | `#F7F7F7` | 기본 글자 |
| card | `#111111` | 카드 면 |
| popover | `#171717` | 바텀시트·다이얼로그 |
| primary | `#FF8A1F` | 강조색 |
| primary-foreground | `#090909` | 강조색 위 글자 |
| secondary | `#1D1D1D` | 보조 버튼 |
| muted | `#1C1C1C` | 비활성 면 |
| muted-foreground | `#929292` | 보조 설명 글자 |
| accent | `#2A1A0D` | 강조 배경(약) |
| accent-foreground | `#FFBD7B` | 강조 배경 위 글자 |
| destructive | `#FF5F57` | 중단·삭제·오류 |
| border | `#2B2B2B` | 카드·구분선 |
| input | `#333333` | 입력 테두리 |
| ring | `#FF8A1F` | 포커스 링 |
| sidebar(= 하단 탐색 바) | `#0D0D0D` | 본문보다 약간 어둡다 |

가상 데이터 표시에는 `muted-foreground` 와 명시적 라벨을 함께 쓴다.
실제 데이터에는 출처 이름을 적는다. 색만으로 구분하지 않는다.

## 모양

- 기본 radius `0.875rem` = **14dp**
- sm 10dp / md 12dp / lg 14dp / xl 20dp

## 하단 탐색 (웹과 같은 3개, 같은 순서)

1. **예매** (Ticket) — 조건 입력·후보 목록
2. **자동예약** (RefreshCw) — 선택 후보 수를 배지로 표시
3. **마이페이지** (UserRound)

웹에는 `watch-jobs` 와 `autobook-panel` 로 감시 패널이 두 개 있다.
**앱에서는 자동예약 한 화면으로 합친다**(이름만 다른 패널을 두 개 만들지
않는다).

## 배치 규칙

- 좁은 화면에서 줄바꿈한다. 글자·버튼이 카드 밖으로 나가지 않는다.
- 역 이름이 긴 경우(예: `울산(통도사)`)를 기준으로 폭을 잡는다.
- 큰 글자 설정(fontScale 2.0)과 폴더블 좁은 폭에서 깨지지 않아야 한다.
