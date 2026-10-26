# 연동 설정: 키·ID·파일 경로를 어디에 넣나요?

대시보드를 여는 데 GitHub·Discord·OpenAI 키가 전부 필요한 것은 아닙니다. **사용할 단계의 설정만** 준비하세요. 설치 명령은 [처음 실행하기](getting-started.md), 값의 종류·발급 위치·사용처는 이 문서에서 확인합니다.

모든 `pnpm` 명령은 저장소 루트에서 실행합니다. 기존 `.env`의 해당 줄을 수정하고 같은 이름을 중복 추가하지 마세요. `.env.example`을 기존 `.env`에 덮어쓰면 내부 토큰을 잃을 수 있습니다.

## 1. 지금 필요한 설정과 검사

| 목표                          | 준비할 설정                                                | 로컬 설정 검사                      | 실제 완료 확인                                                |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| 대시보드 열기                 | `setup:local`이 만드는 주소·내부 토큰                      | `pnpm config:check`                 | API `/readyz`, 대시보드 로그인                                |
| Discord `/help`               | Discord Bot 토큰·서버                                      | `pnpm config:check --scope discord` | `pnpm discord:check` → `pnpm dev:bot` → `/help`               |
| Discord 저장소 조회·작업 요청 | 위 설정 + 봇→API 내부 토큰 + 저장소·사용자 역할            | Discord 검사 + `db:seed`            | `/ping`의 저장소 수·추천 목록                                 |
| GitHub PR 생성 준비           | 개발 App ID·PEM + installation ID로 DB 등록                | `pnpm config:check --scope github`  | App 설치 범위·워커 준비 후 승인한 첫 작업의 PR 확인           |
| Codex 워커 실행               | API 등록 토큰 + Codex 로그인 + 이미지·네트워크·테스트 명령 | `pnpm config:check --scope worker`  | `pnpm codex:status` → `pnpm runner:check` → `pnpm dev:worker` |
| 사람 승인·병합                | 별도 병합 App·설치 + 요청자/승인자 계정 연결·역할·리뷰     | `pnpm config:check --scope merge`   | [승인·병합 절차](approval-setup.md)의 조건 확인               |

`config:check`는 **값을 출력하지 않는 읽기 전용 로컬 검사**입니다. 파일·설정 형식을 확인하며 설정 변경·외부 요청은 하지 않습니다. 실제 토큰 유효성, App 설치 대상, DB 역할, Docker 격리·네트워크 제한, 모델 사용 가능량은 별도로 확인해야 합니다.

Discord `/help`만 사용할 때는 `CONTROL_API_URL`과 `BOT_API_TOKEN`을 모두 생략해도 됩니다. 이 경우 API 미연결 안내만 표시합니다. 둘 중 하나를 설정했다면 나머지도 필요하며, 저장소 조회·작업 요청에는 두 값이 모두 필요합니다.

`[확인]`은 해당 로컬 조건 충족, `[수정 필요]`는 수정할 설정을 뜻합니다. 수정 필요 항목이 있으면 종료 코드 `1`입니다. `[참고]`는 선택 사항·다음 단계 안내이며 이 항목만 있으면 종료 코드 `0`입니다. 잘못된 명령 사용법은 코드 `2`, 도움말은 `pnpm config:check --help`입니다.

## 2. 가장 헷갈리는 이름 구분하기

| 이름                          | 무엇인가요?                                          | 어디에서 쓰나요?                                                              |
| ----------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `BOT_API_TOKEN`               | Hub가 자동 생성하는 **내부 비밀값**                  | Discord 봇 → Control API 인증                                                 |
| `DISCORD_BOT_TOKEN` / `_FILE` | Discord가 발급하는 **외부 봇 비밀값** / 그 파일 경로 | 봇 → Discord 로그인                                                           |
| `GITHUB_APP_ID`               | GitHub App 자체의 **숫자 ID**                        | API·스케줄러의 App 인증 설정                                                  |
| `SEED_INSTALLATION_ID`        | App을 특정 계정에 설치한 **설치 ID**                 | 대상 저장소를 `db:seed`로 DB에 등록                                           |
| GitHub App PEM                | App 전용 **RSA 비밀키 파일**                         | 저장소 읽기·PR 생성·병합 인증                                                 |
| GitHub 사용자 토큰            | **본인 계정**임을 확인하는 임시 토큰                 | [요청자·승인자의 GitHub 계정 연결](approval-setup.md#3-실제-github-계정-연결) |
| ChatGPT Codex 로그인          | `codex:login`으로 만드는 전용 **로그인 폴더**        | 기본 `chatgpt` 모드 워커                                                      |
| `HUB_CODEX_API_KEY` / `_FILE` | OpenAI **API 과금 키** / 그 파일 경로                | 명시적으로 `api-key` 모드를 고를 때만                                         |
| `HUB_RUNNER_NETWORK`          | `hub-egress-*` 형태의 **Docker 네트워크 이름**       | 이 프로젝트의 Codex 컨테이너 접속 경로                                        |
| Reason Network                | Reason의 **에이전트 간 연결 서비스**                 | 이 프로젝트의 Docker 네트워크와 별도 연동                                     |

`REASON_API_KEY`는 `BOT_API_TOKEN`, `HUB_CODEX_API_KEY`, GitHub PEM을 대신하지 않습니다. Reason 로그인·네트워크 가입을 완료해도 이 프로젝트의 워커 네트워크·GitHub App 설정이 자동 완료되지는 않습니다.

## 3. 자동 생성되는 내부 값

```bash
pnpm setup:local
pnpm config:check
```

기존 비어 있지 않은 값은 유지하고, 누락·빈 항목에 기본 주소와 내부 비밀값을 채웁니다. 외부 Bot 토큰·GitHub App 키·Codex 로그인은 생성하지 않습니다.

| 항목                       | 생성 위치     | 읽는 서비스 / 입력 위치  | 같은 값을 유지할 곳                       |
| -------------------------- | ------------- | ------------------------ | ----------------------------------------- |
| `ADMIN_API_TOKEN`          | `setup:local` | API / 대시보드 로그인 창 | API의 값과 로그인할 때 입력하는 값        |
| `BOT_API_TOKEN`            | 자동 생성     | API + Discord 봇         | API 서버와 봇 프로세스                    |
| `WORKER_ENROLLMENT_TOKEN`  | 자동 생성     | API + 워커               | API 서버와 각 워커                        |
| `DASHBOARD_SESSION_SECRET` | 자동 생성     | 대시보드 cookie 암호화   | 같은 대시보드의 인스턴스들                |
| `GITHUB_WEBHOOK_SECRET`    | 자동 생성     | API 웹훅 서명 검증       | API가 읽는 값과 개발 App의 Webhook secret |

대시보드 로그인 창에는 **`ADMIN_API_TOKEN`의 값만** 입력하세요. 변수 이름·등호·`DASHBOARD_SESSION_SECRET`을 입력하지 않습니다. `ADMIN_API_TOKEN`, `BOT_API_TOKEN`, `WORKER_ENROLLMENT_TOKEN`은 역할별로 서로 달라야 합니다.

이 값들은 로컬 문자열로 읽습니다. 전송 목적지에서만 치환되는 프록시 secret placeholder로 내부 토큰·웹훅 HMAC 값을 대신할 수는 없습니다.

## 4. Discord — Bot 토큰 한 번만 직접 입력

1. [Developer Portal](https://discord.com/developers/applications)에서 앱을 엽니다.
2. **Bot → Reset Token**의 토큰을 준비합니다. Application ID나 OAuth Client Secret을 복사하는 단계가 아닙니다.
3. `pnpm discord:setup`에서 숨김 입력합니다. 초대 링크로 봇을 추가하고 실제 서버를 선택합니다.
4. 도우미가 파일·ID를 저장하면 다음 순서로 진행합니다.

```bash
pnpm config:check --scope discord
pnpm discord:check
pnpm dev:bot
```

| 항목                     | 얻는 곳 / 입력 방식                                                        | 읽는 곳        |
| ------------------------ | -------------------------------------------------------------------------- | -------------- |
| `DISCORD_BOT_TOKEN_FILE` | 도우미가 `.local/secrets/discord-bot-token`과 경로를 자동 저장             | 봇             |
| `DISCORD_APPLICATION_ID` | General Information → Application ID. 도우미가 토큰으로 자동 확인          | 봇             |
| `DISCORD_GUILD_ID`       | 봇을 초대한 **서버 ID**. 도우미 목록에서 선택                              | 봇             |
| `DISCORD_ADMIN_USER_IDS` | 개발자 모드 → **관리할 사람** 우클릭 → 사용자 ID 복사. 공백 없이 쉼표 구분 | **API**        |
| `DISCORD_CHECK_USER_ID`  | 진단할 사람의 사용자 ID. 도우미에서 선택적으로 입력                        | 연결 점검 도구 |
| `SEED_DISCORD_USER_ID`   | **작업을 요청할 사람**의 사용자 ID. `db:seed`에 전달                       | 등록 명령 → DB |

서버·사용자 ID는 모두 긴 숫자라서 로컬 형식 검사만으로 서로 바뀌었는지 확정할 수 없습니다. 복사한 화면과 실제 서버 목록을 확인하세요. `DISCORD_CHECK_USER_ID` 입력은 권한을 부여하지 않습니다. 일반 작업자는 저장소의 developer 역할, 승인자는 별도의 reviewer 역할·GitHub 계정 연결이 필요합니다.

`/workers` 같은 전역 관리자 기능은 `DISCORD_ADMIN_USER_IDS`를 **API에** 설정한 뒤 API를 재시작해야 합니다. `/help`는 API·GitHub·Codex 준비 전에도 실행할 수 있습니다. `/ping`은 API 인증과 본인의 활성 저장소 수를 확인합니다. 자세한 오류 해결은 [Discord 빠른 연결](discord-quickstart.md)을 참고하세요.

## 5. GitHub — App ID 두 개와 installation ID 두 개

[GitHub Apps](https://github.com/settings/apps)에서 개발용과 병합용 App을 별도로 만듭니다. 조직 소유 App은 조직 Settings → Developer settings → GitHub Apps에서 확인합니다.

| 준비물               | 복사할 곳                                                           | 넣을 곳                                    | 종류                     |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------ | ------------------------ |
| 개발 App ID          | 개발 App → General → **App ID**                                     | `.env`의 `GITHUB_APP_ID`                   | 숫자                     |
| 개발 PEM             | 같은 App → Private keys → Generate a private key                    | 파일 저장 후 `GITHUB_APP_PRIVATE_KEY_FILE` | **파일의 절대 경로**     |
| 개발 installation ID | Install App에서 대상 저장소 설치 → 설치 URL의 `/installations/숫자` | `SEED_INSTALLATION_ID`                     | 설치 숫자 ID             |
| 병합 App ID          | 별도 병합 App → General → **App ID**                                | `.env`의 `GITHUB_MERGE_APP_ID`             | 다른 App의 숫자 ID       |
| 병합 PEM             | 같은 병합 App → Private keys                                        | `GITHUB_MERGE_APP_PRIVATE_KEY_FILE`        | 병합 App PEM의 절대 경로 |
| 병합 installation ID | 병합 App도 설치 → 설치 설정 URL                                     | `SEED_MERGE_INSTALLATION_ID`               | 병합 App의 설치 숫자 ID  |

두 App 각각에서 **Only select repositories → 작업 대상 저장소**를 선택해 설치합니다. clone·App 설치·Hub DB 등록은 각각 별도 단계입니다. 필요한 App 권한은 [설치 가이드 6단계](getting-started.md#6-github-app과-키-설정)를 따르세요.

다운로드한 PEM을 실제 실행 서버의 `.local/secrets` 같은 비공개 경로에 복사한 뒤:

```bash
chmod 700 .local/secrets
chmod 600 .local/secrets/github-dev.pem .local/secrets/github-merge.pem
realpath .local/secrets/github-dev.pem
realpath .local/secrets/github-merge.pem
```

출력된 절대 경로를 기존 `.env`에 추가합니다. 다음은 **형식 예시**이므로 ID·경로를 본인 값으로 바꿉니다.

```dotenv
GITHUB_APP_ID=개발_App의_App_ID
GITHUB_APP_PRIVATE_KEY_FILE=/absolute/private/github-dev.pem
GITHUB_MERGE_APP_ID=병합_App의_App_ID
GITHUB_MERGE_APP_PRIVATE_KEY_FILE=/absolute/private/github-merge.pem
GITHUB_MUTATIONS_ENABLED=false
```

```bash
pnpm config:check --scope github
pnpm config:check --scope merge
```

검사는 PEM을 읽지만 내용을 출력·저장하지 않습니다. **PEM이 그 App에 속하는지, App ID 칸에 installation ID를 넣었는지까지 오프라인으로 확인할 수는 없습니다.** 발급 화면·실제 App 설치 범위도 확인하세요.

개발·병합 App에는 서로 다른 RSA 키를 사용해야 합니다. 검사는 공개키를 비교하므로 같은 키를 PKCS#1·PKCS#8 등 다른 PEM 형식으로 저장해도 재사용을 탐지합니다.

실제 값으로 대상 저장소를 등록합니다. `SEED_*`는 이 명령이 DB를 갱신할 때 쓰는 인자이며 App 인증 키 칸에 넣지 않습니다.

```bash
SEED_REPOSITORY=소유자/대상저장소 \
SEED_INSTALLATION_ID=개발_App의_installation_ID \
SEED_MERGE_INSTALLATION_ID=병합_App의_installation_ID \
SEED_DISCORD_USER_ID=작업을_요청할_Discord_사용자_ID \
SEED_BUDGET_CENTS=1000 \
pnpm db:seed
```

`1000 cents`는 내부 예산 10 USD이며 결제·충전이 아닙니다. `SEED_DISCORD_USER_ID`는 해당 저장소 역할을 developer로 설정하므로 기존 reviewer에 재실행하면 역할이 바뀝니다. 승인자는 [별도 승인 절차](approval-setup.md)를 사용합니다.

웹훅은 API가 읽는 **유효한 secret 하나**를 개발 App의 Webhook secret과 맞춥니다. `_FILE`이 설정돼 있으면 그 파일 내용이 기준입니다. 공개 HTTPS URL·이벤트 선택은 [웹훅 연결 안내](getting-started.md#웹훅을-연결할-때)를 따르세요. 첫 ping 성공은 저장소 권한이나 PR 생성 성공을 의미하지 않습니다.

실제 쓰기를 준비한 뒤에만 `GITHUB_MUTATIONS_ENABLED=true`로 바꾸고 API를 재시작합니다. App 설치만으로 사람 계정 연결이 완료되지는 않습니다. 승인·병합은 [계정 연결·역할·사람 리뷰](approval-setup.md)가 추가로 필요합니다.

## 6. Codex 워커 — 기본은 ChatGPT 로그인

실제 코드를 실행할 **워커 컴퓨터**에서 `pnpm codex:login` → `pnpm codex:status`를 실행합니다.

| 항목                  | 넣는 값                                                      | 확인 방법                                              |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `HUB_CODEX_AUTH_MODE` | 기본 `chatgpt`                                               | ChatGPT 계정 로그인                                    |
| `HUB_CODEX_AUTH_DIR`  | 선택: 전용 **로그인 폴더**의 절대 경로                       | 기본 `.local/codex-auth`; 폴더 0700, auth.json 0600    |
| `HUB_CODEX_CLI`       | 선택: 호스트의 Codex **실행 파일** 경로                      | `codex --version`; [도구 설치](toolchain.md)           |
| `HUB_CODEX_IMAGE`     | `sha256:`와 64자리 값으로 된 **이미지 ID 전체**              | `runner:build` 후 `docker image inspect`               |
| `HUB_RUNNER_NETWORK`  | 목적지 제한을 구성한 `hub-egress-*` **Docker 네트워크 이름** | 이름·존재와 방화벽/egress 검증이 모두 필요             |
| `WORKER_TEST_COMMAND` | **JSON argv 배열**                                           | 예: `.env`에 `WORKER_TEST_COMMAND='["node","--test"]'` |

ChatGPT 로그인에서는 `HUB_CODEX_API_KEY`와 `_FILE`을 비워 둡니다. OpenAI API 과금을 선택할 때만 `HUB_CODEX_AUTH_MODE=api-key`와 OpenAI 키를 설정합니다. 파일을 쓰면 `HUB_CODEX_API_KEY_FILE`에 경로를 넣습니다. ChatGPT 로그인 코드·Reason API 키·GitHub 키는 이 항목에서 사용할 수 없습니다.

```bash
pnpm runner:build
docker image inspect hub-codex:0.164.0 --format '{{.Id}}'
# 출력된 이미지 ID를 .env의 HUB_CODEX_IMAGE에 저장한 뒤:
pnpm config:check --scope worker
pnpm runner:check
```

이름만 맞춘 Docker 네트워크에 접속 제한이 생기지는 않습니다. 저장소는 제한 네트워크를 자동 구성하지 않습니다. 테스트 명령에 필요한 도구·패키지를 준비한 고정 이미지를 사용하세요. 기본 Runner 이미지에 모든 프로젝트 의존성이 들어 있지는 않습니다. [설치 가이드 9~10단계](getting-started.md#9-codex-cli-로그인실행-이미지-확인)를 참고하세요.

## 7. 값과 파일을 둘 다 넣었다면

다음 설정은 **파일 설정이 우선**합니다. 파일이 잘못돼도 인라인 값으로 자동 대체하지 않습니다.

| 파일 설정                           | 파일 설정을 지정하지 않았을 때의 인라인 설정 |
| ----------------------------------- | -------------------------------------------- |
| `DISCORD_BOT_TOKEN_FILE`            | `DISCORD_BOT_TOKEN`                          |
| `GITHUB_APP_PRIVATE_KEY_FILE`       | `GITHUB_APP_PRIVATE_KEY`                     |
| `GITHUB_MERGE_APP_PRIVATE_KEY_FILE` | `GITHUB_MERGE_APP_PRIVATE_KEY`               |
| `GITHUB_WEBHOOK_SECRET_FILE`        | `GITHUB_WEBHOOK_SECRET`                      |
| `HUB_CODEX_API_KEY_FILE`            | `HUB_CODEX_API_KEY` — **api-key 모드에서만** |

지정한 경로의 파일이 실제로 없으면 오류입니다. 파일을 준비하거나 그 설정을 제거해야 합니다.

`*_FILE`에는 키 내용·다운로드 URL을 넣지 않습니다. `~/secret.pem` 대신 `realpath`로 확인한 절대 경로를 사용하세요. Windows 파일도 Linux/WSL 프로세스가 읽을 수 있는 경로여야 합니다. 경로에 공백이 있으면 `.env`에서 값을 따옴표로 감쌉니다.

이미 셸에 export한 값은 `.env`보다 우선합니다. `.env`를 고쳐도 결과가 같으면 해당 셸 export·런타임 설정도 확인하세요. 검사 결과를 공유할 때는 상태·항목 이름·오류 코드만 전달하고 키·`.env` 전체는 보내지 마세요.

## 8. 여러 컴퓨터로 나눠 실행할 때

| 프로세스 / 컴퓨터 | 필요한 설정 묶음                                                                            | 변경 뒤 재시작                        |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------- |
| Control API       | DB·Redis, 내부 API 토큰 3종, 웹훅 secret, GitHub 개발·병합 App, Discord 관리자 ID           | `pnpm dev`                            |
| 스케줄러          | DB·Redis, GitHub 개발 App                                                                   | `pnpm --filter @hub/orchestrator dev` |
| 대시보드          | `CONTROL_API_URL`, `DASHBOARD_SESSION_SECRET`; 로그인 시 ADMIN 토큰 입력                    | 대시보드 프로세스                     |
| Discord 봇        | `CONTROL_API_URL`, API와 같은 `BOT_API_TOKEN`, Discord Bot 토큰·Application ID·서버 ID      | `pnpm dev:bot`                        |
| Codex 워커        | `CONTROL_API_URL`, API와 같은 `WORKER_ENROLLMENT_TOKEN`, Codex 인증, 이미지·네트워크·테스트 | `pnpm dev:worker`                     |

다른 PC의 `127.0.0.1`은 그 PC 자신입니다. 원격 API에는 HTTPS를 사용하세요. 워커에 GitHub PEM·Discord Bot 토큰은 필요 없습니다. 각 PC에서 `setup:local`을 실행하면 내부 토큰도 각각 생성되므로 **연결할 같은 역할의 값은 API 서버를 기준으로** 안전하게 맞춰야 합니다.

클라우드 설정에 `_FILE` 경로만 입력해도 파일이 만들어지지 않습니다. 그 프로세스에서 읽을 수 있는 비밀 파일 마운트가 필요합니다. Codex 로그인 폴더는 개인 워커의 런타임 상태로 취급하고 공유 스냅샷에 포함하지 마세요.

## 9. 증상으로 수정 위치 찾기

| 증상                           | 먼저 확인할 항목                                    | 수정 후 확인                                                      |
| ------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------- |
| 대시보드 로그인 실패           | ADMIN 토큰, API 주소·DB·Redis, session secret       | `config:check`, API `/readyz`, API·대시보드 재시작                |
| 봇 API `UNAUTHORIZED`          | **API와 봇의 BOT_API_TOKEN** 일치 여부              | 두 서비스 재시작 → `discord:check` → `/ping`                      |
| Discord 토큰·앱 불일치         | **Developer Portal Bot 토큰**과 Application ID      | `discord:setup` → `discord:check`                                 |
| `/ping` 저장소 0개             | 저장소 등록·활성 상태, 명령 사용자의 developer 역할 | 실제 사용자 ID로 `db:seed` → `/ping`                              |
| `REPOSITORY_NOT_INSTALLED`     | installation ID로 DB 등록했는지, App 설치 범위      | 발급·설치 화면과 DB 설정 확인                                     |
| `_FILE` 검사 실패              | 서비스를 실행하는 PC의 실제 파일·절대 경로·권한     | 경로 수정/마운트 후 해당 범위 검사                                |
| `GITHUB_WRITES_DISABLED`       | `GITHUB_MUTATIONS_ENABLED=false`                    | 준비 후 true → API 재시작                                         |
| `GITHUB_ACCOUNT_LINK_REQUIRED` | App PEM과 별도인 **사람 GitHub 계정 연결**          | [계정 연결](approval-setup.md)                                    |
| `REVIEWER_ROLE_REQUIRED`       | 승인자의 해당 저장소 reviewer/admin 역할            | [승인자 역할 등록](approval-setup.md#2-저장소에-승인자-역할-부여) |
| 워커 인증·이미지·network 오류  | `config:check --scope worker`, 전용 로그인          | `codex:status` → `runner:check` → 워커 시작                       |

수정 뒤에는 해당 서비스를 재시작해야 새 값을 읽습니다. 로컬 검사 성공과 실제 외부 연결·모델 호출·PR 생성·사람 승인 완료를 구분해 확인하세요.
