# Discord를 가장 먼저 연결하기

**봇 토큰 한 번 입력 → 서버 선택 → 봇 실행** 순서입니다.
GitHub App·Codex·워커가 아직 없어도 Discord 명령 목록과 `/help`부터 확인할 수 있습니다.

`BOT_API_TOKEN`과 Discord Bot 토큰, 서버·사용자 ID가 헷갈리면 [연동 설정 안내](integration-settings.md#4-discord--bot-토큰-한-번만-직접-입력)를 확인하세요.
`pnpm config:check --scope discord`는 값 노출·외부 요청 없이 설정 형식과 파일을 확인하고, `pnpm discord:check`는 실제 연결을 점검합니다.

## 1. 봇 토큰 준비

[Discord Developer Portal](https://discord.com/developers/applications)에서 사용할 앱을 열거나 **New Application**으로 만듭니다.
**Bot → Reset Token**에서 받은 토큰을 준비하세요. Application ID나 Client Secret을 복사하는 것이 아닙니다.
토큰은 채팅이나 명령 인자에 붙여 넣지 않습니다.

## 2. 연결 도우미 실행

`Command "discord:setup" not found`라면 실행 중인 저장소의 `package.json`이 이전 버전입니다.
`FULL TURBO` 빌드 성공은 새 스크립트를 받았는지 확인하는 검사가 아닙니다.
먼저 `git status --short`로 로컬 수정 파일을 확인하고 `git pull --ff-only`로 갱신하세요.
pull이 로컬 수정 때문에 중단되면 필요한 **소스 파일만** 명시적으로 보관한 뒤 다시 진행합니다.
예를 들어 수정된 파일이 Runner의 `index.ts` 하나라면:

```bash
git stash push -m "runner-local-before-update" -- packages/agent-codex/src/index.ts
git pull --ff-only
```

이 명령은 지정한 추적 소스 파일의 변경을 보관합니다. `.env`·키·편집기 swap 파일은 Git에 추가하지 마세요.
이전 Runner 변경은 최신 보안 수정과 비교한 뒤 필요한 부분만 복구합니다. 업데이트 직후 자동으로 전체 stash를 적용할 필요는 없습니다.

다음으로 LTS 도구를 활성화합니다. Node 26 Current나 예전 pnpm이 PATH에 남아 있을 때도 이 순서로 갱신할 수 있습니다.

```bash
node --use-env-proxy scripts/setup-node.mjs
source .local/activate-toolchain.sh
pnpm install --frozen-lockfile
pnpm toolchain:check
node -p "Object.hasOwn(require('./package.json').scripts, 'discord:setup')"
```

버전 검사 성공과 마지막 명령의 `true`를 확인한 뒤 진행하세요.
`false`면 아직 해당 명령이 포함된 소스를 받지 못한 것입니다. [버전 업데이트 안내](toolchain.md)도 참고하세요.

Ubuntu/WSL 터미널에서 저장소 폴더로 이동합니다. 기존 봇이 실행 중이라면 먼저 Ctrl+C로 종료하세요.
최신 코드가 아니라면 `git pull --ff-only`, `pnpm install --frozen-lockfile`을 먼저 실행합니다.

```bash
cd ~/Discord-Auto-PR
pnpm discord:setup
```

화면 안내를 따라 진행합니다.

1. 봇 토큰을 붙여 넣습니다. **입력 중 문자가 안 보이는 것이 정상**입니다. 기존 설정이 있으면 그대로 사용할 수 있습니다.
2. Application ID는 토큰으로 자동 확인합니다.
3. 표시된 초대 링크를 브라우저에서 열어 원하는 서버에 봇을 추가합니다. `bot`과 `applications.commands` 권한이 포함되어 있습니다.
4. 터미널에 돌아와 서버 목록에서 번호를 선택합니다. 목록에 없다면 초대 후 Enter로 다시 조회합니다. 서버 ID를 직접 입력할 수도 있습니다.
5. 본인 Discord 사용자 ID는 선택 사항입니다. 입력하면 API 인증과 본인의 저장소 목록을 확인합니다. **관리자 권한을 부여하지 않습니다.**
6. 서버 명령을 등록하고 실제 등록된 목록을 다시 조회합니다. GitHub PR이나 작업을 생성하지 않습니다.

없는 서버를 선택하거나 사용자 ID를 잘못 입력하면 다시 선택할 수 있습니다.
Ctrl+C 또는 입력 종료로 취소하면 `DISCORD_SETUP_CANCELLED`로 표시하고 비밀값을 출력하지 않습니다.
Discord 인증·설정 저장·명령 등록에 실패하면 **중단 단계**와 오류 코드를 표시합니다.
명령 등록 후 API가 아직 준비되지 않았다면 등록 완료와 API 준비 대기를 따로 표시합니다.

`setup:local`은 기존의 비어 있는 내부 토큰도 생성하며, 이미 설정된 비밀값은 교체하지 않습니다.
내부 토큰을 새로 채웠다면 실행 중인 API·봇을 재시작해 같은 값을 읽게 하세요.

봇 토큰은 Git에서 제외된 `.local/secrets/discord-bot-token`에 0600, 디렉터리는 0700으로 저장합니다.
`.env`도 0600으로 저장하고 기존 GitHub·Codex·API 설정은 보존합니다.
선택한 서버와 Application ID를 자동 저장하므로 직접 `.env`에 옮겨 적을 필요가 없습니다.

## 3. 봇 실행과 첫 명령

```bash
pnpm dev:bot
```

이 터미널은 **계속 켜 둡니다**. 봇은 시작할 때 누락되거나 바뀐 명령만 자동 등록하고 다시 확인합니다.
같은 앱의 다른 명령은 삭제하지 않습니다. 예전의 별도 `--register-commands` 단계는 필요 없습니다.

`Discord 봇 온라인`이 표시되면 **선택한 서버의 일반 채팅창**에서 `/`를 누르세요.
이 봇의 **`/help`를 목록에서 선택**해 실행하고, 다음으로 **`/ping`**을 실행합니다.
예시의 `repository:` 등을 일반 메시지로 붙여 넣으면 slash 명령이 실행되는 것이 아닙니다.

| 명령                          | 무엇을 확인하나요?                                                          |
| ----------------------------- | --------------------------------------------------------------------------- |
| `/help`                       | 사용법. API·GitHub·Codex 연결 없이도 동작                                   |
| `/ping`                       | API 인증과 본인에게 보이는 활성 저장소 수. 작업·PR을 생성하지 않음          |
| `/develop`, `/refactor`       | 저장소 추천 목록에서 선택하고 작업 내용을 입력. 코드 변경·PR을 만들 수 있음 |
| `/status`, `/logs`, `/cancel` | 최근 작업을 추천 목록에서 선택. 전체 UUID 직접 입력도 가능                  |
| `/approve`, `/merge`          | 사람 리뷰·권한·GitHub 정책을 확인하는 별도 승인/병합 단계                   |
| `/workers`                    | 관리자 워커 조회                                                            |

읽기 전용 `/review`는 아직 없습니다. `/refacter`가 아니라 `/refactor`입니다.
추천 목록은 해당 Discord 사용자에게 API가 허용한 데이터만 보여 줍니다. 목록이 비어 있으면 `/ping`으로 확인하세요.

## `/`를 눌러도 명령이 안 보이면

새 터미널에서 같은 저장소 폴더로 이동해 실행하세요.

```bash
pnpm discord:check
```

이 명령은 **설정과 Discord 명령을 변경하지 않는 점검**입니다.
봇 토큰, Application ID, 서버 접근, 등록된 명령 정의, API·DB·Redis 연결을 구분해서 표시합니다.
사용자 ID가 설정되어 있으면 내부 API 토큰 인증도 확인합니다.
등록 확인만으로 Gateway 접속이나 특정 사용자의 채널 권한까지 보장하지는 않습니다.

| 결과·증상                                   | 할 일                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Command "discord:setup" not found`         | 최신 소스인지 위 절차로 확인. `git pull --ff-only` 후 script 존재 검사                                                                                     |
| `Unsupported engine` / Node 26·pnpm 10 표시 | `node scripts/setup-node.mjs` 후 `source .local/activate-toolchain.sh`로 프로젝트 Node LTS·pnpm 활성화                                                     |
| 토큰 없음·유효하지 않음                     | `pnpm discord:setup`에서 Developer Portal의 **Bot 토큰** 연결                                                                                              |
| `DISCORD_APPLICATION_MISMATCH`              | 토큰과 Application ID가 다른 앱. `pnpm discord:setup`으로 재연결                                                                                           |
| 서버 접근 실패                              | 표시된 링크로 **원하는 서버**에 초대. 다른 서버에 초대한 것은 아닌지 확인                                                                                  |
| 명령 누락·이전 버전                         | 최신 코드로 `pnpm dev:bot` 재시작. 자동 등록 결과 확인                                                                                                     |
| 등록 정상인데 목록이 없음                   | 선택한 서버인지 확인. Discord를 Ctrl+R로 새로고침하거나 앱을 다시 열기                                                                                     |
| 일부 사용자·채널에서만 안 보임              | 서버 설정 → **연동 → 해당 봇**의 역할·채널별 명령 제한, 채널 권한의 **애플리케이션 명령어 사용** 확인. 서버 운영자가 조정                                  |
| DM에서 안 보임                              | 서버 전용 명령이므로 설정한 서버의 채팅 채널에서 사용                                                                                                      |
| 명령은 보이는데 응답하지 않음               | `pnpm dev:bot` 터미널이 켜져 있고 **봇 온라인**인지 확인. 이 봇은 Gateway 방식이므로 Developer Portal의 별도 **Interactions Endpoint URL**을 설정하지 않음 |
| API 연결 실패                               | 다른 터미널에서 `pnpm dev`. API 기본 주소는 `http://127.0.0.1:3001`이며 대시보드 3000과 다름                                                               |
| API 인증 실패                               | 봇과 API가 같은 `.env`의 `BOT_API_TOKEN`을 읽는지 확인. Discord 봇 토큰과는 다른 내부 토큰                                                                 |

**봇에 Administrator 권한을 줄 필요는 없습니다.** Message Content Intent도 필요 없습니다.
이 점검은 실제 PR·병합·모델 호출을 수행하지 않습니다.

## `/ping`은 되지만 저장소가 0개라면

Discord 연결은 된 상태입니다. 다음은 운영자의 저장소 등록과 사용자 역할 설정입니다.
[설치 가이드 7단계](getting-started.md#7-작업할-저장소-등록)에서 **실제 개발 App installation ID**로 저장소를 등록하고,
[8단계](getting-started.md#8-discord-봇-연결)의 `SEED_DISCORD_USER_ID`로 작업을 요청할 사용자에게 해당 저장소의 developer 역할을 부여하세요.
`DISCORD_CHECK_USER_ID`는 진단용일 뿐 역할 설정을 대신하지 않습니다. 일반 사용자에게 전역 관리자 권한을 줄 필요는 없습니다.

실제 개발 작업은 API·스케줄러·준비된 Codex 워커가 실행 중이어야 합니다.
승인·병합에는 [추가 계정·리뷰 설정](approval-setup.md)이 필요합니다. Discord 연결을 확인하는 단계에서는 준비하지 않아도 됩니다.

## 검증 범위

통합 테스트는 임시 저장소의 실제 pnpm 명령과 의사 터미널을 실행합니다.
`discord:setup`의 숨김 입력·서버 재선택·설정 저장·명령 등록, 재실행, 읽기 전용 `discord:check`,
기존 등록 명령, `dev:bot`의 시작·서버 범위 확인·`/help` 처리·종료를 검증합니다.
Discord REST SDK는 모의 HTTP 서버에 연결하며 외부 네트워크를 차단합니다. Gateway 이벤트는 테스트용 클라이언트가 제공합니다.
별도 테스트는 10개 slash 명령을 실제 Control API·PostgreSQL·Redis에 연결해 검증하며 GitHub 작업에는 FakeGitHub를 사용합니다.
실제 Discord 계정의 초대·채널 권한·Gateway 접속은 운영자의 `/help`·`/ping` 확인이 필요합니다.
