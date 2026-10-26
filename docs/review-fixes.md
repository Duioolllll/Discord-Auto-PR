# 핵심 코드 검토 후 수정과 검증

2026-10-26. 기준 커밋 `7ea24ffbf11efd95f04bbfaabb21a439bed971c5`에 대한 두 차례 검토에서 재현한 15건을 수정했습니다. 기존 연동 안내 개선도 유지했습니다.

| 항목                            | 수정한 동작                                                                                                        | 주요 코드                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| R01 비활성 저장소 복구          | 복구 상태를 확보할 때와 GitHub 호출 직전에 저장소 활성 여부를 확인                                                 | [workflow.ts](../apps/orchestrator/src/workflow.ts)                                                                |
| R02 취소·복구 경쟁              | DB 잠금으로 복구를 `PUBLISHING`으로 전환하고, 완료·실패 저장에 상태·버전 조건 적용. 먼저 완료된 취소는 복구 불가   | [workflow.ts](../apps/orchestrator/src/workflow.ts)                                                                |
| R03 정리 오류 전파              | 지울 수 없는 작업 트리를 별도 경로에 격리하고 다음 작업 처리                                                       | [supervisor.ts](../apps/worker-supervisor/src/supervisor.ts)                                                       |
| R04 유휴 API 장애               | 일시 실패를 종료 신호를 확인하며 backoff 재시도. 영구 인증·설정 오류는 중단                                        | [client.ts](../apps/worker-supervisor/src/client.ts), [supervisor.ts](../apps/worker-supervisor/src/supervisor.ts) |
| R05 PR 첫 페이지만 동기화       | ID 순서로 50개씩 다음 페이지를 순회해 모든 대기 PR 조회                                                            | [reconcile.ts](../apps/orchestrator/src/reconcile.ts)                                                              |
| R06 base 전진 후 PR 복구        | 기존 PR·브랜치·결정적 커밋이 일치하면 복구. 새 브랜치·PR 생성 전에는 현재 base 재검증                              | [client.ts](../packages/github/src/client.ts)                                                                      |
| R07 GitHub 요청 무기한 대기     | 개발·병합 App의 설치 인증·REST·GraphQL HTTP에 10초 제한. lease·GitHub·outbox 주기 작업 분리                        | [http.ts](../packages/github/src/http.ts), [scheduler.ts](../apps/orchestrator/src/scheduler.ts)                   |
| R08 상세 PR 누락                | 작업 상세 응답에 `pullRequest` 관계 포함                                                                           | [service.ts](../apps/orchestrator/src/service.ts)                                                                  |
| R09 최신 로그 누락              | 이벤트 API에 `latest=true`·`limit` 추가. Discord는 최신 10개, 대시보드는 최신 100개 조회. 기존 forward cursor 유지 | [operations.ts](../apps/control-api/src/operations.ts)                                                             |
| R10 사용량 정수 초과            | API의 token 수·금액 범위를 PostgreSQL 정수 저장 범위와 일치시키고 DB 기록 전 재검증                                | [contracts](../packages/contracts/src/index.ts), [workflow.ts](../apps/orchestrator/src/workflow.ts)               |
| R11 수집 중 취소 후 게시        | 수집·HTTP에 취소 신호 전달, 수집 후와 게시 직전에 다시 확인                                                        | [supervisor.ts](../apps/worker-supervisor/src/supervisor.ts)                                                       |
| R12 Redis 오프라인 무기한 대기  | producer의 연결·명령 대기를 제한하고 미연결 상태는 즉시 실패해 DB 재시도·dead-letter 로직으로 전달                 | [queue](../packages/queue/src/index.ts), [outbox.ts](../apps/orchestrator/src/outbox.ts)                           |
| R13 재귀 탐색 예산 누락         | `opendir`로 순차 열거, 디렉터리 포함 최대 2,000개 항목·30초·취소 신호 적용                                         | [workspace.ts](../apps/worker-supervisor/src/workspace.ts)                                                         |
| R14 Discord help 전용 모드 오진 | API 설정 둘 다 없으면 도움말 전용 안내, 일부만 있으면 오류                                                         | [check-config.ts](../scripts/check-config.ts)                                                                      |
| R15 다른 PEM 형식의 동일 키     | 파싱한 RSA 공개키의 정규화된 지문 비교로 PKCS#1·PKCS#8 간 키 재사용 탐지                                           | [check-config.ts](../scripts/check-config.ts)                                                                      |

## 회귀 검사

단위 **123개**, 통합 **52개**, 브라우저 E2E **1개**가 통과했습니다. 타입 검사·lint·포맷·12개 패키지 빌드·고정 보안 정책·도구 버전 검사와 로컬 `config:check`도 통과했습니다. DB 스키마 변경은 없습니다.

- [통합 회귀 검사](../tests/integration/reliability.test.ts): 실제 PostgreSQL·HTTP에서 비활성 저장소·취소·중복 복구·완료 버전 경쟁, PR 51개 순회, 최신 로그, 정수 경계, 수집 중 취소, 권한이 잠긴 트리 격리와 다음 작업 처리, 실제 Redis 오프라인→재연결 후 전달을 확인합니다.
- [외부 호출·워커 장애 검사](../tests/unit/reliability.test.ts): 주기 작업 간 장애 분리, HTTP 503 재시도, GitHub 헤더·본문 지연 중단과 설치 인증 요청의 deadline을 확인합니다.
- [재귀 파일 검사](../tests/unit/workspace.test.ts): 빈 디렉터리 수 제한, 순환 symlink 거절, 취소와 추적된 ignored 파일 보존을 확인합니다.
- [GitHub 검사](../tests/unit/github-client.test.ts): base 전진 후 동일 PR 복구, 새 게시의 오래된 base 차단, 닫힌 PR·다른 커밋 거절을 확인합니다.
- [설정 검사](../tests/unit/config-check.test.ts): 도움말 전용 모드·부분 설정 오류, 동일 RSA 키의 다른 PEM 표현과 비밀값 비출력을 확인합니다.

이 검증은 loopback 전용 `hub_test` DB, 실제 Redis·Docker, 로컬 HTTP와 모의 agent/GitHub를 사용했습니다. 운영 데이터나 실제 외부 PR·병합·모델 호출은 사용하지 않았습니다. 단위·통합 테스트 후 production 빌드와 브라우저 검사를 순서대로 실행합니다.

## 운영 시 확인할 범위

- [연동 설정 안내](integration-settings.md)에 단계별 키·ID·파일의 발급 위치, 사용처, 우선순위와 점검 명령이 있습니다. 원격 토큰 유효성·App 설치·사람 역할·실제 모델 실행은 별도 검증이 필요합니다.
- 삭제 실패로 격리한 파일은 운영자가 점검·정리해야 합니다. 디스크 quota는 추가하지 않았습니다. 수집 한도·격리 경로·정리 절차는 [Runner 보안 안내](runner-security.md#작업-파일-수집과-정리-실패)를 따릅니다.
- 컨테이너의 기존 1 GiB 메모리·swap·PID 제한을 유지했습니다. 이번 전체 통합 검사에 실제 Docker 격리·시간·출력 제한 검사가 포함됩니다. 장시간 운영의 호스트·DB·Redis 용량 검증을 대신하지 않습니다.
