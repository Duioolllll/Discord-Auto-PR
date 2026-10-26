# CLI 기반 구현 상태

기준: 2026-10-26 CLI 전용 새 빌드. 새 DB·초기 스키마·ChatGPT 로그인 Codex CLI로 구성한다. [실행 구조·새 설치](cli-execution.md)를 따른다.
제어 영역, 단일 워커의 PR 파이프라인, 승인 정책, 운영 UI를 구현했다. **실제 GitHub/Discord/모델 계정으로 실행한 완료 보고서는 아니다.**

| 영역           | 구현한 동작                                                                                                                                         | 남은 범위                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 기반           | Node 24 / pnpm / Turbo / TypeScript / lint / lockfile / GitHub Actions CI 통과                                                                      | branch protection 등록                                                             |
| 데이터         | Job, Attempt, Worker, Lease, Event, Inbox/Outbox, Approval, Identity, PRLink, JobStep, MergeRecord, DeadLetter, Audit 및 CLI 초기 스키마 1개        | 운영 DB 최소 권한·백업·보존/삭제 정책                                              |
| API            | 인증·저장소별 RBAC, 작업 생성/조회/취소, 목록·워커·drain·감사, 이벤트 cursor/SSE                                                                    | 공개 ingress/TLS, rate limit, 완전한 OpenAPI, SSO                                  |
| Discord        | /help /ping 및 작업 명령 8개, 연결 도우미·읽기 전용 점검, 시작 시 자동 등록·검증, 사용자별 저장소·최근 작업 자동완성, 즉시 defer·mention 차단       | 실제 사용자 봇 계정으로 등록·Gateway E2E, /fix·PR 대상 /review, 비동기 스레드 알림 |
| GitHub         | Octokit GitHub App 설치 범위 확인, bounded snapshot, Git Data branch/commit/PR 생성, 결정적 commit과 PR 중복 검색                                   | 실제 App/저장소 E2E, merge queue 지원, 대형 저장소·submodule·symlink               |
| 워커           | outbound register/claim/heartbeat/snapshot/publish/complete, fencing, 동시성, 취소·만료, workspace cleanup                                          | CPU/RAM/디스크 예약 모델, 연결 단절 중 프로세스 복구·확장                          |
| Codex          | ChatGPT 로그인 전용 0.164.0 CLI 고정, 공식 npm 아티팩트 SHA-512 검증, 오프라인 Docker 이미지 빌드, JSONL parser, argv/stdin 분리, test command gate | 실제 모델 인증/실행 검증 필요; 호스트별 namespace/LSM 지원 검사 필요               |
| 정책           | 다른 GitHub ID를 가진 요청자/승인자, reviewer 역할, 현재 SHA·만료·GitHub 리뷰/체크/권한 재조회, 단일 merge lock, SHA 인자 전달                      | 완전한 OAuth 연결 UX, 정책 서비스의 물리적 분리, 자동 리뷰/수정 루프               |
| 복구           | 늦은 결과 거절, 미확인 외부 쓰기 자동 재실행 차단, 영속 JobStep, 운영자의 동일 PR 계획 복구                                                         | 모든 외부 실패의 자동 재조정·재시도 정책                                           |
| GitHub 동기화  | 새 HEAD에서 승인 삭제, CI/리뷰 상태 갱신, 외부에서 병합된 결과 관측                                                                                 | webhook 기반 세밀한 fan-out, 규모별 rate-limit 조절                                |
| 큐             | transactional Outbox → BullMQ, 같은 ID로 재발행, exponential backoff, 5회 실패 DeadLetter 및 관리자 재시도                                          | 실제 알림 consumer, Redis 보존/압축 정책                                           |
| Dashboard      | Next.js, 암호화 HttpOnly 세션, 같은 Control API 사용, 작업/상세/타임라인/SSE/워커/실행 시간/감사, 모바일 UI                                         | 다중 사용자 SSO·권한 UX, 고급 검색/차트/로그 스트리밍                              |
| 테스트         | real Postgres/Redis, real HTTP supervisor + fake agent/GitHub 전체 흐름, real Docker 격리, browser E2E                                              | 실제 AI→실제 PR→실제 사람 리뷰→실제 Merge                                          |
| 다른 엔진/운영 | 공통 Adapter 계약 및 불가 조합 거절                                                                                                                 | 추가 CLI adapter 설계·검증, cloud provisioner, OTel/Prometheus, 운영 배포          |

## 현재 확인된 외부 선행 조건

- `pnpm runner:build`는 성공했다. CLI는 `codex-cli 0.164.0`이다.
- 고정 Moby 기본 정책의 최소 확장과 Codex CLI 문법 정리를 유지하고, 현재 0.164.0으로 실제 Docker 내부 다중 격리 검사에서 `{"ready":true,"reason":"OK"}`를 재확인했다. 정책·capability·cgroup·다섯 namespace·쓰기·네트워크·인증 격리를 함께 검사하며 실패 시 worker를 등록하거나 작업을 claim하지 않는다. [보안 모델·검증 환경·업데이트](runner-security.md)를 참고한다.
- 실제 GitHub 개발 App/병합 App, Discord 봇, 전용 Codex ChatGPT 로그인 및 승인된 워커 egress network는 설정되지 않았다. 플랫폼 Git 인증과 GitHub App 인증을 동일시하지 않는다.
- 모델 호출·실제 원격 PR·실제 Merge를 테스트하지 않았다. fake adapter/GitHub 테스트를 이 검증으로 간주하지 않는다.

## 실행 및 정책의 구체적인 한계

- Docker에는 비루트 user, read-only rootfs, cap-drop, no-new-privileges, CPU/memory/PID/시간/출력 제한을 적용한다. 기본 네트워크는 none이다. 실행 워크스페이스는 전용 bind directory이며 **하드 디스크 quota/VM 수준 격리는 구현하지 않았다.** 공개된 타인의 코드를 공유 호스트에서 실행하는 완성된 보안 경계로 간주하지 않는다.
- 모델의 success 외에 운영자가 지정한 `WORKER_TEST_COMMAND`가 별도 무자격증명 컨테이너에서 성공해야 PR을 발행한다. 프로젝트에 필요한 도구·의존성이 있는 고정 이미지를 선택해야 한다. 저장소/요청이 명령 argv를 고를 수 없다.
- GitHub 장기 private key/쓰기 토큰은 워커에 전달하지 않는다. ChatGPT CLI 인증은 개인 워커의 전용 file-backed Codex 로그인 프로필로 하며 부모 플랫폼 로그인은 자동 재사용하지 않는다. 프로필은 token 갱신을 위해 실행기에만 연결하고 테스트 컨테이너에는 연결하지 않는다. GitHub 변경은 API가 담당한다.
- snapshot은 최대 1,000개 tree entries / 총 5 MiB / 파일 1 MiB, publish는 최대 100개 변경 / 총 5 MiB로 제한한다. symlink/submodule은 거절한다. 실행 후 원본 `.gitignore`와 일반 build/dependency 출력을 제외하고 변경을 수집한다. 보호 파일·workflow 변경과 알려진 secret 패턴은 발행을 거절한다.
- 작업 시간·출력·메모리·CPU·PID 한도를 적용한다. 앱 내 금액·토큰 회계는 없으며 ChatGPT 계정의 Codex 사용 한도를 따른다. 모델 API 키로 fallback하거나 자동 수정 반복을 실행하지 않는다.
- 계정 연결 API는 GitHub 사용자 token을 `/user`에서 확인하고 token을 저장하지 않는다. public OAuth redirect/PKCE UI는 아직 없다. 요청자와 승인자는 각각 다른 검증된 GitHub ID여야 하며 계정 재연결 후 옛 승인을 재사용할 수 없다.
- 병합 App ID와 설치 ID는 개발 App과 별도로 설정한다. 현재 두 credential은 같은 API 프로세스 안에 있으므로 물리적 서비스 격리와 동등하지 않다. GitHub Rulesets/필수 리뷰가 최종 enforcement이며 merge queue가 필요한 경우 현재 직접 병합 경로는 우회하지 않고 실패한다.
- 불확실한 PR 발행은 `NEEDS_HUMAN_ACTION`에 남는다. 관리자의 `/jobs/:id/reconcile-publish`는 저장된 동일 변경 계획만 재개한다. 불확실한 병합은 자동으로 잠금을 풀지 않으며 `/jobs/:id/reconcile-merge`에서 GitHub 결과를 재조회한다. 미병합 재시도는 5분 대기와 운영자 요청이 필요하다. 늦은 worker 결과나 동일 instruction의 무조건 재실행을 허용하지 않는다.
- generic worker complete의 success는 `NEEDS_HUMAN_ACTION / RESULT_REQUIRES_VERIFICATION`이다. GitHub가 확인한 publish 응답이 있을 때만 `PR_OPEN`으로 간다.
- 대시보드는 운영자 token 기반 로컬/내부 UI다. 공개 다중 사용자 제품으로 배포하기 전 SSO, rate limit, runtime DB 권한, secret manager, 관측/백업 설정이 남아 있다.

## Codex CLI 인증 변경

- `pnpm codex:login` / `pnpm codex:status`로 전용 프로필을 관리한다. 모델 API 키 인증 경로와 모드 선택을 제거했고 CLI에 `forced_login_method="chatgpt"`를 강제한다.
- 공식 CLI 0.164.0의 device login/status, file credential store를 사용한다. 실제 ChatGPT 계정 로그인이나 모델 호출은 아직 수행하지 않았다.
- 로그인 프로필은 한 프로세스가 독점 사용한다. 경로 분리·권한·일반 파일 및 필수 token 필드 존재를 검사한다. token 값은 반환하거나 로그로 출력하지 않는다. 인증 폴더를 공유 snapshot에 포함하면 안 된다.
- `exec` 전용 옵션을 subcommand 뒤로 옮겼다. 실제 Docker 이미지의 pinned CLI에 생성한 argv와 `--help`를 전달하는 통합 테스트로 이전 옵션 위치 오류를 검증한다.
- CLI 인증과 namespace 지원은 별도 조건이며 최소 확장 seccomp로 실제 격리를 검증한다.

## Runner seccomp·격리 검사 강화

- Codex 전용 seccomp는 고정 Moby 기본 규칙 전체를 보존하고 필요한 namespace·mount 호출만 제한적으로 추가한다. 검증 컨테이너는 Docker 기본 정책을 유지한다.
- 컨테이너는 create → 설정 inspect → start → 강제 정리 순서로 관리한다. 정책 변조·누락·정리 실패를 성공으로 처리하지 않는다.
- 임시 HOME을 0700으로 준비하고 실제 로그인 파일은 내부 명령에서 가린다. API 키 환경변수도 내부 명령에 상속하지 않는다.
- 실제 모델·PR·Merge를 실행하지 않는 검사와 syscall·인증 격리·타임아웃 정리 회귀 테스트를 추가했다.
- Docker 기본 AppArmor의 mount 차단이 있는 호스트에는 별도 버전 프로필을 명시적으로 설치·선택한다. 기존 Docker 기본 프로필은 유지하며, 전용 프로필은 고정 seccomp와만 함께 적용한다. 외부·내부 enforce 모드 검증을 CI에서 수행한다. Node 24.22.1 LTS·pnpm 12.15.0·Codex 0.164.0을 고정하고 단위·통합·browser E2E·전체 빌드를 검사한다. [버전 정책](toolchain.md)을 참고한다.

초기 스키마에는 과금·예산·사용량·보관 모델이 없다. `db:init`은 빈 DB 또는 같은 CLI 스키마만 허용하고 기존 데이터가 있는 다른 대상은 변경 없이 거절한다. 데이터 이관 경로는 제공하지 않는다.
