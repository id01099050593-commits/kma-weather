# 기상청 단기예보 날씨 페이지

GitHub Actions가 정해진 시간마다 기상청 단기예보 API를 호출해 `docs/index.html`을 다시 만들고,
GitHub Pages가 그 페이지를 고정 주소로 보여줍니다. PC가 꺼져 있어도 동작합니다.

## 구성

| 파일 | 역할 |
|---|---|
| `config.json` | 지역 이름과 위도/경도 (격자 nx, ny는 자동 계산) |
| `scripts/update.mjs` | API 호출 → `docs/index.html`, `docs/data.json` 생성 |
| `.github/workflows/update-weather.yml` | 실행 시각 (기본: 매 발표 15분 뒤, 하루 8회) |

## 설정 순서

1. **인증키 발급**: [공공데이터포털](https://www.data.go.kr)에서 「기상청_단기예보 ((구)_동네예보) 조회서비스」 활용신청 → 마이페이지에서 일반 인증키(Decoding) 복사
2. **Secret 등록**: 저장소 Settings → Secrets and variables → Actions → New repository secret
   - Name: `KMA_SERVICE_KEY` / Value: 인증키
3. **Pages 켜기**: Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, 폴더 `/docs`
4. **첫 실행**: Actions 탭 → 「날씨 업데이트」 → *Run workflow*

## 바꾸고 싶을 때

- **지역**: `config.json`의 `name`, `lat`, `lon` 수정
- **실행 시각**: 워크플로의 `cron` 수정 (UTC 기준, KST −9시간)
- **로컬 미리보기**: `node scripts/update.mjs --mock` (가짜 데이터로 페이지 생성)

## 참고

- GitHub 예약 실행은 몇 분~수십 분 늦게 시작될 수 있습니다.
- 공개 저장소에서 60일간 활동이 없으면 예약 실행이 멈추지만, 이 워크플로는 매번 커밋하므로 보통 유지됩니다.
  멈췄다는 메일이 오면 Actions 탭에서 다시 켜면 됩니다.
