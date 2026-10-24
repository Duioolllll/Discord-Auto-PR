# Discord AI PR Hub

Discord 요청을 격리 워커에 배정하고, 변경·PR·사람 승인·병합을 감사 가능한 작업으로 관리하는 TypeScript 모노레포입니다.
제어 API, Codex adapter/supervisor, GitHub App 연동 경로, 승인 정책과 Next.js 대시보드를 구현했습니다.
실계정 연동은 아직 검증하지 않았고 **현재 호스트에서는 Codex 내부 sandbox가 차단됩니다.** [구현 상태와 한계](docs/implementation-status.md)를 확인하세요.

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
