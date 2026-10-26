# Codex Runner의 seccomp 정책과 실제 격리 검사

이 변경은 Docker의 seccomp를 끄는 대신, **Docker 기본 정책을 기반으로 Bubblewrap에 필요한 호출만 추가**합니다.
실제 Codex/Bubblewrap 실행과 격리 검증이 모두 성공해야 다음 결과를 반환합니다.

```json
{ "ready": true, "reason": "OK" }
```

이 검사는 모델 호출·GitHub PR 생성·병합을 수행하지 않습니다.

## 1. 근본 원인과 WSL2에서의 차이

호스트의 `unshare --user --map-root-user true` 성공은 **호스트에서** user namespace를 만들 수 있다는 뜻입니다.
Docker 컨테이너에는 별도의 syscall 필터, capability 제한, LSM 정책 등이 적용됩니다.
Docker Desktop을 사용한다면 WSL 클라이언트와 Docker daemon의 실제 Linux 환경도 구분해야 합니다.

Docker의 기본 seccomp는 `CAP_SYS_ADMIN`이 없을 때 namespace 플래그가 있는 `clone`을 제한합니다.
`unshare`, `mount`, `pivot_root`, `umount2` 등도 기본적으로 제한됩니다.
Codex 0.164.0의 내장 Bubblewrap은 새 user namespace를 만든 뒤 그 namespace 안에서
mount·PID·IPC·network 분리와 파일시스템 구성을 수행하므로 이 호출들이 필요합니다.
Bubblewrap의 일반적인 namespace 오류 문구만 보고 호스트 커널 전체가 user namespace를 지원하지 않는다고 단정하면 안 됩니다.

추가로 기존 검사에는 **CLI 문법 오류**가 있었습니다.
0.164.0의 명령은 `codex sandbox -- 명령`입니다.
`codex sandbox linux -- 명령`으로 실행하면 `linux`를 실행 파일 이름으로 해석합니다.
seccomp에 먼저 막혀 있던 동안에는 이 두 번째 오류가 드러나지 않았습니다.

HOME 초기화도 명확히 했습니다. 이미지 entrypoint가 임시 `CODEX_HOME`을 `0700`으로 준비하며,
준비하지 못하면 고정 오류 코드로 중단합니다.

## 2. 정책의 출처와 최소 확장

정책 파일:

- [Docker 기본 정책 사본](../infra/security/docker-default.seccomp.json)
- [Codex용 정책](../infra/security/codex.seccomp.json)
- [감사 가능한 생성기](../infra/security/generate-seccomp.mjs)
- [원본 라이선스](../infra/security/LICENSE.moby)

기준은 Moby profiles **seccomp/v0.2.4**, commit `245180c51918481c0525424b3ee025d2b435d46c`의
[default.json](https://github.com/moby/profiles/blob/245180c51918481c0525424b3ee025d2b435d46c/seccomp/default.json)입니다.
daemon 버전의 변경에 따라 정책을 자동으로 넓히지 않도록 고정했습니다.
기본 `SCMP_ACT_ERRNO`, 아키텍처 매핑, 기존 syscall 규칙 전체를 보존하고 **12개 규칙만 뒤에 추가**합니다.
기존 capability 조건부 규칙도 그대로 있지만 실제 컨테이너에서는 모든 capability가 제거됩니다.

| 추가한 syscall | 허용 범위                                                         | 이유                                                                     |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `clone`        | flags **`0x78020011`과 정확히 일치**                              | `NEWUSER + NEWNS + NEWPID + NEWIPC + NEWNET + SIGCHLD`로 Bubblewrap 실행 |
| `unshare`      | **`CLONE_NEWUSER`만**                                             | devpts UID/GID 매핑 후 두 번째 user namespace 구성                       |
| `mount`        | 관측한 7개 setup flags 및 제한된 bind-remount flags               | tmpfs·proc·devpts·재귀 bind·private/slave 전파·읽기 전용 재마운트        |
| `pivot_root`   | syscall 허용, 실제 권한은 kernel의 namespace/capability 검사 유지 | Bubblewrap의 새 파일시스템 root 전환                                     |
| `umount2`      | **`MNT_DETACH`만**                                                | 이전 root 정리                                                           |

`mount`의 정확한 setup flags는 `0x8c000`, `0x4c000`, `6`, `10`, `14`, `0xd000`, `0xc0edd000`입니다.
bind-remount 규칙은 `MS_BIND | MS_REMOUNT`를 요구하고 알려진 파일시스템 속성만 추가로 허용합니다.
`MS_MOVE` 등 임의의 다른 mount 연산은 추가 허용하지 않습니다.
이 목록은 고정 Codex 아티팩트의 내장 Bubblewrap 소스와, 인증 정보를 사용하지 않은 실제 syscall trace로 확인했습니다.
참고 소스: [내장 Bubblewrap](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/vendor/bubblewrap/bubblewrap.c),
[Codex bwrap 구성](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/linux-sandbox/src/bwrap.rs),
[sandbox CLI 구현](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/cli/src/debug_sandbox.rs).

**추가 허용하지 않은 항목:**

- `clone3`: 구조체 포인터 안의 flags를 일반 seccomp BPF로 검사할 수 없으므로 기존 **ENOSYS(38)** 처리를 유지합니다.
  libc는 기존 `clone`으로 fallback할 수 있습니다.
- `setns`: 이 경로는 기존 namespace에 합류할 필요가 없으므로 계속 차단합니다.
- user·mount·PID·IPC·network 중 일부만 만드는 임의의 namespace `clone`, cgroup·UTS namespace 추가 등은 허용하지 않습니다.
- BPF, keyring, perf 등 관련 없는 privileged syscall과 VSOCK 제한도 유지합니다.

정책 검증:

```bash
pnpm security:check
```

생성기는 원본 정책의 해시를 먼저 검사하고, 생성 결과가 저장된 정책과 의미상 동일한지 확인합니다.
런타임에도 별도의 고정 SHA-256으로 정책 전체를 검증합니다.
JSON의 단순 공백 변경은 허용하지만, 규칙 변경·누락·알 수 없는 정책은 거절합니다.
정책을 승인해 변경하려면 생성기·테스트·런타임 해시를 함께 검토해야 합니다.

### AppArmor가 활성화된 호스트

AppArmor와 seccomp는 독립적으로 적용됩니다. Docker 기본 AppArmor 프로필의 `deny mount`는
seccomp 예외가 있어도 Bubblewrap의 mount 준비를 거절합니다.
GitHub hosted Ubuntu의 Docker 28.0.4 / kernel 6.17.0-1022-azure에서 이 추가 차단을 확인했습니다.
명시적 AppArmor `deny` 규칙은 조용히 거절할 수 있으므로 audit 거절 건수 0이 허용을 뜻하지는 않습니다.

이 경우 [전용 AppArmor 프로필](../infra/security/codex.apparmor)을 운영자가 명시적으로 설치·선택할 수 있습니다.
기준은 같은 Moby commit의 AppArmor v0.2.3 [원본 template](../infra/security/docker-apparmor-template.go)이며,
[기본 렌더링 결과](../infra/security/docker-default.apparmor)와 비교해 이름/peer를 맞추고
**`deny mount`를 mount·pivot_root 허용으로 바꾸는 부분만** 변경합니다.
네트워크 ALG/VSOCK 차단, proc·sys 쓰기/읽기 제한, 신호·ptrace 제어 등 다른 규칙은 유지합니다.

AppArmor의 mount 허용은 그 프로필 전체에 적용됩니다. mount flags는 함께 적용하는 고정 seccomp가 제한하고,
외부 capability가 모두 제거되어 있으므로 kernel은 외부 namespace의 mount 권한을 부여하지 않습니다.
이 AppArmor 프로필은 **반드시 Codex seccomp와 함께만** 선택할 수 있고, 일반 검증 컨테이너에는 선택하지 않습니다.
AppArmor 자체를 끄거나 unconfined 프로필을 사용하지 않습니다.

설치 전 워커를 중지하고 다음을 실행하세요. 이 sudo 명령은 **호스트에 별도의 이름을 가진 프로필을 등록**하며
기존 `docker-default` 프로필을 덮어쓰지 않습니다. 실제 워커는 계속 일반 사용자로 실행합니다.
설치는 **Docker daemon이 실행되는 호스트**에서 해야 합니다. Docker Desktop처럼 daemon이 별도 VM에 있으면
클라이언트 Ubuntu에 설치한 정책이 반영되지 않을 수 있습니다. daemon 호스트에서 정책을 관리할 수 없다면
관리 가능한 전용 Linux 워커/VM을 사용하세요. daemon 자체에 별도 AppArmor 라벨을 사용하는 구성은 signal peer 규칙도 운영자가 검토해야 합니다.

```bash
pnpm security:check
sudo apparmor_parser -r infra/security/codex.apparmor
```

Ubuntu에서 parser가 없다면 운영자가 `sudo apt-get install apparmor`로 준비합니다.
커널에서 AppArmor가 비활성화된 호스트에는 이 설정이 필요 없습니다.
AppArmor 호스트의 `.env`에 다음 항목을 추가하고 워커를 재시작합니다.

```dotenv
HUB_CODEX_APPARMOR_PROFILE=discord-hub-codex-v1
```

이 값은 미설정이면 Docker 기본값을 유지합니다. 선택할 수 있는 이름은 위 하나로 제한합니다.
설치 누락·다른 이름·실제 적용 라벨 불일치는 실행 전 실패합니다.
실제 검사에서도 외부·내부 `/proc/self/attr/current`가 선택한 이름의 **enforce 모드**인지 확인합니다.
`pnpm security:check`는 원본 template 및 생성 결과도 검증합니다.
커널에 로드된 이름이 어떤 정책인지는 호스트 관리자의 신뢰 영역이므로, 위 검증한 파일 그대로 설치해야 합니다.

## 3. 실제 컨테이너 실행 순서

1. 작업 경로를 정규화하고, 로그인 프로필이 있다면 별도 경로·소유자·권한·파일 형식을 검사합니다.
2. 고정 이미지 ID가 실제 로컬 Linux amd64 이미지 ID와 일치하는지 확인합니다. 자동 pull은 하지 않습니다.
3. Codex용 정책을 검증한 뒤, 비공개 임시 디렉터리에 정책 사본을 만들어 Docker CLI가 사용하게 합니다.
4. `docker create`로 컨테이너를 생성합니다. 아직 명령은 실행하지 않습니다.
5. Docker inspect로 적용된 seccomp JSON의 해시, 선택한 AppArmor 라벨, UID/GID, capability, mount, 네트워크·리소스 제한을 재확인합니다.
   **`Config.Env`는 조회하거나 출력하지 않습니다.**
6. 확인된 컨테이너만 `docker start --attach`로 실행합니다.
7. 종료·실패·취소·타임아웃·출력 초과 후 `docker rm -f`로 정리합니다. `--rm`도 함께 사용합니다.
8. 정책 사본과 검사 workspace를 정리합니다. 컨테이너 정리 실패는 성공으로 간주하지 않습니다.

Codex 실행기와 로그인 상태 확인 컨테이너에만 확장 정책을 적용합니다.
**프로젝트 테스트를 수행하는 별도 검증 컨테이너는 Docker 기본 seccomp를 유지**하며 인증 프로필과 API 키를 받지 않습니다.
정책 파일이 없거나 변조되었거나 Docker가 적용하지 못하면 실행을 중단합니다.
`unconfined`, privileged 모드, `SYS_ADMIN` 추가 또는 내부 sandbox 해제 방식으로 fallback하지 않습니다.

## 4. 변경 전후 보안 모델

| 경계               | 변경 후                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| 외부 Docker rootfs | 기존 `--read-only` 유지                                                                      |
| 외부 사용자·권한   | 비root UID/GID, `--cap-drop=ALL`, `no-new-privileges` 유지·실제 값 확인                      |
| 리소스             | PID 128, RAM 1 GiB, swap 추가분 0, CPU 1개 유지·실제 cgroup 값 확인                          |
| 네트워크           | 검사는 Docker `none`, 실제 CLI는 운영자가 제한한 `hub-egress-*` 사용                         |
| 내부 명령 네트워크 | 권한 프로필에서 차단, Bubblewrap의 새 network namespace와 실제 연결 거절 검사                |
| 파일시스템         | 작업 workspace만 일반 bind, 임시 HOME·`/tmp`는 tmpfs. 인증은 지정한 프로필만 예외적으로 연결 |
| 내부 쓰기          | `:workspace`를 상속한 프로필 사용. workspace와 허용된 임시 공간 외 쓰기 제한                 |
| 인증               | CLI만 파일/키 사용, 내부 명령의 인증 파일 접근과 키 환경변수 상속 차단                       |
| seccomp            | 기본 deny 유지. Codex 컨테이너에만 위 5개 syscall의 제한된 예외 추가                         |

namespace 생성·mount 관련 kernel 공격 표면은 Docker 기본 정책보다 증가합니다.
seccomp는 경로 문자열이나 호출자의 namespace 소속 자체를 검사하지 못합니다.
따라서 외부 capability 제거, 읽기 전용 파일시스템, 내부 privilege drop, 유지보수된 커널과 전용 워커가 여전히 중요합니다.
이 설계는 VM과 동등한 격리나 공유 호스트에서 임의의 적대적 코드를 안전하게 실행하는 완성된 경계를 보장하지 않습니다.

## 5. 인증 디렉터리와 로그

### 작업 파일 수집과 정리 실패

워커는 변경 파일을 수집할 때 디렉터리까지 포함해 최대 2,000개 항목, 파일 1,000개, 전체 파일 내용 5 MiB, 파일당 1 MiB, 변경 파일 100개를 허용합니다. 수집 자체에도 30초 제한을 적용하며 작업 취소·시간 초과를 확인합니다. 심볼릭 링크·하드 링크를 거부하며, 취소 후에는 게시를 시작하지 않습니다. 이 한도는 컨테이너 실행 중의 디스크 사용량을 제한하는 quota는 아닙니다.

권한이 제거된 디렉터리 등으로 작업 파일을 지우지 못하면 워커는 해당 트리를 `WORKER_ROOT/.quarantine-<attempt ID>-*/workspace`로 옮기고 다음 작업을 계속합니다. 옮기기도 실패하면 원래 attempt 경로에 남기며, attempt ID는 재사용하지 않습니다. 로그에는 고정된 정리 실패 메시지만 남깁니다. 운영자는 워커를 중지하고 해당 attempt와 경로·소유권을 확인한 뒤 격리된 파일을 별도로 점검·정리해야 합니다. 신뢰할 수 없는 트리의 링크를 따라 권한을 일괄 변경하지 마세요. 격리 파일은 자동 삭제되지 않으므로 디스크 잔여 용량을 확인하세요.

워커의 유휴 heartbeat·작업 요청은 일시적인 연결 실패·서버 오류가 발생하면 최대 10초 간격으로 재시도합니다. 잘못된 요청·인증·권한·경로 오류(`400`·`401`·`403`·`404`)는 중단하므로 해당 설정을 수정해야 합니다. GitHub HTTP 요청에는 10초 제한을 적용하고, lease 만료 처리·PR 동기화·outbox 전달은 별도 주기로 실행해 한 연동 장애가 다른 처리를 막지 않게 합니다.

### 로그인 프로필과 민감한 로그

- `HOME=/home/runner`, `CODEX_HOME=/home/runner/.codex`를 컨테이너 내부에 명시합니다.
- 인증 없는 검사는 tmpfs 안에만 HOME을 준비합니다. 실제 로그인 폴더를 연결하지 않습니다.
- 실제 ChatGPT 모드는 **사용자가 지정하고 로그인한 전용 프로필**만 연결합니다.
  폴더는 worker 소유 `0700`, `auth.json`은 비공개 일반 파일이어야 하며 기존 symlink·소유자·권한·필수 token 필드 검사를 유지합니다.
- 호스트의 개인 `~/.codex`나 이 작업을 수행하는 플랫폼의 로그인 파일을 자동 검색·복사하지 않습니다.
- Codex의 `hub` 권한 프로필은 `:workspace`를 상속하고 **CODEX_HOME 전체**를 내부 명령에서 가립니다.
  `auth.json`, 설정, 갱신 중 생성되는 임시 파일까지 보호합니다.
  `default_permissions="hub"`로 선택하며 실제 `exec`와 `sandbox`가 같은 설정을 사용합니다.
- 이미지의 읽기 전용 `/usr/local/bin/apply_patch` helper가 동일한 고정 Codex 바이너리의 로컬 patch 모드를 호출합니다.
  인증 폴더를 읽게 하지 않고도 workspace 편집을 지원하며, 검사에서 실제 파일 생성까지 확인합니다.
- 내부 명령에는 `CODEX_API_KEY`, `OPENAI_API_KEY`를 전달하지 않도록 명시적으로 제외합니다.
  신뢰된 CLI의 API 인증은 유지합니다.
- 프로필 파일은 OAuth 갱신을 위해 CLI에만 쓰기 가능하게 연결합니다. 별도 테스트 컨테이너에는 연결하지 않습니다.
- 임시 HOME은 컨테이너 삭제와 함께 사라집니다. 사용자가 로그인한 **지속 프로필은 갱신·재사용을 위해 남겨 둡니다.**
- 검사 로그에는 고정된 오류 분류·단계·종료 코드만 출력합니다. raw stderr, 토큰, `auth.json` 내용, 전체 환경변수를 출력하지 않습니다.

## 6. 검사에서 실제로 확인하는 것

`pnpm runner:check`는 `.env`의 `HUB_CODEX_IMAGE`를 읽고, 비어 있으면 로컬 `hub-codex:0.164.0`의 ID를 찾습니다.
버전 출력은 정확히 `codex-cli 0.164.0`이어야 합니다.
그다음 인증 없는 컨테이너 안에서 다음 검사를 수행합니다.

- 외부 UID가 비root이고 CapEff·CapPrm·CapBnd가 모두 0이며 NNP와 seccomp가 활성화됨.
- rootfs 쓰기 거절, cgroup CPU·memory·swap·PID 값, loopback만 있는 네트워크 확인.
- `CODEX_HOME` 소유자·`0700` 권한·실제 파일 생성 확인.
- 가짜 인증 fixture를 임시 HOME에 생성. 실제 로그인이나 모델 호출은 하지 않음.
- 실제 Codex sandbox 안에서 user·mount·PID·IPC·network namespace가 외부 컨테이너와 모두 다른지 확인.
- 내부 capability가 0이고 seccomp 필터가 추가되었는지 확인.
- workspace 쓰기 성공, 외부 HOME sentinel 수정 거절, 인증·갱신 fixture 및 `/proc/self/root` 별칭을 통한 읽기 거절 확인.
- 인증 폴더 밖의 patch helper로 workspace 파일을 실제 생성할 수 있는지 확인.
- API 키 fixture가 내부 환경에서 사라졌는지 확인.
- 외부 컨테이너의 loopback 서버에 내부 명령이 접속하지 못하는지 확인.
- 위 조건을 모두 통과한 내부 명령만 stdout에 **정확히 `sandbox-ready`**를 씀.
  종료 코드 0·정확한 출력·workspace 검증 marker를 함께 확인함.

테스트에서는 추가로 실제 kernel의 syscall 거절, 잘못된 프로필의 실행 전 중단,
명령 실패·출력 초과·타임아웃 후 **정지된 컨테이너를 포함한 잔여물 부재**를 확인합니다.
Linux syscall 테스트를 직접 실행하려면 호스트에 C 컴파일러와 정적 libc 개발 파일이 필요합니다.
Ubuntu에서는 테스트용으로 `sudo apt-get install build-essential`을 사용할 수 있습니다. 실제 워커 실행에는 C 컴파일러가 필요 없습니다.

## 7. 지원 환경과 실패 진단

실제 확인 환경: **Linux kernel 6.18.55, Docker Engine 28.4.0, cgroup v2, Linux amd64, 일반 사용자 UID 1000**.
이 환경에서 실제 Docker 내부 Codex 0.164.0의 격리 검사가 통과했습니다.
이전 Codex 0.163.0은 **GitHub Ubuntu / kernel 6.17.0-1022-azure / Docker 28.0.4 / cgroup v2 / UID 1001**에서
전용 AppArmor를 외부·내부 모두 enforce 모드로 유지한 검사와 전체 CI가 통과했습니다.
이전 검증 기록: [GitHub Actions](https://github.com/Duioolllll/Discord-Auto-PR/actions/runs/40154578765).
Node 24.22.1 LTS·Codex 0.164.0 업데이트도 같은 정책과 [CI 절차](https://github.com/Duioolllll/Discord-Auto-PR/actions/workflows/ci.yml)로 재검증합니다.
버전 기준과 업그레이드 순서는 [도구 버전 안내](toolchain.md)를 참고하세요.
사용자가 보고한 Ubuntu 26.10 / WSL2 / kernel 6.18.33.2 / Docker 29.1.3 머신에는 이 세션에서 직접 접속하지 않았습니다.
그 머신의 최종 지원 여부는 아래 업데이트 후 동일 검사를 실행해 확인해야 합니다.

필요 조건은 Linux amd64·cgroup v2·seccomp 지원 및 nested user/mount/PID/IPC/network namespace를 허용하는 커널/LSM입니다.
AppArmor·SELinux·rootless Docker·userns-remap 또는 상위 컨테이너의 제한이 남아 있으면 검사에 실패할 수 있습니다.
예를 들어 호스트 LSM이 mount를 차단하는 경우 seccomp 예외만으로 해결되지 않습니다.
AppArmor 기본 mount 차단은 위 전용 프로필로 준비할 수 있습니다. 다른 LSM/커널 제한이 남으면
LSM을 통째로 끄지 말고 운영자가 검토한 범위의 정책을 준비하거나 지원되는 전용 Linux VM을 사용하세요.

안전하게 확인할 수 있는 정보:

```bash
uname -r
docker version --format '{{.Server.Version}}'
docker info --format '{{.KernelVersion}} {{.CgroupVersion}} {{json .SecurityOptions}}'
pnpm security:check
pnpm runner:check
```

| reason / 진단                                      | 조치                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `CODEX_VERSION_MISMATCH`                           | 고정된 0.164.0 이미지 재빌드 후 새 image ID 지정                                       |
| `CODEX_HOME_UNAVAILABLE`                           | 새 entrypoint가 있는 이미지인지, 임시 HOME과 명시한 프로필의 소유자·권한이 맞는지 확인 |
| `NAMESPACE_SANDBOX_UNAVAILABLE`                    | 정책 적용, kernel user namespace 제한, LSM 거절·namespace 한도 확인                    |
| `SECCOMP_POLICY_INVALID`                           | 저장소의 정책·생성기·런타임 버전이 일치하는지 확인. 임의 정책으로 우회하지 않음        |
| `SANDBOX_PROCESS_FAILED`                           | 격리 assertion 또는 내부 실행 실패. image 도구·커널·cgroup·LSM 조건 확인               |
| `SANDBOX_OUTPUT_MISMATCH`                          | 종료 코드 0이어도 정확한 출력/검증 marker가 없음. 성공으로 처리하지 않음               |
| `RUNNER_PROBE_FAILED` / `TIMEOUT`                  | Docker 연결·리소스·시간 제한 확인                                                      |
| `RUNNER_PROBE_FAILED` / `CONTAINER_CLEANUP_FAILED` | worker 재시작 전 daemon 연결과 남은 컨테이너를 운영자가 확인                           |

정상 종료 처리는 daemon에 접근할 수 있을 때 보장합니다.
`diagnostic.code`는 비밀값이 없는 단계 이름입니다. 예를 들어 `OUTER_SWAP`, `OUTER_CPU`는
실제 cgroup 제한 확인 실패, `INNER_NAMESPACES`는 내부 namespace 분리 실패,
`INNER_CREDENTIALS`는 인증 격리 실패, `INNER_HELPER`는 새 이미지의 patch helper 실행 실패를 뜻합니다.
`OUTER_APPARMOR`는 실제 커널의 선택한 AppArmor enforce 모드 확인에 실패한 경우입니다.
진단을 더 자세히 보려고 raw 환경변수나 로그인 파일을 출력하지 마세요.

호스트 전원 장애·supervisor의 SIGKILL·daemon 통신 두절은 프로세스의 `finally`를 실행하지 못하게 할 수 있습니다.
운영 환경에서는 라벨 `io.discord-ai-pr-hub.runner=1`의 오래된 컨테이너를 점검하는 watchdog/복구 절차가 필요합니다.
삭제 전 실행 중인 정상 작업인지 확인해야 합니다.

## 8. 기존 설치 업데이트와 정상 실행 확인

워커를 Ctrl+C로 중지한 뒤 저장소 폴더에서 진행합니다. 코드 로컬 변경이 있으면 먼저 보존하세요.
예전에 진단 로그를 넣느라 아래 두 파일만 수정했고 `git pull`이 거절된다면,
그 수정은 다음과 같이 보관한 뒤 업데이트할 수 있습니다.

```bash
git stash push -m "local runner diagnostics before sandbox fix" -- packages/agent-codex/src/index.ts scripts/check-runner.ts
```

이 명령은 지정한 소스 파일만 보관합니다. `.env`나 로그인 파일을 보관하는 명령이 아닙니다.
업데이트 후 `git stash show -p`로 확인하고 필요한 개인 수정만 새 코드에 반영하세요.
다른 파일에도 변경이 있으면 그 변경도 별도로 보존한 뒤 진행합니다.

```bash
cd "$HOME/Discord-Auto-PR"
git status
git pull --ff-only
pnpm install --frozen-lockfile
pnpm --filter @hub/agent-codex build
pnpm build
pnpm runner:build
docker image inspect hub-codex:0.164.0 --format '{{.Id}}'
```

**마지막 명령의 새 `sha256:...` 전체 값을 `.env`의 `HUB_CODEX_IMAGE`에 반영하세요.**
같은 `hub-codex:0.164.0` 태그여도 entrypoint 수정으로 image ID가 바뀝니다.
기존 `.env` 전체를 예제 파일로 덮어쓰거나 로그인 프로필을 지우지 마세요.
AppArmor가 활성화된 호스트는 앞의 전용 프로필 설치와 `.env`의 `HUB_CODEX_APPARMOR_PROFILE` 설정도 완료하세요.

```bash
pnpm security:check
pnpm runner:check
pnpm test
pnpm test:integration
```

검사 JSON이 `{"ready":true,"reason":"OK"}`일 때만, 기존 Codex 로그인·제한 네트워크·프로젝트 검증 명령 설정을 확인하고 워커를 시작합니다.

```bash
pnpm dev:worker
```

관련 안내: [전체 설치·실행](getting-started.md), [구현 상태](implementation-status.md).

## 9. 수정 파일과 검증 결과

| 파일                                                                                                                                                                                                                    | 변경 목적                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [index.ts](../packages/agent-codex/src/index.ts), [container.ts](../packages/agent-codex/src/container.ts), [probe.ts](../packages/agent-codex/src/probe.ts), [auth.ts](../packages/agent-codex/src/auth.ts)            | adapter 연결, 생성 전후 정책 확인, 실제 다중 격리 검사, 인증·명령 권한 |
| [check-runner.ts](../scripts/check-runner.ts), [package.json](../package.json)                                                                                                                                          | `.env` 읽기, 안전한 JSON 실패 보고, 정책 감사 명령                     |
| [codex.Dockerfile](../infra/docker/codex.Dockerfile)                                                                                                                                                                    | 비공개 HOME 초기화·읽기 전용 patch helper                              |
| [infra/security](../infra/security/README.md)                                                                                                                                                                           | 고정 Moby 원본·생성기·seccomp/AppArmor 정책·라이선스                   |
| [sandbox.test.ts](../tests/integration/sandbox.test.ts), [seccomp-probe.c](../tests/fixtures/seccomp-probe.c), [seccomp.test.ts](../tests/unit/seccomp.test.ts), [codex-auth.test.ts](../tests/unit/codex-auth.test.ts) | 실제 kernel·namespace·인증·정리 검사와 정책 회귀 테스트                |
| [ci.yml](../.github/workflows/ci.yml), [.env.example](../.env.example)                                                                                                                                                  | enforce AppArmor로 CI 검증·명시적 선택 설정                            |
| [README](../README.md), [getting-started.md](getting-started.md), [implementation-status.md](implementation-status.md), 이 문서                                                                                         | 설치·PULL·진단·지원 범위·검증 결과                                     |

전체 파일 목록은 `git diff --name-only 416d2e3 HEAD`로 확인할 수 있습니다.

| 실행 명령                              | 확인 결과                                       |
| -------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @hub/agent-codex build` | 성공                                            |
| `pnpm runner:check`                    | 실제 sandbox에서 `{"ready":true,"reason":"OK"}` |
| `pnpm build`                           | 12개 패키지 성공                                |
| `pnpm test`                            | 65개 통과                                       |
| `pnpm test:integration`                | 31개 통과                                       |
| `pnpm test:e2e`                        | GitHub CI에서 1개 통과                          |
| lint·typecheck·format·`security:check` | 통과                                            |

실제 GitHub App PR 생성·병합이나 모델 요청은 수행하지 않았습니다.
로그인 프로필·개인 키·봇 토큰을 출력하거나 커밋하지 않았습니다.
