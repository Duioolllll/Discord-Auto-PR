# Discord Codex CLI PR Hub

Discord 또는 대시보드의 개발 요청을 **ChatGPT로 로그인한 Codex CLI**가 격리 컨테이너에서 실행합니다. 독립 테스트가 성공한 변경으로 PR을 만들고, 사람 리뷰·현재 커밋·필수 CI를 확인한 뒤 병합합니다.

모델 API 키·예산·비용 정산을 사용하지 않는 새 설치용 빌드입니다. 내부 Control API는 서비스 인증·작업 배정·로그·GitHub 연동을 담당합니다. 기존 DB를 복사하거나 변환하지 않습니다.

## 빠른 시작

Linux x64 일반 사용자, Docker Engine + Compose v2, **Node 24.22.1 LTS · pnpm 12.15.0**이 필요합니다. Codex CLI는 **0.164.0**으로 고정합니다. Windows/WSL 또는 도구 설치부터 필요하면 [처음 설치하기](docs/getting-started.md)를 따르세요.

새 체크아웃과 빈 DB를 기준으로 저장소 루트에서 실행합니다.

```bash
git clone https://github.com/Duioolllll/Discord-Auto-PR.git
cd Discord-Auto-PR
pnpm install --frozen-lockfile
pnpm setup:local
pnpm infra:up
pnpm db:generate
pnpm db:init
pnpm config:check
pnpm build
```

각각 별도 터미널에서 서비스를 실행합니다.

| 실행 명령                             | 역할 / 로컬 주소                     |
| ------------------------------------- | ------------------------------------ |
| `pnpm dev`                            | Control API, `http://127.0.0.1:3001` |
| `pnpm --filter @hub/orchestrator dev` | 작업 상태·PR 동기화·outbox           |
| `pnpm --filter @hub/dashboard start`  | 대시보드, `http://localhost:3000`    |

대시보드 로그인에는 `.env`의 **`ADMIN_API_TOKEN` 값만** 입력합니다. 여기까지는 외부 계정 키가 필요 없습니다. 저장소와 워커 목록이 비어 있는 상태에서 시작합니다.

개발 PostgreSQL은 `127.0.0.1:5433/hub_cli`, Redis는 `127.0.0.1:6380`입니다. 전용 테스트 DB는 `hub_cli_test`입니다. `db:init`은 빈 DB 또는 같은 CLI 초기 스키마만 허용하며 다른 기존 DB는 변경 없이 거절합니다. 서버 터미널은 Ctrl+C로 종료하고, DB·Redis는 `pnpm infra:stop`으로 데이터 삭제 없이 중지합니다.

## 키 발급과 설정

**[연동 설정 안내표](docs/integration-settings.md)**에서 값의 발급 위치·사용처·파일 우선순위·재시작 대상을 확인하세요. `setup:local`은 누락된 로컬 설정과 내부 토큰만 준비하며, 기존 비어 있지 않은 값과 외부 키는 보존합니다.

| 연결           | 준비할 것                                                                | 진행 문서                                                      |
| -------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Discord        | Developer Portal의 Bot 토큰·서버, API와 같은 내부 `BOT_API_TOKEN`        | [Discord 빠른 연결](docs/discord-quickstart.md)                |
| GitHub         | 별도 개발·병합 App의 ID·PEM·설치, 대상 저장소·사용자 역할                | [설치 6~7단계](docs/getting-started.md#6-github-app과-키-설정) |
| Codex CLI      | 워커 전용 ChatGPT 로그인 프로필·고정 이미지·제한 네트워크·실제 검증 명령 | [CLI 실행 구조](docs/cli-execution.md)                         |
| 사람 승인·병합 | 서로 다른 요청자·승인자의 GitHub 연결·reviewer 역할·현재 SHA 리뷰        | [승인 설정](docs/approval-setup.md)                            |

`*_FILE`에는 비밀값 내용이나 URL 대신 **실행 서버에서 읽을 수 있는 파일의 절대 경로**를 넣습니다. `.env`·PEM·봇 토큰·CLI 로그인 폴더는 Git·채팅·공유 이미지에 넣지 마세요.

설정 검사: `pnpm config:check`, `pnpm config:check --scope discord|github|merge|worker`에서 범위 하나를 선택합니다. 값은 출력하지 않으며 실제 원격 연결·모델 실행 준비는 문서의 단계별 검사로 확인합니다.

## Discord와 CLI 워커

Discord는 다음 순서로 연결합니다. GitHub·워커 준비 전에도 `/help`를 사용할 수 있습니다.

```bash
pnpm discord:setup
pnpm dev:bot
```

봇은 시작할 때 명령을 자동 등록합니다. 목록이나 연결에 문제가 있으면 `pnpm discord:check`를 실행하세요. 지원 명령은 `/help`, `/ping`, `/develop`, `/refactor`, `/status`, `/logs`, `/workers`, `/cancel`, `/approve`, `/merge`입니다. 읽기 전용 `/review`, 이슈 대상 `/fix`, 완료 스레드 알림은 아직 구현하지 않았습니다.

실제 워커 컴퓨터에서 전용 CLI 프로필을 준비합니다.

```bash
pnpm codex:login
pnpm codex:status
pnpm runner:build
```

빌드한 이미지 ID를 `HUB_CODEX_IMAGE`에, 운영자가 접속 목적지를 제한한 Docker 네트워크를 `HUB_RUNNER_NETWORK`에, 검증 명령의 JSON argv를 `WORKER_TEST_COMMAND`에 지정합니다. 기본 이미지에 모든 프로젝트 도구·의존성이 들어 있지는 않습니다.

```bash
pnpm config:check --scope worker
pnpm runner:check
pnpm dev:worker
```

`runner:check`의 정상 결과는 `{"ready":true,"reason":"OK"}`입니다. Docker 실행 가능 여부·CLI 로그인·실제 내부 격리는 각각 확인해야 합니다. 워커는 일반 사용자로 실행하며, 독립 검증 컨테이너는 CLI 로그인과 GitHub 자격증명을 받지 않습니다. [네트워크·이미지·검증 명령 준비](docs/getting-started.md#10-워커-네트워크프로젝트-테스트-준비-후-시작)를 마친 뒤 실제 작업을 요청하세요.

## 검증

먼저 [검증용 고정 이미지](docs/toolchain.md#검증-명령)를 준비합니다. 통합 테스트와 브라우저 테스트는 전용 `hub_cli_test` DB를 공유하므로 순서대로 실행합니다.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm security:check
pnpm toolchain:check
pnpm test
pnpm test:integration
pnpm build
HUB_PACKAGED_CHROMIUM=true pnpm test:e2e
```

테스트는 실제 PostgreSQL·Redis·HTTP·Docker와 모의 agent/GitHub를 사용합니다. 실제 외부 계정·모델 호출·원격 PR·병합의 성공을 뜻하지는 않습니다. 컨테이너의 메모리·CPU·PID·시간·출력 제한을 적용하지만 하드 디스크 quota나 VM 수준 격리는 제공하지 않습니다.

## 문서

| 문서                                            | 내용                                            |
| ----------------------------------------------- | ----------------------------------------------- |
| [처음 설치하기](docs/getting-started.md)        | Ubuntu·WSL 준비부터 대시보드·첫 PR까지 순서대로 |
| [CLI 실행 구조](docs/cli-execution.md)          | 새 DB·초기 스키마·CLI 실행·작업 계약            |
| [연동 설정](docs/integration-settings.md)       | 키·ID·파일 경로, 단계별 검사와 서비스별 사용처  |
| [Discord 빠른 연결](docs/discord-quickstart.md) | 토큰 입력·초대·명령·권한 문제 해결              |
| [승인·병합](docs/approval-setup.md)             | 사람 계정 연결·reviewer 역할·현재 SHA 승인      |
| [Runner 보안](docs/runner-security.md)          | seccomp·AppArmor·격리 경계·실패 진단            |
| [도구 버전](docs/toolchain.md)                  | 고정 버전·설치·업데이트·검증 명령               |
| [구현 상태](docs/implementation-status.md)      | 구현 범위·실계정 검증과 운영의 남은 범위        |
| [코드 검토·수정](docs/code-review.md)           | 이번 검토의 확인 항목·수정·회귀 검사            |

소스는 `apps/`의 서비스, `packages/`의 계약·DB·정책·GitHub·CLI adapter, `infra/`의 개발 인프라·격리 정책, `tests/`의 단위·통합·브라우저 검사로 구성합니다.
