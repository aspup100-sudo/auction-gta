# 경매 GTA 중계 서버 (relay)

실시간 채널·친구 방의 연결을 서버가 맡습니다. 서버가 없을 때(예전 방식)는 플레이어 한 명의 폰이 '방장'이라
그 폰이 잠들면 채널이 끊겼는데, 서버가 있으면 사람 목록·입찰표 장부·순위표를 서버가 들고 있어 누가 들어오고 나가도 채널이 그대로 이어집니다.

- `src/index.js` — Cloudflare Worker + Durable Object (채널·방마다 하나씩, 절전 WebSocket)
- `src/room.js` — 방 규칙 (사람 목록, `lbid` 장부, 순위표 `seen`, 10초마다 심장박동)
- `test-server.js` — 같은 규칙을 Node(`ws`)로 돌리는 로컬 테스트 서버
- `wrangler.toml` — Cloudflare 설정 (무료 플랜에서 되는 SQLite Durable Object)

게임은 같은 폴더의 `relay-url.txt`(배포 워크플로가 자동으로 써 넣음)에서 서버 주소를 읽습니다. 파일이 없거나 서버가 안 되면 예전 방식(PeerJS)으로 돌아갑니다.

## 처음 한 번 설치 순서 (약 10분, 무료)

1. **Cloudflare 가입** — https://dash.cloudflare.com/sign-up (이메일만 있으면 됨, 카드 필요 없음)
2. 왼쪽 메뉴 **Workers & Pages** 클릭 → 처음이면 `*.workers.dev` 하위 도메인 이름을 하나 정하라고 함 → 아무 이름이나 정하고 저장
3. 같은 화면 오른쪽(또는 Overview)의 **Account ID** 복사 → 메모
4. 오른쪽 위 프로필 → **My Profile → API Tokens → Create Token** → 템플릿 **"Edit Cloudflare Workers"** 의 Use template → 아래 **Continue to summary → Create Token** → 나온 토큰 복사 (한 번만 보여 줌)
5. GitHub 저장소 `aspup100-sudo/auction-gta` → **Settings → Secrets and variables → Actions → New repository secret** 로 두 개 추가
   - `CLOUDFLARE_API_TOKEN` = 4번 토큰
   - `CLOUDFLARE_ACCOUNT_ID` = 3번 Account ID
6. 저장소 **Actions** 탭 → 왼쪽 **Relay** → **Run workflow → Run workflow**
7. 1~2분 뒤 초록색이 되면 끝. 워크플로가 `relay-url.txt`에 서버 주소를 적어 커밋하고 게임(Pages)도 다시 배포합니다. 게임을 다시 열면(앱이면 한 번 껐다 켜기) 실시간 채널이 서버로 붙습니다. 메뉴의 순위판 아래에 "중계 서버 연결"이 보이면 성공.

이후에는 `relay/` 안의 파일이 바뀌어 main에 올라갈 때마다 자동으로 다시 배포됩니다.

## 비용
Cloudflare Workers 무료 플랜: 하루 10만 요청. 메시지 20개가 요청 1개로 계산되므로 동시에 수십 명이 매일 몇 시간씩 해도 무료 범위입니다.
더 많아지면 Workers Paid(월 $5)로 올리면 됩니다 (대시보드에서 플랜 변경만 하면 끝, 코드 그대로).

## 로컬 테스트
```
cd relay && npm install && node test-server.js 8787
```
게임 콘솔에서 `FEEL.relayUrl = 'http://127.0.0.1:8787'` 로 두고 채널에 들어가면 됩니다.

## 주소
- 접속: `wss://<worker>/ch/<채널 번호>?id=<플레이어 id>&name=<이름>` (채널), `wss://<worker>/room/<방 코드>?...` (친구 방)
- 상태 확인: `https://<worker>/health`
