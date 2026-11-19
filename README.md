# G2 Status: 하루 종일 켜두는 상태표시창

Even Realities **G2** 글래스용 Even Hub 플러그인입니다. 시야 위쪽(또는 아래쪽)에 3줄짜리 HUD를 띄우고,
**시간대·위치·일정에 따라 보여주는 정보를 자동으로 바꿉니다.** 평소에는 흐리게 표시하다가, 회의가 임박하거나
CI가 실패하는 등 중요한 일이 생기면 그 줄만 밝게 깜빡입니다.

```
14:32 목  12° 맑음  78%          ← top  : 시계 / 날씨 / 글래스 배터리
> 보고서 초안 [#####---] 10분     ← main : 지금 할 일 + 뽀모도로
15:00 디자인 리뷰 (28분 후)        ← sub  : 다음 일정
```

## 모드 (자동 전환)

| 모드 | 언제 | top | main | sub |
|---|---|---|---|---|
| 출퇴근 | 평일 출퇴근 시간대 | 시계·날씨·배터리 | 지하철 도착 | 다음 일정 |
| 업무 | 평일 근무시간 / 회사 근처 | 시계·배터리·개발상태 | 할 일 + 뽀모도로 | 다음 일정 |
| 운동 | 운동 타이머 시작 / "헬스" 같은 일정 진행 중 | 시계·배터리 | 운동 경과 | 날씨·미세먼지 |
| 저녁 | 19시 이후 | 시계·날씨·배터리 | 오늘 요약·트래커 | 내일 첫 일정 |
| 기본 | 그 외 (주말 낮 등) | 시계·날씨·배터리 | 다음 일정 | 할 일 |

우선순위: 수동 고정 > 운동 > 위치(집/회사 좌표 설정 시) > 시간대 > 기본.
모드별 레이아웃은 설정의 "고급: 모드별 레이아웃(JSON)"에서 바꿀 수 있습니다.

## 위젯

| id | 내용 | 데이터 |
|---|---|---|
| `clock` | `14:32 목` | - |
| `weather` | `12° 맑음`, 3시간 내 강수확률 60%↑면 `우산70%` | Open-Meteo (키 불필요) |
| `air` | `초미세 18 보통`, 매우나쁨이면 강조 | Open-Meteo Air Quality |
| `battery` | 글래스 배터리, 15% 이하면 강조 | Even SDK |
| `calendar` | 다음/진행중 일정, N분 전부터 강조 | ICS 주소 + 직접 입력 |
| `tomorrow` | 내일 첫 일정 | 〃 |
| `focus` | 맨 위 할 일 + 뽀모도로 진행바 | 폰에서 입력 |
| `dev` | `CI 실패 리뷰 2 다운 api`, 문제 있을 때만 강조 | GitHub API, 헬스체크 URL |
| `transit` | `2호선 성수행 3분 / 7분` | 서울 열린데이터 실시간 도착 |
| `tracker` | 물 잔 수, 며칠째, 업비트 시세, 환율, 임의 JSON 값 | 업비트, open.er-api.com |
| `workout` | `운동 32분째` | 메뉴로 시작/종료 |
| `today` | `완료 3 · 뽀모 4` | 오늘 카운터 |

## 글래스 조작

- **탭**: 뽀모도로가 끝났으면 다음 단계(휴식/집중) 시작. 아니면 화면 모드 전환 (자동 → 기본 → 출퇴근 → 업무 → 운동 → 저녁 → 자동)
- **더블탭**: 화면 숨기기/보이기 (대화 중일 때)
- **길게 누르기**: 지금 할 일 완료
- **메뉴**: 뽀모도로 시작/정지, 할 일 완료, 물 +1, 운동 시작/종료, 모드 전환, 숨기기, 새로고침

## 배터리 절약 설계

- 화면은 **바뀐 줄만** 전송합니다. 타이머도 분 단위로 표시해서, 평소에는 1분에 한 번 정도만 BLE로 씁니다.
- 네트워크 요청은 **지금 화면에 보이는 위젯만**, 위젯별 주기로 보냅니다 (날씨 30분, 시세 5분, CI 2분, 지하철 30초).
- 글래스를 벗거나 앱이 백그라운드로 가면 전송과 네트워크 요청을 멈추고, 돌아오면 전체를 다시 그립니다.

## 개발

Node 20.17+ / 22.13+ 필요.

```bash
npm install
npm run dev        # http://localhost:5173: 브라우저에서 가짜 글래스 화면으로 미리보기
npm test           # 단위 테스트 (vitest)
npm run build      # 타입체크 + dist/ 빌드
```

브라우저에서는 576×288 글래스 화면을 흉내 낸 미리보기와 탭/더블탭/길게 누르기/메뉴 버튼이 나옵니다.
Even App WebView 안에서는 자동으로 실제 SDK 브리지를 씁니다.

### 실기기 테스트 (사이드로드)

1. Even App에서 개발자 모드 켜기
2. `npm run dev` 실행 후 다른 터미널에서 `npm run qr`
3. Even App으로 QR 스캔

### 수동 패키징

```bash
npm run pack      # → g2-status.ehpk
```

## 자동 배포 (GitHub Actions)

| 워크플로 | 언제 | 하는 일 |
|---|---|---|
| `CI` | 모든 push / PR | 버전 일치 확인 → 타입체크 → 테스트 → 빌드 → `.ehpk` 패키징 → 아티팩트 업로드 |
| `Release` | `v*.*.*` 태그 push (또는 수동 실행) | 위 검사 전부 → Even Hub 업로드 (첫 배포면 앱 생성) → beta 채널 지정 → GitHub Release에 `.ehpk` 첨부 |

### 1회 설정

`evenhub login`은 비밀번호를 대화형으로 묻기 때문에 CI에서 직접 로그인할 수 없습니다.
그래서 **내 컴퓨터에서 로그인한 자격 증명을 GitHub Secret으로 넘깁니다.**

```bash
npx evenhub login                 # 내 컴퓨터에서 한 번
npm run credentials --silent      # base64 한 줄 출력
```

1. GitHub 저장소 → Settings → Secrets and variables → Actions → **New repository secret**
   - 이름 `EVENHUB_CREDENTIALS_B64`, 값은 위에서 출력된 한 줄
   - `gh` CLI가 있다면: `npm run credentials --silent | gh secret set EVENHUB_CREDENTIALS_B64`
2. (선택) Settings → Environments → `evenhub` 환경에 **Required reviewers**를 걸면 업로드마다 승인 후 진행됩니다.
3. (선택) Actions **Variables**
   - `EVENHUB_BETA` = `false`: beta 채널 지정 생략
   - `EVENHUB_TAGLINE`: 첫 배포 시 스토어 한 줄 소개 (기본: "하루 종일 켜두는 상태표시창")

이 secret은 내 Even Hub 계정에 업로드할 수 있는 권한이니 비밀번호처럼 다루세요.
리프레시 토큰 만료 14일 전부터 워크플로에 경고가 뜨고, 만료되면 재로그인 안내와 함께 실패합니다.
그때 위 두 줄을 다시 실행해 secret을 갱신하면 됩니다.

### 릴리스하기

```bash
npm version patch          # package.json + app.json 버전 올리고 커밋 + v0.1.1 태그
git push --follow-tags     # → Release 워크플로 실행
```

- 릴리스 노트(=Even Hub 변경 내역, 최대 500자)는 지난 태그 이후 커밋 제목으로 자동 생성됩니다.
  직접 쓰고 싶으면 `git tag -a v0.2.0 -m "변경 내용"`처럼 메시지 있는 태그를 쓰세요.
- 같은 버전으로 다시 실행해도 안전합니다 (이미 업로드된 버전은 건너뜀). 실패하면 Actions에서 **Re-run** 하면 됩니다.
- 스토어 소개문은 `store/description.md`, 아이콘은 `store/icon.png`(24×24 PNG, 지금은 임시 아이콘)입니다.
- **공개(public) 배포는 Even 심사가 필요해서 CLI로 자동화할 수 없습니다.** beta에서 확인한 뒤 Even Hub 개발자
  포털에서 심사를 요청하세요. 베타 테스터는 `npx evenhub testers add 이메일`로 초대합니다.

## 구조

```
src/
  core/        engine(모드 결정·렌더·diff 전송·입력), context(모드 규칙), ics(캘린더 파서),
               pomodoro, settings, state
  widgets/     위젯 하나 = render() + 선택적 refresh(). 글래스를 직접 건드리지 않음
  glasses/     3줄 컨테이너 배치, 메뉴 정의
  platform/    Host 인터페이스: evenHost(실제 SDK) / previewHost(브라우저)
  ui/          폰 설정 화면
scripts/       버전 동기화, 릴리스 노트, 자격 증명 복원, Even Hub 업로드 (publish.sh)
store/         스토어 소개문, 아이콘
.github/       CI / Release 워크플로
```

새 위젯 추가: `src/widgets/`에 `Widget`을 만들고 → `widgets/index.ts`에 등록 → `WidgetId` 타입에 id 추가 →
`DEFAULT_LAYOUTS`나 설정의 레이아웃 JSON에 배치하면 됩니다.

## 알아둘 점 / 제약

- **네트워크 화이트리스트**: `app.json`의 `whitelist`에 등록된 호스트만 접근된다고 가정했습니다.
  ICS 주소, 헬스체크 URL, `json` 트래커 URL을 쓰려면 그 호스트를 `app.json`에 추가하고 다시 패키징하세요.
- **ICS와 CORS**: 구글 캘린더 ICS는 CORS 헤더가 없어 WebView에서 막힐 수 있습니다. 그럴 땐 CORS 프록시
  접두사를 쓰거나 "직접 입력 일정"을 쓰세요. TZID가 붙은 시간은 폰의 시간대로 해석합니다.
- **서울 지하철 API는 HTTP 전용**입니다. 패키징된 앱이 HTTPS로 로드되면 혼합 콘텐츠로 막힐 수 있습니다.
- **심박수·걸음 수**는 현재 Even Hub SDK에 건강 데이터 API가 없어 넣지 못했습니다.
- 글래스 폰트에서 `°`, `…` 같은 기호가 제대로 나오는지는 실기기에서 확인이 필요합니다. 한 줄 최대 폭(`LINE_WIDTH`)과
  줄 높이(`LINE_HEIGHT`)는 `src/glasses/layout.ts`에서 조정하세요.
- GitHub 토큰은 Even App 로컬 저장소에 저장됩니다. 읽기 전용(fine-grained, Actions/PR read) 토큰을 쓰세요.
