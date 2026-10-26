# Node LTS와 Codex 버전 관리

2026-10-25 공식 배포 정보를 확인해 다음 버전으로 고정했습니다.
기준은 루트의 [`toolchain.json`](../toolchain.json)입니다.

| 도구           | 버전        | 선택 기준                                        |
| -------------- | ----------- | ------------------------------------------------ |
| Node.js        | **24.22.1** | 프로젝트가 검증한 Node 24 LTS 패치               |
| npm            | **11.19.1** | 해당 공식 Node LTS 배포본에 포함된 버전          |
| pnpm           | **12.15.0** | 프로젝트가 검증한 안정 버전. 별도 LTS 채널 없음  |
| Codex CLI      | **0.164.0** | 프로젝트가 검증한 안정 버전. 별도 LTS 채널 없음  |
| Node 타입 정의 | **24.19.2** | Node 24용 타입 패키지. 런타임과 패치 번호는 별도 |

운영 실행에 `latest` 태그를 사용하지 않으며, 다음 업데이트도 새 고정 버전으로 검증합니다.

## 도구 설치·업데이트

새 설치는 [전체 설치 절차](getting-started.md)를 따릅니다. 같은 CLI 빌드에서 도구를 갱신할 때는 API·봇·워커를 종료한 뒤 Ubuntu/WSL 터미널에서 실행합니다.
아래 도우미는 기존 Node로 시작할 수 있으며 시스템 설치와 Codex 로그인 프로필을 덮어쓰지 않습니다.

```bash
cd ~/Discord-Auto-PR
git pull --ff-only
node --use-env-proxy scripts/setup-node.mjs
source .local/activate-toolchain.sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm toolchain:check
npm install --global --ignore-scripts @openai/codex@0.164.0
codex --version
pnpm db:generate
pnpm build
pnpm runner:build
```

Node는 `v24.22.1`, pnpm은 `12.15.0`, Codex는 `codex-cli 0.164.0`이어야 합니다.
도우미는 Linux x64 전용이며, HTTPS 접속과 `tar`·`xz`가 필요합니다. Node가 아예 없다면 [첫 설치 절차](getting-started.md#2-gitnodejspnpm-설치)부터 진행하세요.
도우미의 Node 다운로드는 공식 배포 파일의 고정 SHA-256과 일치할 때만 설치합니다.

**새 터미널마다 저장소 폴더에서 `source .local/activate-toolchain.sh`를 실행하세요.**
이렇게 해야 API·봇·워커도 같은 Node와 pnpm을 사용합니다. 도우미는 셸 시작 파일을 자동 수정하지 않습니다.
활성화된 셸의 npm 전역 설치도 프로젝트의 전용 Node 폴더에 저장하므로 sudo가 필요 없습니다.
`HUB_CODEX_CLI`를 지정했다면 그 실행 파일도 0.164.0인지 확인하거나 새 CLI 경로로 갱신하세요.

워커는 새 이미지 ID를 선택해야 합니다.

```bash
docker image inspect hub-codex:0.164.0 --format '{{.Id}}'
```

출력된 **이미지 ID만** `.env`의 `HUB_CODEX_IMAGE`에 반영한 뒤 다음을 실행합니다.
사용자 정의 도구가 들어 있는 이미지는 새 Node/Codex 기준으로 다시 빌드해야 합니다.

```bash
pnpm security:check
pnpm runner:check
pnpm codex:status
```

Sandbox 결과가 `{"ready":true,"reason":"OK"}`이고 전용 Codex 로그인과 워커의 제한 네트워크가 준비되면 서비스를 다시 시작합니다.
기존 `.env`, `auth.json`, 전용 로그인 폴더를 삭제하거나 개인 Codex 프로필을 자동 복사하지 않습니다.

## 바뀐 설정과 검증

- `.node-version`과 CI는 정확한 Node 버전을 고정합니다. `engines.node`는 24.22.1 이상의 Node 24 패치만 허용합니다.
- Docker의 두 빌드 단계와 통합 테스트 이미지는 같은 Node 버전·공식 이미지 digest를 사용합니다.
- Codex 호스트 로그인 검사·이미지 빌드·실행 검사는 같은 버전을 읽습니다. 다른 CLI나 이전 이미지면 계속 실패합니다.
- 공식 Codex Linux x64 npm 아티팩트는 고정 SHA-512로 검증하며 버전별 빌드 캐시를 사용합니다.
- pnpm 정책은 `pnpm-workspace.yaml`에서 관리합니다.
- 의존성 설치 스크립트는 esbuild·Prisma에만 허용합니다. 선택형 `msgpackr-extract`는 거절하고 JS 구현을 사용하며, 보안 override를 적용합니다.
- 스크립트 실행 전 자동 설치는 끄고, `pnpm install --frozen-lockfile`로 설치합니다. 새 lockfile에는 pnpm 실행기 자체의 무결성도 기록됩니다.
- `pnpm toolchain:check`는 호스트·packageManager·CI·Docker의 버전 불일치를 확인하며 CI에서도 실행합니다.

Sandbox 정책을 완화하지 않고 새 버전으로 실제 중첩 격리를 다시 검증합니다.
실제 모델 호출·GitHub PR 생성·병합은 이 버전 검증에 포함하지 않습니다.

## 검증 명령

통합 검사의 일반 Node 컨테이너는 다음 고정 이미지를 사용합니다. Codex 이미지는 `pnpm runner:build`로 별도 준비합니다.

```bash
docker pull node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
pnpm toolchain:check
pnpm security:check
pnpm runner:check
pnpm audit --audit-level=high
```

전체 빌드·단위·통합·브라우저 검사 순서는 [README 검증](../README.md#검증)을 따릅니다. DB 검사는 전용 `hub_cli_test`를 사용하며 브라우저 검사와 동시에 실행하지 않습니다.

## 공식 확인 자료

- [Node 공식 배포 목록](https://nodejs.org/dist/index.json), [Node 지원 일정](https://github.com/nodejs/Release/blob/main/schedule.json)
- [Node 24.22.1 공식 체크섬](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt)
- [Codex 0.164.0 안정 릴리스](https://github.com/openai/codex/releases/tag/rust-v0.164.0)
- [Codex Linux x64 아티팩트 메타데이터](https://registry.npmjs.org/@openai/codex/0.164.0-linux-x64)
- [pnpm 12.15.0 릴리스](https://github.com/pnpm/pnpm/releases/tag/v12.15.0), [pnpm 설치·Node 지원표](https://pnpm.io/installation)

새 버전을 적용할 때 manifest·Node pin·pnpm 설정·Docker digest·문서를 함께 갱신하고
`toolchain:check`, frozen install, 빌드, 단위/통합/브라우저 테스트, 실제 `runner:check`를 다시 확인합니다.
