# Discord AI PR Hub

Discord 요청을 격리 워커에 배정하고, 변경·PR·사람 승인·병합을 감사 가능한 작업으로 관리하는 TypeScript 모노레포입니다.
제어 API, Codex adapter/supervisor, GitHub App 연동 경로, 승인 정책과 Next.js 대시보드를 구현했습니다.
실계정 연동은 아직 검증하지 않았고 **현재 호스트에서는 Codex 내부 sandbox가 차단됩니다.** [구현 상태와 한계](docs/implementation-status.md)를 확인하세요.

## 처음 설치한다면 여기부터

**[설치부터 실행까지 따라 하는 가이드](docs/getting-started.md)**를 먼저 읽어 주세요.
Windows의 WSL2·Docker Desktop 준비, Ubuntu 도구 설치, Node·pnpm 설치부터
DB·대시보드·GitHub App·Discord 봇·Codex 워커 설정까지 순서대로 설명합니다.
각 단계의 성공 확인 방법, 종료·재실행 방법, 오류 해결표도 포함합니다.

처음에는 **대시보드 실행까지** 진행하면 됩니다. 이 단계에는 외부 서비스 키가 필요 없습니다.
Node.js 24, pnpm 10.20.0, Git, Docker + Compose v2를 준비한 Ubuntu/WSL 터미널에서:

```bash
git clone https://github.com/Duioolllll/Discord-Auto-PR.git
cd Discord-Auto-PR
pnpm install --frozen-lockfile
pnpm setup:local
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm build
```

이후 **서로 다른 터미널 3개**에서 아래 명령을 하나씩 실행합니다. 각 터미널의 현재 폴더는 저장소 루트여야 합니다.

| 터미널 | 실행 명령                             | 역할                          |
| ------ | ------------------------------------- | ----------------------------- |
| A      | `pnpm dev`                            | Control API, 로컬 3001번 포트 |
| B      | `pnpm --filter @hub/orchestrator dev` | 작업 상태·큐 관리             |
| C      | `pnpm --filter @hub/dashboard start`  | 웹 대시보드, 로컬 3000번 포트 |

[http://localhost:3000](http://localhost:3000)을 열고 `.env`의 **`ADMIN_API_TOKEN` 값만** 입력해 로그인합니다.
아직 저장소·워커 목록이 비어 있는 것은 정상입니다.
다음은 [GitHub 저장소 등록](docs/getting-started.md#7-작업할-저장소와-예산-등록),
[Discord 연결](docs/getting-started.md#8-discord-봇-연결),
[Codex 로그인](docs/getting-started.md#9-codex-cli-로그인실행-이미지-확인) 순서로 진행하세요.
PR 생성 후 사람 승인·병합을 연결하는 절차는 [별도 운영자 안내](docs/approval-setup.md)에 있습니다.

## 키 발급과 설정

**Codex는 ChatGPT 계정으로 로그인하므로 OpenAI API 키가 필요 없습니다.**
GitHub App·Discord 봇은 각 서비스에서 생성합니다. 이미지·네트워크·테스트 명령은 직접 지정하는 설정입니다.
대시보드 메인 화면의 **키 발급·설정 안내**에서도 로그인 전후에 같은 설정 순서를 확인할 수 있습니다.

### 어디서 발급하나요?

| 환경변수                            | 발급·확인 위치 / 입력할 값                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                     | [GitHub Apps](https://github.com/settings/apps) → 개발 App → General → **App ID**                                                                  |
| `GITHUB_APP_PRIVATE_KEY_FILE`       | 개발 App → Private keys → **Generate a private key** → 다운로드한 PEM 파일의 절대 경로                                                             |
| `GITHUB_MERGE_APP_ID`               | 별도로 만든 병합 App → General → **App ID**                                                                                                        |
| `GITHUB_MERGE_APP_PRIVATE_KEY_FILE` | 병합 App에서 다운로드한 PEM 파일의 절대 경로                                                                                                       |
| `GITHUB_WEBHOOK_SECRET_FILE`        | 직접 생성한 32자 이상 임의 문자열을 저장한 파일의 절대 경로. GitHub 개발 App의 Webhook secret에도 같은 값 입력                                     |
| `DISCORD_BOT_TOKEN_FILE`            | [Discord Developer Portal](https://discord.com/developers/applications) → 애플리케이션 → Bot → **Reset Token** → 토큰을 저장한 파일의 절대 경로    |
| `DISCORD_APPLICATION_ID`            | Discord 애플리케이션 → General Information → **Application ID**                                                                                    |
| `DISCORD_GUILD_ID`                  | Discord 개발자 모드 활성화 → 대상 서버 우클릭 → **서버 ID 복사**                                                                                   |
| `DISCORD_ADMIN_USER_IDS`            | 관리자 사용자 우클릭 → **사용자 ID 복사**. 여러 명은 공백 없이 쉼표로 구분                                                                         |
| `HUB_CODEX_API_KEY_FILE`            | **ChatGPT 로그인에서는 비워 둠.** 선택형 `api-key` 모드에서만 [OpenAI API keys](https://platform.openai.com/api-keys)에서 생성한 키 파일 경로 지정 |
| `HUB_CODEX_IMAGE`                   | `pnpm runner:build` 후 `docker image inspect hub-codex:0.163.0 --format '{{.Id}}'`로 얻은 `sha256:…` 이미지 ID                                     |
| `HUB_RUNNER_NETWORK`                | 운영자가 Codex 접속 목적지 제한을 구성한 `hub-egress-*` Docker 네트워크 이름                                                                       |
| `WORKER_TEST_COMMAND`               | 대상 저장소의 테스트 명령을 JSON 배열로 입력. 예: `["pnpm","test"]`                                                                                |

`*_FILE`에는 키 내용이나 다운로드 URL이 아니라 **실행 서버에서 읽을 수 있는 파일의 절대 경로**를 넣습니다.
App ID·Application ID·서버 ID는 식별자이며, PEM·봇 토큰·웹훅 secret은 비밀값입니다.

### 1. 실행 서버에 설정 저장

의존성 설치 후 저장소 폴더에서 `pnpm setup:local`을 실행하세요.
기존 `.env`를 보존하며, 새 환경에서는 내부 역할별 토큰과 웹훅 secret을 생성하고 대시보드 세션 키를 준비합니다.
외부 연동 항목은 [.env.example](.env.example)을 참고해 로컬 `.env`에 추가하세요.
이미 설정한 `.env`를 예제 파일로 덮어쓰지 마세요.

- 대시보드 로그인: `.env`의 **`ADMIN_API_TOKEN`** 값 사용.
- `BOT_API_TOKEN`: Discord 봇이 Control API에 접근하는 내부 토큰. **Discord 봇 토큰과 다릅니다.**
- `WORKER_ENROLLMENT_TOKEN`: 워커 등록용 내부 토큰.
- `DASHBOARD_SESSION_SECRET`: 대시보드 쿠키 암호화용 내부 키.

비밀 파일은 전용 디렉터리에 보관하고 디렉터리는 `0700`, 파일은 `0600`으로 설정하세요.
예를 들어 `GITHUB_APP_PRIVATE_KEY_FILE=/absolute/private-secrets/github-dev.pem`처럼 지정합니다.
클라우드에서는 런타임 secret 마운트로 파일을 제공하고 환경변수에는 마운트 경로를 넣습니다.
키를 환경변수 값으로 넣는 입력란과 파일을 제공하는 기능은 다릅니다. 경로만 설정해도 파일이 자동 생성되지는 않습니다.
변경 후 해당 API·봇·워커·대시보드 서비스를 재시작하세요.

### 2. GitHub App 두 개 생성

1. [New GitHub App](https://github.com/settings/apps/new)에서 **개발용 App**과 **병합용 App**을 각각 만듭니다.
   조직 소유 App은 조직 Settings → Developer settings → GitHub Apps에서 생성합니다.
2. 각 App의 **App ID**와 **Private keys → Generate a private key**에서 다운로드한 PEM을 위 표의 항목에 연결합니다.
   OAuth Client ID·Client secret을 넣는 항목이 아닙니다.
3. Repository permissions를 다음과 같이 설정합니다. Metadata 읽기는 GitHub가 기본 부여합니다.

   | App    | Repository permissions                                                                                 |
   | ------ | ------------------------------------------------------------------------------------------------------ |
   | 개발용 | Contents: Read and write, Pull requests: Read and write, Checks: Read-only, Commit statuses: Read-only |
   | 병합용 | Contents: Read and write, Pull requests: Read-only                                                     |

4. 개발 App의 Webhook URL에 **`https://공개-API-주소/webhooks/github`**를 입력합니다.
   GitHub에서 접근할 수 있는 HTTPS 주소가 필요하며 `localhost`는 사용할 수 없습니다.
   Webhook secret은 `setup:local`로 생성된 `GITHUB_WEBHOOK_SECRET`을 사용하거나 별도 임의 문자열을 생성합니다.
   GitHub 입력값과 API가 읽는 값은 같아야 합니다. 파일 방식이면 그 값을 파일에 보관하고 `GITHUB_WEBHOOK_SECRET_FILE`을 지정하세요.
   파일 설정이 있으면 인라인 `GITHUB_WEBHOOK_SECRET`보다 우선합니다.
   **Pull request, Check run, Check suite, Status** 이벤트를 구독합니다. 병합 App의 웹훅은 사용하지 않습니다.
5. 두 App에서 **Install App → 대상 계정 → Only select repositories**로 작업 대상 저장소에 설치합니다.
   설치 설정 URL의 `/installations/숫자`가 installation ID이며 App ID와 다릅니다.
6. 아래처럼 실제 개발·병합 installation ID로 저장소를 등록합니다. 예시 식별자는 실제 값으로 바꾸세요.

   ```sh
   SEED_REPOSITORY=owner/repository \
     SEED_INSTALLATION_ID=개발_App_설치_ID \
     SEED_MERGE_INSTALLATION_ID=병합_App_설치_ID \
     SEED_BUDGET_CENTS=1000 \
     SEED_DISCORD_USER_ID=본인_Discord_사용자_ID pnpm db:seed
   ```

7. 저장소 Settings → Rules → Rulesets에서 필수 리뷰·체크를 구성합니다.
   두 App을 규칙 우회 대상으로 추가하지 마세요. 실제 PR 쓰기를 활성화할 때만 `GITHUB_MUTATIONS_ENABLED=true`로 설정합니다.

GitHub 앱 설치만으로 요청자·승인자 계정 연결이나 역할이 등록되지는 않습니다.
위 seed는 지정한 Discord 사용자에 해당 저장소의 developer 역할을 부여합니다.
승인·병합에는 추가 역할 설정, 서로 다른 사용자의 `/identity/github` 계정 검증과 현재 SHA의 사람 리뷰가 필요합니다.
현재 UI에는 공개 OAuth 계정 연결 화면이 없습니다. 자세한 구현 범위는 [구현 상태](docs/implementation-status.md)를 확인하세요.

### 3. Discord 봇 생성·초대

1. [Developer Portal](https://discord.com/developers/applications) → **New Application**을 만듭니다.
2. **General Information → Application ID**를 `DISCORD_APPLICATION_ID`에 입력합니다.
3. **Bot → Reset Token**에서 발급한 값을 비공개 파일에 저장하고 `DISCORD_BOT_TOKEN_FILE`에 경로를 지정합니다.
4. **OAuth2 → URL Generator**에서 `bot`, `applications.commands`를 선택하고 **View Channels, Send Messages** 권한으로 대상 서버에 초대합니다.
   현재 봇은 Guilds intent만 사용하므로 Message Content Intent를 켤 필요가 없습니다.
5. Discord 앱의 **사용자 설정 → 고급 → 개발자 모드**를 켜고 서버·사용자 우클릭 메뉴에서 ID를 복사합니다.
   각각 `DISCORD_GUILD_ID`, `DISCORD_ADMIN_USER_IDS`에 입력합니다.
6. 설정 후 명령을 등록하고 봇을 시작합니다. 등록 명령은 해당 서버의 기존 애플리케이션 명령 목록을 갱신합니다.

   ```sh
   pnpm --filter @hub/discord-bot dev --register-commands
   pnpm dev:bot
   ```

### 4. Codex CLI 로그인·워커 설정

개인 Linux/WSL 워커에 **Codex CLI 0.163.0**을 설치하고 저장소 폴더에서 실행합니다.

```sh
npm install --global @openai/codex@0.163.0
pnpm codex:login
pnpm codex:status
```

CLI가 안내하는 페이지에서 ChatGPT 계정으로 로그인하세요. 기본값은 `HUB_CODEX_AUTH_MODE=chatgpt`입니다.
`HUB_CODEX_API_KEY_FILE`은 비워 두고, 클라우드 환경 설정에 이전 API 키 필수 항목이 남아 있으면 삭제하세요.
다른 전용 로그인 폴더를 쓰려면 `HUB_CODEX_AUTH_DIR`에 절대 경로를 지정합니다.
계정의 Codex 사용 권한·한도가 적용되며, 로그인 확인만으로 모델 호출 성공을 보장하지는 않습니다.

`pnpm runner:build`로 실행 이미지를 준비하고 위 표대로 `HUB_CODEX_IMAGE`를 지정하세요.
`HUB_RUNNER_NETWORK`는 접속 목적지를 제한한 네트워크가 필요합니다. `docker network create`로 이름만 만드는 것으로 제한이 적용되지는 않습니다.
`WORKER_TEST_COMMAND`는 운영자가 대상 저장소에 맞춰 정하며, 실행 이미지에 해당 도구와 의존성이 있어야 합니다.
`pnpm runner:check`가 성공한 호스트에서만 `pnpm dev:worker`를 실행하세요.
**현재 클라우드 호스트는 namespace sandbox를 지원하지 않아 실제 Codex 작업에는 별도 호환 워커/VM이 필요합니다.**

API 키 인증을 선택할 때만 `HUB_CODEX_AUTH_MODE=api-key`와 `HUB_CODEX_API_KEY_FILE`을 설정합니다.
키·PEM·`.env`·Codex 로그인 폴더는 Git, 채팅, 공유 이미지나 환경 스냅샷에 포함하지 마세요.

## 개발 환경

Node.js 24 (`.node-version`), pnpm 10.20.0/Corepack, Docker Engine + Compose v2가 필요합니다.
클라우드 작업은 이미 격리되므로 기존 체크아웃을 사용하고 별도 Git worktree를 만들지 않습니다.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm setup:local
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm build
```

클라우드의 저장된 install script는 `/workspace` 아래의 쓰기 가능한 Corepack/npm/pnpm cache를 사용합니다.
`setup:local`은 기존 `.env`와 그 값을 보존하며, 없을 때 로컬 역할별 token을 생성합니다.
대시보드 session key가 없으면 그 항목만 추가합니다. 외부 인증 정보를 만들거나 출력하지 않습니다.
PostgreSQL/Redis는 loopback으로만 열립니다. Compose의 고정 DB 암호는 개발 전용입니다.

각각 별도 터미널에서:

```sh
pnpm dev
pnpm --filter @hub/orchestrator dev
pnpm --filter @hub/dashboard start
```

API readiness는 내부 요청 `curl --fail http://127.0.0.1:3001/readyz`로 확인합니다.
`/healthz`는 liveness, `/readyz`는 PostgreSQL 쿼리와 Redis PING입니다.
워커 통신만 확인하려면 `pnpm dev:worker --probe`를 사용합니다. probe는 엔진을 광고하거나 코드를 실행하지 않습니다.
UI는 설정된 Control API token으로 로그인하며 token 값은 채팅/로그로 출력하지 마세요.
UI 수정 중에는 `pnpm dev:dashboard`를 사용합니다. API·scheduler·UI 프로세스는 새 작업에서 다시 시작해야 합니다.
`pnpm infra:stop`은 개발 데이터를 삭제하지 않고 DB/Redis를 중지합니다.

## 검증

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm audit --audit-level=high
pnpm build
HUB_PACKAGED_CHROMIUM=true pnpm test:e2e
```

DB 테스트와 browser 테스트는 **순서대로** 실행하세요. 둘 다 별도로 보호된 loopback `hub_test` DB를 사용합니다.
통합 테스트가 사용하는 Node Docker 이미지는 다음과 같이 준비합니다.

```sh
docker pull node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
```

통합 테스트는 명령/웹훅 중복, 권한, 예산 경쟁, fencing/취소/만료, PR 복구,
SHA/CI 병합 차단, outbox/dead-letter와 실제 Docker 제한을 검증합니다.
전체 supervisor→PR→승인→Merge 테스트는 fake agent/GitHub와 실제 HTTP/PostgreSQL/Redis를 사용합니다.
Browser E2E는 production Next 빌드에서 로그인·작업 생성·취소·모바일·로그아웃을 확인합니다.
packaged Chromium 대신 표준 Playwright browser를 설치한 환경에서는 해당 환경변수 없이 실행할 수 있습니다.
테스트가 통과해도 실제 외부 계정·모델 E2E가 검증된 것은 아닙니다.

## 저장소·봇·GitHub App

기본 DB에는 작업 대상 저장소가 없습니다. 실제 App 설치를 확인한 뒤 운영자가 등록합니다.

```sh
SEED_REPOSITORY=owner/repository SEED_INSTALLATION_ID=12345 \
  SEED_BUDGET_CENTS=1000 SEED_DISCORD_USER_ID=123456789012345678 pnpm db:seed
```

설치 ID를 임의로 채우면 GitHub 연동이 되지 않습니다. API의 실제 installation-scoped read로 다시 확인합니다.
예산이 없거나 부족하면 작업 생성을 402로 거절합니다. 대시보드 또는 관리자 budget API에서 한도를 설정할 수 있습니다.
계정·설치·키 항목은 [.env.example](.env.example)을 참조하세요.
개발 App과 병합 App은 서로 다른 App ID와 installation ID를 사용하며, 병합 installation은 `SEED_MERGE_INSTALLATION_ID`로 등록합니다.
App key는 raw 환경변수 또는 `*_PRIVATE_KEY_FILE`로 가리키는 secret-manager 파일에서 읽습니다.
로컬 서명/HMAC, Discord Gateway token, 선택형 모델 API key에는 HTTPS proxy placeholder만으로 인증할 수 없습니다.
키 값을 저장소·채팅에 넣지 말고 안전한 런타임 secret 공급 방식을 사용하세요.

`GITHUB_MUTATIONS_ENABLED`는 기본 false입니다. 실제 쓰기를 사용할 때만 운영자가 true로 설정합니다.
작업 요청자/승인자는 `/identity/github`로 검증한 서로 다른 GitHub ID여야 합니다.
이 API는 사용자 token을 검증에만 쓰고 저장하지 않습니다. 완전한 OAuth 로그인 UI는 후속 범위입니다.
승인에는 GitHub의 현재 SHA에 대한 사람 리뷰가 필요하고, 병합은 SHA·RBAC·리뷰·체크·현재 GitHub 정책을 재조회합니다.
GitHub branch protection/Rulesets 및 필수 리뷰를 별도로 설정해야 하며 Discord 승인으로 대체하지 않습니다.

Discord 사용에는 bot token/application/guild 설정과 저장소 RoleBinding이 필요합니다.
관리자 명령은 서버 설정의 `DISCORD_ADMIN_USER_IDS` 또는 적절한 서버 역할로 제한합니다.
운영자가 명시적으로 명령을 등록할 때:

```sh
pnpm --filter @hub/discord-bot dev --register-commands
pnpm dev:bot
```

지원 명령: `/develop`, `/refactor`, `/status`, `/logs`, `/workers`, `/cancel`, `/approve`, `/merge`, `/cost`.
아직 `/fix` 이슈 수집과 PR 대상 `/review`, 완료 스레드 알림은 구현하지 않았습니다.

## 실제 Codex 워커

기본 인증은 **Codex CLI의 ChatGPT 계정 로그인**입니다. OpenAI API key는 필수가 아닙니다.
개인 Linux/WSL 워커에 Codex CLI 0.163.0을 설치한 뒤 다음을 실행합니다.

```sh
pnpm codex:login
pnpm codex:status
```

`codex:login`은 공식 `codex login --device-auth`를 실행하며, 안내된 페이지에서 본인이 로그인합니다.
로컬 브라우저 로그인이 필요한 경우 `pnpm codex:login --browser`를 사용합니다.
로그인 프로필은 기본 `.local/codex-auth`에 만들고, 다른 전용 프로필은 절대 경로 `HUB_CODEX_AUTH_DIR`로 선택합니다.
CLI가 PATH에 없으면 `HUB_CODEX_CLI`에 설치된 실행 파일의 경로를 지정하세요.
부모 프로세스의 Codex 로그인이나 API/GitHub key를 자동으로 가져오거나 복사하지 않습니다.
OS keyring에만 저장된 로그인은 컨테이너에서 읽을 수 없으므로 helper가 지정한 file-backed 전용 프로필에서 로그인해야 합니다.

로그인 폴더는 OAuth token 갱신을 위해 AI 실행기에만 읽기/쓰기로 연결합니다. 별도 테스트 컨테이너에는 전달하지 않습니다.
폴더는 worker 소유 0700, `auth.json`은 외부 사용자에게 공개되지 않은 일반 파일이어야 합니다.
프로필은 한 워커/로그인 프로세스만 사용하도록 잠급니다. 종료 후 남은 `.hub-profile.lock`은 실행 중인 프로세스가 없는지 확인한 뒤에만 정리하세요.
로그인 프로필에는 인증 정보가 있으므로 **개인 워커에서 로그인하고, Git·공유 이미지·클라우드 환경 스냅샷에 포함하지 마세요.**
환경 설치 스크립트는 로그인을 실행하거나 로그인 파일을 복사하지 않습니다.

```sh
pnpm runner:build
pnpm runner:check
```

빌드는 공식 `@openai/codex@0.163.0-linux-x64` npm 아티팩트의 고정 SHA-512를 확인하고 네트워크 없이 이미지를 조립합니다.
`runner:check`는 버전과 실제 내부 namespace sandbox를 검사합니다. 현재 클라우드 호스트에서는 exit 2 /
`NAMESPACE_SANDBOX_UNAVAILABLE`이므로 **실제 워커를 시작하지 않습니다.** 호환되는 전용 워커/VM이 필요합니다.

실행 가능한 호스트에서는 immutable `HUB_CODEX_IMAGE` image ID, 로그인된 전용 Codex 프로필, 운영자가 제한한
`HUB_RUNNER_NETWORK=hub-egress-...`, 그리고 `WORKER_TEST_COMMAND` JSON argv를 구성해야 합니다.
ChatGPT 모드의 egress는 Codex의 ChatGPT 인증/서비스 경로도 허용해야 하며 API key 모드의 API 목적지만 허용한 설정과 다를 수 있습니다.
테스트 argv는 node/npm/pnpm/python3/pytest/cargo/go allowlist 중 운영자가 정한 명령이며 요청자가 선택하지 않습니다.
필요한 프로젝트 도구·의존성이 준비된 이미지를 사용하세요. 검증 명령에는 모델/GitHub 자격증명을 전달하지 않습니다.
제약을 완화하거나 내부 sandbox를 우회하는 옵션을 사용하지 않습니다.

조건이 충족된 호스트에서만 `pnpm dev:worker`를 실행합니다.
엔진 결과와 독립 테스트 명령이 모두 성공해야 변경을 API에 제출합니다. 워커는 GitHub 쓰기 token을 받지 않습니다.
외부 PR 발행이 불확실하면 자동 재실행하지 않고 감사 기록과 함께 운영자 복구를 기다립니다.

API key를 사용할 때만 `HUB_CODEX_AUTH_MODE=api-key`와 `HUB_CODEX_API_KEY_FILE` 또는 `HUB_CODEX_API_KEY`를 설정합니다.
ChatGPT 모드에서는 이 key 항목을 읽지 않습니다. ChatGPT 계정의 Codex 사용 권한/한도를 따르며, API key 모드는 별도 API 사용료 체계입니다.
앱의 USD 예산 예약은 두 모드 모두 적용되는 운영 정책으로, 실제 API 청구액이라는 뜻은 아닙니다.
CLI 로그인 확인은 계정의 현재 사용 가능량이나 모델 호출 성공을 검증한 것이 아닙니다.
공식 인증 안내: https://developers.openai.com/codex/auth/.

## 구조와 운영

- `apps/`: Control API, Discord Bot, Orchestrator/Scheduler, Worker Supervisor, Next.js Dashboard.
- `packages/`: Zod 계약, Prisma, 정책, GitHub App, BullMQ, Agent 인터페이스와 Codex adapter.
- `infra/`: digest-pinned 개발 DB/Redis Compose, Codex runner Dockerfile.
- `tests/`: 단위·실제 DB/HTTP/Docker 통합·browser E2E.

실제 청구, token 추정, 실행 시간 추정을 분리합니다. 예약은 운영자가 증빙으로 정산할 때까지 유지합니다.
Docker volume/로컬 파일은 운영 백업이 아닙니다. 공개 운영·다중 엔진·자동 수정 루프·autoscale 및 미완료 범위는
[구현 상태](docs/implementation-status.md)를 참조하세요.
