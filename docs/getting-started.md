# 처음 설치하고 실행하기

이 문서는 **내 컴퓨터에 처음 설치하는 경우**를 기준으로 설명합니다.
명령어는 코드 상자의 내용을 한 줄씩 터미널에 입력하면 됩니다. 명령어 앞에 `$`는 붙이지 않습니다.
`실제값`, `YOUR_LINUX_USER`라고 적힌 부분은 본인 값으로 바꾸세요.

진행 순서는 다음과 같습니다.

| 단계 | 하는 일                                         | 완료하면 가능한 것                        |
| ---- | ----------------------------------------------- | ----------------------------------------- |
| 1~5  | 프로그램 설치 → 소스 받기 → DB 준비 → 서버 실행 | 브라우저에서 대시보드 열기                |
| 6~8  | GitHub App → 대상 저장소 등록 → Discord 봇 연결 | 저장소 선택·작업 요청·상태 조회           |
| 9~10 | Codex 로그인 → 실행 이미지·네트워크·테스트 준비 | 조건을 갖춘 워커에서 AI 작업 실행·PR 작성 |
| 11   | 다른 사람의 GitHub 리뷰·계정 연결·승인 설정     | 정책을 충족한 PR 병합                     |

**우선 5단계까지 완료해 대시보드부터 열어 보세요.**
그때는 GitHub 키, Discord 봇 토큰, OpenAI API 키가 없어도 됩니다.
실제 AI 실행에는 Codex 로그인뿐 아니라 아래에서 설명하는 워커 환경이 필요합니다.
최소 확장 seccomp 정책을 적용한 검증 환경에서 실제 Docker 내부 sandbox 검사가 통과했습니다.
본인 호스트에서도 9단계의 `runner:check`가 성공해야 합니다. 이전 설치는 [Runner 업데이트 안내](runner-security.md#8-기존-설치-업데이트와-정상-실행-확인)를 먼저 확인하세요.

## 1. 실행할 운영체제 준비

이 안내의 명령은 **Ubuntu 24.04, Linux x64, Bash 터미널** 기준입니다.
워커 이미지 빌드도 현재 Linux x64만 지원합니다. Ubuntu가 이미 준비되어 있으면 다음 단계로 이동하세요.

### Windows를 사용한다면

1. 시작 메뉴에서 **PowerShell → 관리자 권한으로 실행**을 선택합니다.
2. 다음 명령을 실행합니다.

   ```powershell
   wsl --install -d Ubuntu-24.04
   ```

3. 재부팅 안내가 나오면 재부팅합니다. 시작 메뉴의 **Ubuntu 24.04**를 열고 Linux 사용자 이름과 암호를 만듭니다.
   암호 입력 중 글자가 표시되지 않는 것은 정상입니다.
4. [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)를 설치하고 실행합니다.
5. Docker Desktop의 **Settings → General → Use the WSL 2 based engine**을 켭니다.
   **Resources → WSL Integration**에서 Ubuntu-24.04를 켜고 Apply & restart를 누릅니다.
6. 이후 `bash` 코드 상자의 명령은 모두 **Ubuntu 터미널**에서 실행합니다. PowerShell에서 이어서 실행하지 마세요.

Windows와 WSL에 따로 설치한 Node는 서로 다릅니다. 다음 단계의 Node 설치도 Ubuntu 터미널에서 진행합니다.
프로젝트는 `~/Discord-Auto-PR`처럼 Linux 홈 폴더에 받는 것을 권장합니다.

### Ubuntu PC·서버를 사용한다면

일반 사용자 계정으로 로그인합니다. `whoami` 결과가 `root`이면 일반 사용자 계정을 먼저 준비하세요.
설치 명령에 필요한 `sudo`는 사용할 수 있지만, **워커를 `sudo pnpm dev:worker`로 실행하면 안 됩니다.**

Docker가 없다면 [Docker 공식 Ubuntu 설치 안내](https://docs.docker.com/engine/install/ubuntu/)의
**Install using the apt repository** 순서로 Docker Engine과 Compose 플러그인을 설치합니다.
설치 후 일반 사용자에게 Docker 접근을 허용합니다.

```bash
sudo usermod -aG docker "$USER"
```

로그아웃한 뒤 다시 로그인해야 그룹 변경이 적용됩니다. Docker 그룹은 호스트 관리 권한에 해당하므로
이 워커를 운영하는 신뢰할 수 있는 사용자만 추가하세요.
Windows에서 Docker Desktop을 사용하는 경우에는 Ubuntu 안에 Docker Engine을 중복 설치하지 않습니다.

## 2. Git·Node.js·pnpm 설치

### 기본 도구 설치

Ubuntu 터미널에서 실행합니다.

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates xz-utils nano
```

### Node.js 24 설치

필요한 버전은 **Node.js 24**이며 이 저장소는 **24.19.0**으로 검증했습니다.
이미 해당 버전이 설치되어 있으면 다운로드 과정은 건너뛰세요.
아래는 Linux x64용 공식 배포 파일을 사용자 폴더에 설치하는 방법입니다.

```bash
mkdir -p "$HOME/.cache/hub-node-install"
cd "$HOME/.cache/hub-node-install"
curl -fSLO https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz
curl -fSLO https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
sha256sum --check --ignore-missing SHASUMS256.txt
```

`node-v24.19.0-linux-x64.tar.xz: OK`가 나와야 합니다. 확인에 실패하면 설치를 이어가지 마세요.

```bash
mkdir -p "$HOME/.local"
tar -xJf node-v24.19.0-linux-x64.tar.xz -C "$HOME/.local"
export PATH="$HOME/.local/node-v24.19.0-linux-x64/bin:$PATH"
```

새 터미널에서도 같은 Node를 사용하려면 다음 명령을 **한 번** 실행합니다.

```bash
printf '%s\n' 'export PATH="$HOME/.local/node-v24.19.0-linux-x64/bin:$PATH"' >> "$HOME/.bashrc"
```

### pnpm 활성화·설치 확인

```bash
corepack enable
corepack prepare pnpm@10.20.0 --activate
node --version
pnpm --version
git --version
docker version
docker compose version
```

확인할 결과:

- `node --version`: `v24.19.0`.
- `pnpm --version`: `10.20.0`.
- `docker version`: Client와 Server 정보가 모두 출력됨.
- `docker compose version`: Compose v2가 출력됨.

`corepack`이 없으면 `npm install --global corepack` 후 다시 활성화합니다.
`docker version`에 연결 오류가 나오면 Docker Desktop 또는 Docker Engine을 먼저 시작하세요.

## 3. 소스 코드와 의존성 설치

```bash
cd "$HOME"
git clone https://github.com/Duioolllll/Discord-Auto-PR.git
cd Discord-Auto-PR
pnpm install --frozen-lockfile
```

이미 저장소를 받았다면 다시 clone하지 말고 기존 폴더로 이동하세요.
GitHub에서 인증을 요구하면 저장소 접근 권한이 있는 계정으로 로그인합니다.
이 clone 인증과 나중에 만들 GitHub App 인증은 별개입니다.

**지금부터 모든 프로젝트 명령은 `Discord-Auto-PR` 폴더에서 실행합니다.**
새 터미널을 열 때도 먼저 다음을 입력하세요.

```bash
cd "$HOME/Discord-Auto-PR"
```

## 4. 로컬 설정과 데이터베이스 준비

다음 명령을 순서대로 실행합니다.

```bash
pnpm setup:local
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm build
```

각 명령의 의미는 다음과 같습니다.

| 명령          | 하는 일                        | 정상 완료 기준                                 |
| ------------- | ------------------------------ | ---------------------------------------------- |
| `setup:local` | 루트 `.env`에 내부 토큰을 생성 | 새 파일 생성 또는 기존 파일 보존 메시지        |
| `infra:up`    | PostgreSQL·Redis 컨테이너 시작 | 두 서비스가 healthy 상태                       |
| `db:generate` | Prisma DB 클라이언트 생성      | 클라이언트 생성 완료                           |
| `db:migrate`  | DB 테이블 준비                 | migration 적용 완료 또는 적용할 migration 없음 |
| `build`       | 앱·패키지 빌드                 | 작업들이 성공하고 명령 종료                    |

상태를 다시 보려면:

```bash
docker compose -f infra/compose.dev.yml ps
```

`.env`는 숨김 파일입니다. 파일 탐색기에서 보이지 않아도 다음 명령으로 열 수 있습니다.

```bash
nano .env
```

`nano`에서는 **Ctrl+O → Enter**로 저장하고 **Ctrl+X**로 나옵니다.
5단계까지는 생성된 설정을 수정할 필요가 없습니다.
`.env.example`을 `.env`에 덮어쓰면 자동 생성된 내부 토큰이 사라지므로 덮어쓰지 마세요.
기존 `.env`의 비어 있는 토큰 항목을 `setup:local`이 모두 자동 복구하는 것은 아닙니다.

## 5. 대시보드 실행

**터미널 창을 3개** 엽니다. 각 창에서 저장소 폴더로 이동한 뒤 아래 명령 하나씩 실행합니다.
서버 명령이 종료되지 않고 계속 실행되는 것이 정상입니다.

### 터미널 A — Control API

```bash
cd "$HOME/Discord-Auto-PR"
pnpm dev
```

다른 터미널에서 연결을 확인할 수 있습니다.

```bash
curl --fail http://127.0.0.1:3001/readyz
```

정상 응답은 `{"ok":true}`입니다. `/readyz`는 DB와 Redis 연결까지 확인합니다.

### 터미널 B — 작업 상태를 관리하는 스케줄러

```bash
cd "$HOME/Discord-Auto-PR"
pnpm --filter @hub/orchestrator dev
```

### 터미널 C — 웹 대시보드

```bash
cd "$HOME/Discord-Auto-PR"
pnpm --filter @hub/dashboard start
```

브라우저에서 **[http://localhost:3000](http://localhost:3000)**을 엽니다.
WSL을 사용한다면 Windows 브라우저에서 이 주소를 열면 됩니다.
다른 서버에 설치했다면 이 주소는 그 서버의 로컬 주소입니다. 외부 PC에서 보려면 SSH 포트 포워딩 등 별도 접속 구성이 필요합니다.

로그인 방법:

1. 별도 터미널에서 `nano .env`를 엽니다.
2. `ADMIN_API_TOKEN=긴문자열` 항목의 **등호 뒤 값만** 복사합니다.
3. 대시보드의 **Control API access token**에 붙여넣고 **대시보드 열기**를 누릅니다.
4. `Recent activity`, `Worker fleet` 등이 보이면 성공입니다.

이 토큰은 GitHub 키나 Discord 봇 토큰이 아닙니다. 화면 캡처나 채팅에 포함하지 마세요.
**아직 저장소·워커·작업 목록이 비어 있는 것은 정상입니다.** 다음 단계에서 연결합니다.

## 6. GitHub App과 키 설정

먼저 비밀 파일을 보관할 폴더를 만듭니다.

```bash
mkdir -p .local/secrets
chmod 700 .local/secrets
```

`.local`은 이 저장소의 Git 제외 경로입니다.

### App 두 개 생성·설치

1. [GitHub App 생성 화면](https://github.com/settings/apps/new)을 엽니다.
2. 개발용 App과 병합용 App을 **각각** 만듭니다. 예: `my-pr-hub-dev`, `my-pr-hub-merge`.
   이름은 GitHub에서 사용 가능한 고유 이름으로 정합니다. Homepage URL은 이 저장소 URL을 사용할 수 있습니다.
3. Repository permissions를 다음과 같이 설정합니다.

   | App    | Repository permissions                                                     |
   | ------ | -------------------------------------------------------------------------- |
   | 개발용 | Contents·Pull requests: Read and write / Checks·Commit statuses: Read-only |
   | 병합용 | Contents: Read and write / Pull requests: Read-only                        |

4. 공개 HTTPS 웹훅 주소가 아직 없다면 처음에는 Webhook의 **Active를 끄고** App 설치부터 진행할 수 있습니다.
   웹훅 연결은 아래 별도 순서에서 진행합니다. 상태 동기화는 스케줄러의 GitHub 조회도 사용합니다.
5. 각 App의 **General → App ID**를 메모합니다. Client ID가 아닙니다.
6. 각 App의 **Private keys → Generate a private key**에서 PEM 파일을 다운로드합니다.
7. 각 App의 **Install App → 계정 → Only select repositories**에서 실제 작업할 저장소를 선택해 설치합니다.
8. 설치 설정 페이지 URL의 `/installations/숫자`에서 두 installation ID를 메모합니다.
   **App ID와 installation ID는 서로 다릅니다.**

키 파일을 `.local/secrets/github-dev.pem`, `.local/secrets/github-merge.pem`으로 복사합니다.
Windows에서 다운로드했다면 Ubuntu에서는 `/mnt/c/Users/Windows계정/Downloads/파일이름.pem` 경로로 찾을 수 있습니다.
실제 파일 이름에 맞게 파일 탐색기나 `cp`로 복사한 뒤 다음을 실행합니다.

```bash
chmod 600 .local/secrets/github-dev.pem .local/secrets/github-merge.pem
realpath .local/secrets/github-dev.pem
realpath .local/secrets/github-merge.pem
```

`realpath`가 출력한 **절대 경로**를 `.env`에 사용합니다. 아래는 형식 예시이므로 ID와 사용자 경로를 바꾸세요.

```dotenv
GITHUB_APP_ID=실제_개발_App_ID
GITHUB_APP_PRIVATE_KEY_FILE=/home/YOUR_LINUX_USER/Discord-Auto-PR/.local/secrets/github-dev.pem
GITHUB_MERGE_APP_ID=실제_병합_App_ID
GITHUB_MERGE_APP_PRIVATE_KEY_FILE=/home/YOUR_LINUX_USER/Discord-Auto-PR/.local/secrets/github-merge.pem
GITHUB_MUTATIONS_ENABLED=false
```

키 파일 경로를 지정하는 것만으로 파일이 생기지는 않습니다. 실제 파일이 그 위치에 있어야 합니다.
값을 추가할 때 같은 환경변수 이름을 여러 번 넣지 말고 기존 줄이 있으면 수정하세요.
저장 후 터미널 A와 B에서 **Ctrl+C**를 누르고 각각의 시작 명령으로 재시작합니다.

### 웹훅을 연결할 때

1. GitHub에서 접근할 수 있는 공개 HTTPS 주소를 준비합니다.
   로컬의 `http://localhost:3001`은 GitHub에서 접근할 수 없습니다.
   Reverse proxy나 터널에서는 **`POST /webhooks/github`만** Control API로 전달하고 관리 API 전체를 공개하지 마세요.
2. 개발 App의 Webhook URL에 `https://본인-웹훅-도메인/webhooks/github`를 입력하고 Active를 켭니다.
3. `nano .env`로 확인한 기존 `GITHUB_WEBHOOK_SECRET` 값을 GitHub의 Webhook secret에 똑같이 입력합니다.
   이 로컬 테스트 방식에서는 `GITHUB_WEBHOOK_SECRET_FILE`을 지정하지 않아도 됩니다.
4. **Pull request, Check run, Check suite, Status** 이벤트를 선택합니다.
5. GitHub App의 Advanced → Recent deliveries에서 전달 결과를 확인합니다. 설정 중 첫 ping은 저장소 이벤트 처리와 별개입니다.

파일 방식이 필요하면 같은 secret을 비공개 파일에 저장하고 `GITHUB_WEBHOOK_SECRET_FILE`에 절대 경로를 지정하세요.
파일 설정이 있으면 `.env`의 인라인 값보다 우선합니다. 병합 App 웹훅은 사용하지 않습니다.

## 7. 작업할 저장소와 예산 등록

이 프로젝트를 clone했다고 작업 대상 저장소가 자동 등록되지는 않습니다.
별도 터미널에서 **실제 값으로 바꿔** 아래 명령을 실행합니다.
`SEED_INSTALLATION_ID`에는 App ID가 아니라 **설치 URL에서 확인한 개발 App installation ID**를 사용합니다.

```bash
SEED_REPOSITORY=본인GitHub아이디/작업할저장소 \
  SEED_INSTALLATION_ID=개발_App_설치_ID \
  SEED_MERGE_INSTALLATION_ID=병합_App_설치_ID \
  SEED_BUDGET_CENTS=1000 \
  pnpm db:seed
```

등록할 저장소에는 `main` 브랜치와 최소 한 개의 커밋이 있어야 합니다. 기본 대상 브랜치는 `main`입니다.
다른 기본 브랜치를 사용하는 저장소는 운영자가 DB의 `Repository.baseBranch`를 맞춰야 합니다. 현재 UI에는 변경 화면이 없습니다.

대시보드를 새로고침해 **Repositories & reservations**와 작업 요청의 저장소 목록에 나타나는지 확인합니다.
처음에는 `Pending verification`일 수 있습니다. 실제 워커가 GitHub App 설치 범위로 snapshot을 읽을 때 원격 검증합니다.

`1000 cents`는 **10 USD의 앱 내부 예산 한도**입니다. 결제·충전 명령이 아닙니다.
기본 작업 한 건은 `500 cents`를 예약합니다. 예산이 부족하면 작업 생성이 거절됩니다.
ChatGPT 사용 한도와 이 앱의 예산 예약은 별도입니다.

## 8. Discord 봇 연결

대시보드만 사용할 경우 이 단계는 건너뛸 수 있습니다.

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**을 만듭니다.
2. General Information의 **Application ID**를 메모합니다.
3. Bot → **Reset Token**에서 토큰을 발급합니다.
4. 아래 명령으로 파일을 열고 토큰 값만 붙여넣은 뒤 저장합니다.

   ```bash
   nano .local/secrets/discord-bot-token
   chmod 600 .local/secrets/discord-bot-token
   realpath .local/secrets/discord-bot-token
   ```

5. OAuth2 → URL Generator에서 **`bot`**, **`applications.commands`**를 선택합니다.
   **View Channels, Send Messages** 권한으로 생성된 URL을 열어 대상 서버에 초대합니다.
6. Discord 사용자 설정 → 고급 → 개발자 모드를 켭니다.
   서버 우클릭 → **서버 ID 복사**, 본인 사용자 우클릭 → **사용자 ID 복사**를 선택합니다.
7. `.env`에 실제 값을 입력합니다.

   ```dotenv
   DISCORD_BOT_TOKEN_FILE=/home/YOUR_LINUX_USER/Discord-Auto-PR/.local/secrets/discord-bot-token
   DISCORD_APPLICATION_ID=실제_Application_ID
   DISCORD_GUILD_ID=실제_서버_ID
   DISCORD_ADMIN_USER_IDS=실제_운영자_사용자_ID
   ```

관리자 여러 명은 `111111111111111111,222222222222222222`처럼 공백 없이 쉼표로 구분합니다.
현재 봇은 Guilds intent만 사용하므로 Message Content Intent를 켤 필요가 없습니다.
`DISCORD_ADMIN_USER_IDS`는 Control API가 읽는 설정이므로 터미널 A의 API도 재시작하세요.

개발 요청을 보낼 Discord 사용자를 저장소에 등록합니다. 7단계 명령에 사용자 ID를 추가한 형태입니다.

```bash
SEED_REPOSITORY=본인GitHub아이디/작업할저장소 \
  SEED_INSTALLATION_ID=개발_App_설치_ID \
  SEED_MERGE_INSTALLATION_ID=병합_App_설치_ID \
  SEED_DISCORD_USER_ID=실제_Discord_사용자_ID \
  pnpm db:seed
```

이 명령은 해당 Discord 사용자에 저장소의 developer 역할을 부여합니다. 일반 요청자에게 전역 관리자 권한을 줄 필요는 없습니다.
기존 등록을 갱신하는 명령이며, 위처럼 예산을 생략하면 기존 예산은 유지됩니다.

명령 등록은 한 번 실행하고 종료되기를 기다립니다.

```bash
pnpm --filter @hub/discord-bot dev --register-commands
```

`Registered guild slash commands.`가 나오면 성공입니다.
이 명령은 대상 서버의 이 애플리케이션 명령 목록을 갱신합니다.
이어서 **터미널 D**에서 봇을 계속 실행합니다.

```bash
pnpm dev:bot
```

`Discord bot connected.`를 확인하고 Discord 서버에서 `/status` 등 이 봇의 명령이 나타나는지 확인합니다.
`/status`를 실행할 때는 작업 ID가 필요합니다. 아직 작업이 없으면 다음 단계까지 진행한 뒤 사용하세요.

## 9. Codex CLI 로그인·실행 이미지 확인

**이 단계는 실제 코드를 실행할 개인 워커에서 진행합니다.**
같은 Ubuntu PC에서 전체를 실행한다면 계속 같은 저장소 폴더를 사용하면 됩니다.
다른 워커에 설치한다면 그 워커에도 소스·Node·pnpm·Docker·의존성을 준비하고 전용 `.env`를 설정해야 합니다.
다른 PC에서 API를 부를 때 `127.0.0.1`은 API 서버가 아니라 그 PC 자신입니다.
원격 `CONTROL_API_URL`은 HTTPS 주소를 사용하고, API 서버와 같은 `WORKER_ENROLLMENT_TOKEN`을 안전하게 제공하세요.
워커에 GitHub PEM이나 Discord 봇 토큰을 복사할 필요는 없습니다.

### ChatGPT 계정 로그인

```bash
npm install --global @openai/codex@0.163.0
codex --version
pnpm codex:login
```

버전은 `codex-cli 0.163.0`이어야 합니다.
CLI가 안내하는 페이지를 본인 브라우저에서 열어 ChatGPT 계정으로 로그인하고, 로그인 명령이 완료되기를 기다립니다.
일반 브라우저 로그인 방식이 필요하면 `pnpm codex:login --browser`를 사용합니다.
상태를 확인합니다.

```bash
pnpm codex:status
```

출력에 `ChatGPT login detected`가 있으면 전용 프로필의 로그인 정보를 확인한 것입니다.
이것만으로 실제 모델 호출 성공이나 사용 가능량까지 확인한 것은 아닙니다.

`.env`에 다음 모드를 지정합니다. 생략해도 기본값은 같습니다.

```dotenv
HUB_CODEX_AUTH_MODE=chatgpt
```

`HUB_CODEX_API_KEY`와 `HUB_CODEX_API_KEY_FILE`은 필요 없습니다.
기존 클라우드 환경 설정에 API 키 필수 항목이 남아 있다면 ChatGPT 모드에서는 제거하세요.
로그인은 기본 `.local/codex-auth`에 저장되며 Git이나 공유 환경 스냅샷에 포함하면 안 됩니다.

### 실행 이미지 빌드·호스트 검사

```bash
pnpm runner:build
docker image inspect hub-codex:0.163.0 --format '{{.Id}}'
pnpm runner:check
```

이미지 ID는 `sha256:`으로 시작하는 문자열입니다. **전체 값**을 복사해 `.env`에 넣습니다.

```dotenv
HUB_CODEX_IMAGE=sha256:여기에_실제_이미지_ID_전체
```

이 이미지는 Hub 앱을 실행하는 이미지가 아니라 **AI 작업 실행기 이미지**입니다.
`runner:check`의 정상 결과는 `{"ready":true,"reason":"OK"}`입니다.
이 검사는 `.env`에 지정한 이미지 ID를 우선 사용합니다. 임시로 다른 맞춤 이미지를 검사하려면 다음처럼 ID를 직접 전달할 수 있습니다.

```bash
HUB_CODEX_IMAGE=sha256:실제_맞춤_이미지_ID pnpm runner:check
```

`runner:check`는 루트 `.env`의 `HUB_CODEX_IMAGE`를 읽습니다. 비어 있으면 기본 태그의 로컬 이미지 ID를 찾습니다.
이미지를 재빌드했다면 `.env`의 기존 ID도 새 ID로 바꾸세요.
`NAMESPACE_SANDBOX_UNAVAILABLE`이면 그 호스트에서 Codex 내부 격리를 실행할 수 없습니다.
저장소의 정책 적용 여부, kernel namespace 설정과 LSM 제한을 확인하세요. 지원할 수 없는 호스트에서는 워커를 실행하지 않습니다.
원인별 확인 방법은 [Runner 보안·진단 안내](runner-security.md)에 있습니다.
AppArmor가 활성화되어 `BWRAP_MOUNT_DENIED`가 나오면 해당 안내의 전용 AppArmor 프로필 설치 절차를 진행하세요.
기본 Docker 프로필을 끄는 대신, 별도 프로필을 설치하고 `.env`에 `HUB_CODEX_APPARMOR_PROFILE=discord-hub-codex-v1`을 지정합니다.
Docker가 실행된다는 것과 Codex 내부 sandbox가 실행된다는 것은 별개입니다.

## 10. 워커 네트워크·프로젝트 테스트 준비 후 시작

다음 두 설정은 외부에서 발급받는 키가 아닙니다.

### `HUB_RUNNER_NETWORK` — 워커의 외부 접속 경로

운영자가 **Codex 인증·서비스에 필요한 접속만 허용**하도록 구성한 Docker 네트워크 이름입니다.
이름은 `hub-egress-`로 시작해야 합니다. ChatGPT 로그인 모드와 API 키 모드는 필요한 서비스 목적지가 다를 수 있습니다.
이미 준비된 네트워크가 있으면 이름을 설정하고 존재 여부를 확인합니다.

```dotenv
HUB_RUNNER_NETWORK=hub-egress-본인이_준비한_네트워크
```

```bash
docker network inspect hub-egress-본인이_준비한_네트워크
```

**이 저장소에는 접속 제한 네트워크를 자동으로 구성하는 기능이 아직 없습니다.**
네트워크를 만드는 명령 하나만으로는 목적지 제한이 적용되지 않습니다.
Docker 네트워크와 방화벽/egress proxy를 준비할 수 있는 운영자가 구성해야 하며,
설정하지 않은 상태에서 실제 워커 실행 단계가 완료되었다고 볼 수 없습니다.

### `WORKER_TEST_COMMAND` — AI 변경 후 실행할 검증 명령

대상 저장소에서 실제로 테스트를 수행하는 명령을 **JSON 배열**로 씁니다.
예를 들어 외부 의존성이 없는 Node 프로젝트가 `node --test`로 테스트된다면:

```dotenv
WORKER_TEST_COMMAND='["node","--test"]'
```

pnpm과 프로젝트 의존성을 준비한 맞춤 이미지에서 `pnpm test`를 실행하는 프로젝트라면:

```dotenv
WORKER_TEST_COMMAND='["pnpm","test"]'
```

둘 중 하나를 대상 프로젝트에 맞춰 선택합니다. `pnpm test`라는 문자열 하나로 쓰거나,
실제로 검증하지 않는 성공 명령을 넣지 마세요.
현재 허용하는 첫 실행 파일은 `node`, `npm`, `pnpm`, `python3`, `pytest`, `cargo`, `go`입니다.

**기본 `hub-codex:0.163.0` 이미지에는 Node와 Codex만 있으며 프로젝트의 도구·의존성을 자동 설치하지 않습니다.**
검증 컨테이너는 네트워크 없이 실행되므로 검증 중 `npm install` 등으로 내려받을 수 없습니다.
이 모노레포처럼 pnpm·프로젝트 패키지가 필요한 저장소는 그 도구와 의존성을 갖춘 맞춤 이미지/실행 준비가 필요합니다.
그 경우 `HUB_CODEX_IMAGE`에도 맞춤 이미지의 고정 ID를 지정합니다.

### 워커 시작

Codex 로그인, 이미지 ID, `runner:check`, 제한 네트워크, 실제 테스트 도구·의존성 준비가 모두 끝났으면
**터미널 E**에서 실행합니다.

```bash
pnpm dev:worker
```

대시보드의 **Worker fleet**에 `isolated-codex-worker`가 나타나고 `codex` 엔진과 ONLINE 상태를 확인합니다.
연결만 미리 확인하고 싶다면 다음 probe를 실행할 수 있습니다.

```bash
pnpm dev:worker --probe
```

probe는 등록·heartbeat·poll 통신만 확인합니다. Codex를 실행하지 않으며 실제 작업을 받을 엔진 능력을 광고하지 않습니다.
따라서 probe 워커가 보인다는 것만으로 실제 AI 실행 준비가 끝난 것은 아닙니다.

## 11. 첫 작업 요청·PR·사람 승인

### 실제 PR 쓰기를 켜기

앞 단계까지 준비한 뒤 API 서버의 `.env`에서 다음을 설정하고 **터미널 A의 API를 재시작**합니다.

```dotenv
GITHUB_MUTATIONS_ENABLED=true
```

이 설정은 실제 GitHub 브랜치·커밋·PR·병합 쓰기를 허용합니다. 우선 작은 테스트 저장소에서 확인하세요.
설정을 켠다고 PR이 자동으로 병합되지는 않습니다.

### 작업 요청

대시보드에서 저장소를 선택하고 작은 개발 요청을 작성한 뒤 **작업 생성**을 누릅니다.
Discord에서는 다음처럼 입력합니다. `repository`, `instruction`은 Discord가 표시하는 명령 옵션입니다.

```text
/develop repository:본인GitHub아이디/작업할저장소 instruction:기존 테스트를 유지하면서 작은 기능을 추가해 줘
```

정상 흐름은 `QUEUED → RUNNING → PR_OPEN`이며, 이후 CI·리뷰 상태에 따라 `CI_WAIT`, `APPROVAL_WAIT` 등으로 바뀝니다.
작업 상세 화면에서 단계별 기록과 PR 링크를 확인합니다.
워커가 없으면 `QUEUED`에서 기다리며, 별도 테스트가 실패하면 PR을 발행하지 않습니다.
현재 Discord 완료 스레드 알림은 구현되지 않았으므로 대시보드 또는 `/status job:작업ID`로 확인하세요.

### 승인·병합은 추가 설정 필요

PR 생성과 승인·병합은 서로 다른 단계입니다. 현재 자동 계정 연결 화면과 일반 사용자용 역할 관리 화면은 없습니다.
병합하려면 다음 조건을 운영자가 준비해야 합니다.

- 저장소 Rulesets에 필수 리뷰·체크를 설정하고 App을 우회 목록에 넣지 않음.
- 요청자와 승인자의 Hub 계정을 각각 `/identity/github` API로 실제 GitHub 계정에 연결.
- 승인자는 요청자와 다른 GitHub 사용자이며, 저장소의 reviewer/admin 역할과 실제 GitHub 리뷰 권한을 가짐.
- 해당 승인자가 GitHub에서 **현재 커밋에 Approve 리뷰**를 남김. `/approve`만 호출해서 GitHub 리뷰를 대신할 수 없음.
- 필수 체크가 성공하고 병합 App의 설치·권한이 올바름.

대시보드로 요청한 작업의 요청자 식별자는 `local-admin`, Discord로 요청한 경우는 `discord:사용자ID`입니다.
계정 연결은 실제 사용한 식별자에 해야 합니다. 두 경로는 자동으로 같은 사용자로 취급하지 않습니다.
구체적인 계정 연결·역할 등록 절차는 [승인·병합 설정](approval-setup.md)을 참고하세요.
설정이 끝나면 Discord의 `/approve job:작업ID`, `/merge job:작업ID`를 사용합니다.
현재 직접 병합 경로는 merge queue를 지원하지 않습니다.

## 12. 종료·다음 실행·업데이트

### 종료

각 서버 터미널에서 **Ctrl+C**를 누릅니다. DB·Redis도 멈추려면 저장소 폴더에서 실행합니다.

```bash
pnpm infra:stop
```

이 명령은 DB 데이터를 삭제하지 않습니다.

### 다음에 다시 켤 때

매번 처음부터 설치하거나 키를 새로 발급할 필요는 없습니다.

```bash
cd "$HOME/Discord-Auto-PR"
pnpm infra:up
```

이후 터미널 A·B·C의 API·스케줄러·대시보드 명령을 다시 실행합니다.
봇·실제 워커까지 설정했다면 D·E도 실행합니다. 정상 프로필이 있으면 Codex 로그인도 매번 할 필요가 없습니다.

### 소스 업데이트

실행 중인 앱·봇·워커를 먼저 종료하고, 로컬 코드 변경을 확인한 뒤 실행합니다.

```bash
git status
git pull --ff-only
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm build
```

그다음 서비스를 다시 시작합니다. `.env`와 `.local`은 Git 제외 경로라 pull로 새 설정을 자동 채우지는 않습니다.
릴리스 변경 안내와 `.env.example`에 새 설정이 생겼는지도 확인하세요.

## 자주 막히는 부분

| 증상                                             | 먼저 확인할 것                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `node`·`pnpm`을 찾을 수 없음                     | Node 설치 때 PATH 설정을 완료했는지, Windows가 아닌 Ubuntu 터미널인지 확인                     |
| Node 버전이 다름                                 | `node --version`, `command -v node` 확인. 새 터미널에도 PATH가 적용되어야 함                   |
| Docker daemon 연결 불가                          | Docker Desktop/Engine 실행, WSL Integration 설정 확인                                          |
| Docker permission denied                         | Ubuntu Docker 그룹 변경 후 다시 로그인. 워커를 sudo로 우회 실행하지 않음                       |
| 3000·3001·5432·6379 포트 사용 중                 | 같은 프로젝트나 로컬 DB가 이미 실행 중인지 확인. 알 수 없는 프로세스를 종료하지 말고 먼저 식별 |
| `.env`가 안 보임                                 | 숨김 파일임. 저장소 루트에서 `nano .env`로 열기                                                |
| API가 `Invalid API configuration`으로 종료       | 내부 토큰이 비어 있거나 32자 미만인지 확인. 역할별 토큰은 서로 달라야 함                       |
| 대시보드 로그인 실패                             | API `/readyz` 응답, `.env`의 `ADMIN_API_TOKEN`, 대시보드 재시작 확인                           |
| 저장소 선택 목록이 비어 있음                     | 7단계 seed, 실제 App 설치, DB migration 확인                                                   |
| `BUDGET_EXCEEDED`                                | 저장소 예산에서 이미 예약한 금액과 새 작업 예약액 확인. 임의로 예약 기록을 지우지 않음         |
| `REPOSITORY_NOT_INSTALLED`                       | `owner/repository` 등록과 실제 installation ID 확인                                            |
| `FORBIDDEN`·`REVIEWER_ROLE_REQUIRED`             | Discord 사용자 ID와 저장소별 developer/reviewer/admin 역할 확인                                |
| GitHub 401·403·404                               | App ID·PEM 쌍, 설치 대상 저장소, App 권한, GitHub 정책 확인                                    |
| Discord 명령이 없음                              | 봇 초대·대상 guild ID·`--register-commands` 성공 확인                                          |
| `ChatGPT login required`·로그인 미감지           | 같은 워커·일반 사용자로 `pnpm codex:login`, 이어서 `pnpm codex:status` 실행                    |
| Codex 프로필 잠금 오류                           | 같은 프로필을 쓰는 워커/로그인이 실행 중인지 확인. 종료가 확인된 오래된 잠금만 정리            |
| `NAMESPACE_SANDBOX_UNAVAILABLE`                  | seccomp·kernel·LSM 제한 확인. [Runner 진단 안내](runner-security.md) 참고                      |
| `Engine version, image or credentials not ready` | Codex 버전·이미지 ID·로그인·sandbox 검사·승인 네트워크를 순서대로 확인                         |
| 테스트에서 pnpm·pytest 등을 찾을 수 없음         | 기본 이미지에 해당 도구가 없음. 도구와 의존성을 갖춘 맞춤 이미지 준비                          |
| `QUEUED`에서 계속 대기                           | 실제 codex 워커 ONLINE 여부 확인. probe는 실행 워커가 아님                                     |
| `NEEDS_HUMAN_ACTION`                             | 작업 상세의 오류와 감사 기록을 확인. 같은 외부 쓰기를 무조건 반복하지 않음                     |

어디까지 검증되었는지는 [구현 상태와 한계](implementation-status.md),
각 환경변수의 발급 위치는 [README 키 발급표](../README.md#키-발급과-설정)를 확인하세요.
