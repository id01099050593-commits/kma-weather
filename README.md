# 기상청 단기예보 날씨 페이지 (춘천 · 서울)

> 만든 과정과 다른 컴퓨터에서 이어서 작업하는 방법은 [작업기록.md](작업기록.md) 참고

GitHub Actions가 하루 8번 기상청 단기예보 API를 호출해 `docs/index.html`을 다시 만들고,
GitHub Pages가 그 페이지를 고정 주소로 보여줍니다. PC가 꺼져 있어도 동작합니다.
아이폰 화면에 맞춘 화이트 UI이며, 상단 탭을 누르거나 좌우로 밀어 지역을 바꿉니다.

## 구성

| 파일 | 역할 |
|---|---|
| `config.json` | 지역 목록 (이름, 위도/경도 → 격자 nx, ny 자동 계산) |
| `scripts/update.mjs` | API 호출 → `docs/index.html`, `docs/data.json` 생성 |
| `.github/workflows/update-weather.yml` | 실행 시각: 기상청 발표 15분 뒤, 하루 8회 (02:15 · 05:15 · … · 23:15 KST) |

## 설정 순서

1. **인증키 발급**: [공공데이터포털](https://www.data.go.kr)에서 「기상청_단기예보 ((구)_동네예보) 조회서비스」 활용신청 → 마이페이지에서 일반 인증키 복사
2. **Secret 등록**: 저장소 Settings → Secrets and variables → Actions → New repository secret
   - Name: `KMA_SERVICE_KEY` / Value: 인증키
3. **첫 실행**: Actions 탭 → 「날씨 업데이트」 → *Run workflow*

## 바꾸고 싶을 때

- **지역 추가/변경**: `config.json`의 `locations`에 항목 추가 (탭이 자동으로 늘어남)
- **실행 시각**: 워크플로의 `cron` 수정 (UTC 기준, KST −9시간)
- **로컬 미리보기**: `node scripts/update.mjs --mock` (가짜 데이터로 페이지 생성)

## 참고

- GitHub 예약 실행은 몇 분~수십 분 늦게 시작될 수 있습니다.
- 아이폰 Safari에서 공유 → 「홈 화면에 추가」 하면 앱처럼 열 수 있습니다.
