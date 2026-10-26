# 승인·병합 설정 — 운영자용

먼저 [설치·실행 가이드](getting-started.md)의 GitHub App·저장소·워커 설정을 완료하세요.
이 문서는 **PR이 생성된 다음 사람 리뷰와 병합을 연결하는 절차**입니다.
현재 계정 연결·역할 관리를 위한 일반 사용자 화면은 없으므로 운영자가 내부 API/DB로 준비합니다.

App ID·installation ID·App PEM·사람의 GitHub 사용자 토큰은 [연동 설정 안내표](integration-settings.md#5-github--app-id-두-개와-installation-id-두-개)에서 구분할 수 있습니다.
`pnpm config:check --scope merge`로 두 App의 로컬 설정을 확인한 뒤 아래 사람 계정·역할 연결을 진행하세요.

승인자는 요청자와 다른 실제 GitHub 사용자여야 합니다.
저장소 Rulesets의 필수 리뷰·체크를 유지하고 App을 규칙 우회 대상으로 추가하지 마세요.
단순히 관리자 토큰을 사용하는 것으로 사람 리뷰나 서로 다른 사용자 조건이 생략되지는 않습니다.

## 1. 요청자와 승인자의 식별자 확인

| 사용하는 경로                 | Hub 식별자                       |
| ----------------------------- | -------------------------------- |
| 대시보드의 공용 관리자 로그인 | `local-admin`                    |
| Discord 사용자                | `discord:실제_Discord_사용자_ID` |

대시보드에서 요청했다면 `local-admin`을 요청자의 GitHub 계정에 연결합니다.
Discord에서 요청했다면 그 Discord 사용자를 연결합니다.
승인할 Discord 사용자는 별도로 자신의 GitHub 계정에 연결합니다.
동일한 GitHub 사용자로 둘을 연결하면 서로 다른 승인자로 인정하지 않습니다.

## 2. 저장소에 승인자 역할 부여

이 작업은 운영자가 DB에 접속할 수 있는 저장소 폴더에서 수행합니다.
아래 환경변수 두 개를 실제 값으로 바꾸세요. 봇 토큰이나 GitHub 키를 입력하는 자리가 아닙니다.
지정한 사용자의 **해당 저장소 역할을 reviewer로 설정**하며 기존 역할이 있으면 바꿉니다.

```bash
HUB_SETUP_REPOSITORY=본인GitHub아이디/작업할저장소 \
HUB_SETUP_REVIEWER_ID=실제_승인자_Discord_사용자_ID \
node --env-file=.env --conditions=development --import tsx --input-type=module <<'JS'
import { createDatabase } from '@hub/db';
const fullName = process.env.HUB_SETUP_REPOSITORY;
const discordId = process.env.HUB_SETUP_REVIEWER_ID;
if (!fullName || !/^\d{17,20}$/.test(discordId ?? '')) {
  throw new Error('실제 저장소 이름과 Discord 사용자 ID를 입력하세요.');
}
const db = createDatabase(process.env.DATABASE_URL);
try {
  await db.$transaction(async (tx) => {
    const repository = await tx.repository.findUniqueOrThrow({ where: { fullName } });
    const actorId = `discord:${discordId}`;
    await tx.roleBinding.upsert({
      where: { actorId_repositoryId: { actorId, repositoryId: repository.id } },
      create: { actorId, repositoryId: repository.id, role: 'reviewer' },
      update: { role: 'reviewer' },
    });
    await tx.auditEvent.create({
      data: {
        actorId: 'operator',
        action: 'role.configured',
        resourceId: repository.id,
        details: { actorId, role: 'reviewer' },
      },
    });
  });
  console.log('reviewer 역할 등록 완료');
} catch {
  console.error('역할 등록 실패: 저장소 등록·사용자 ID·DB 연결을 확인하세요.');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
JS
```

실제 GitHub 저장소에도 해당 승인자가 리뷰할 수 있는 권한이 있어야 합니다.
Hub의 reviewer 역할만으로 GitHub 저장소 접근 권한이 생기지는 않습니다.

## 3. 실제 GitHub 계정 연결

API 서버가 실행 중이어야 합니다.
현재 `/identity/github`는 GitHub 사용자 토큰으로 `/user`를 조회해 사용자 ID를 확인한 뒤
GitHub ID·로그인 이름을 저장합니다. 토큰 자체는 저장하지 않습니다.
이 사용자 토큰은 GitHub App의 PEM과 다릅니다.

각 연결 대상자는 [GitHub Personal access tokens](https://github.com/settings/personal-access-tokens)에서
본인 계정의 짧은 만료 토큰을 준비하세요. 계정 확인은 `/user` 조회에 필요한 권한만 사용하며 저장소 쓰기 권한을 요구하지 않습니다.
운영자가 관리하는 신뢰할 수 있는 터미널에서 해당 사용자가 본인의 토큰을 직접 입력합니다.
봇의 내부 API 토큰을 일반 사용자에게 배포하는 절차는 아닙니다.

먼저 연결할 경로를 정합니다. Discord 사용자라면 다음 값을 지정합니다.

```bash
export HUB_SETUP_DISCORD_USER_ID=연결할_실제_Discord_사용자_ID
```

대시보드의 요청자 `local-admin`을 연결할 때는 대신 다음을 실행합니다.

```bash
unset HUB_SETUP_DISCORD_USER_ID
```

이어서 다음 전체 블록을 실행합니다. 첫 줄에서 GitHub 사용자 토큰을 입력하고 Enter를 누르세요.
입력 중 글자가 표시되지 않는 것이 정상이며, 토큰을 명령어 안에 직접 적지 않습니다.

```bash
read -r -s -p '연결할 본인 계정의 GitHub 사용자 토큰: ' HUB_SETUP_GITHUB_TOKEN
printf '\n'
export HUB_SETUP_GITHUB_TOKEN
node --env-file=.env --input-type=module <<'JS'
const discordId = process.env.HUB_SETUP_DISCORD_USER_ID;
const token = process.env.HUB_SETUP_GITHUB_TOKEN;
if (!token || (discordId && !/^\d{17,20}$/.test(discordId))) {
  throw new Error('GitHub 사용자 토큰과 Discord ID를 확인하세요.');
}
try {
  const response = await fetch(new URL('/identity/github', process.env.CONTROL_API_URL), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${discordId ? process.env.BOT_API_TOKEN : process.env.ADMIN_API_TOKEN}`,
      ...(discordId ? { 'x-discord-user-id': discordId } : {}),
    },
    body: JSON.stringify({ oauthToken: token }),
  });
  if (!response.ok) {
    console.error(`계정 연결 실패: HTTP ${response.status}`);
    process.exitCode = 1;
  } else {
    console.log('GitHub 계정 연결 완료');
  }
} catch {
  console.error('계정 연결 실패: API 주소·서버 실행·GitHub 연결을 확인하세요.');
  process.exitCode = 1;
}
JS
unset HUB_SETUP_GITHUB_TOKEN
unset HUB_SETUP_DISCORD_USER_ID
```

**요청자와 승인자 각각** 본인의 GitHub 토큰으로 진행합니다.
예를 들어 대시보드로 요청하고 Discord에서 승인한다면 `local-admin` 연결 1회, 승인자 Discord 연결 1회가 필요합니다.
연결 후 계정 확인에 사용한 임시 GitHub 토큰은 폐기할 수 있습니다.
재연결하면 기존 승인에 연결된 GitHub ID와 달라질 수 있으므로 승인 단계도 다시 확인해야 합니다.

## 4. GitHub 리뷰 → Hub 승인 → 병합

1. 요청자와 다른 승인자가 GitHub에서 생성된 PR을 열어 변경 사항을 검토합니다.
2. PR의 **Files changed → Review changes → Approve**로 현재 커밋에 승인 리뷰를 남깁니다.
3. CI가 성공하기를 기다립니다. 저장소 Rulesets와 PR의 필수 체크 상태도 확인합니다.
4. 그 승인자가 Discord에서 `/approve job:작업ID`를 실행합니다.
5. 같은 승인자가 `/merge job:작업ID`를 실행합니다.
6. 대시보드와 GitHub PR에서 실제 병합 결과를 확인합니다.

추가 커밋으로 SHA가 바뀌면 기존 승인을 재사용할 수 없습니다. 현재 코드에 대한 사람 리뷰와 Hub 승인이 다시 필요합니다.
Hub 승인은 1시간 유효하며 병합 시 권한·리뷰·SHA·체크·GitHub 정책을 다시 조회합니다.
merge queue가 필수인 저장소는 현재 직접 병합 경로를 지원하지 않습니다.

`GITHUB_ACCOUNT_LINK_REQUIRED`, `DISTINCT_LINKED_REVIEWER_REQUIRED`, `REVIEWER_ROLE_REQUIRED`,
`GITHUB_REVIEW_APPROVAL_REQUIRED`가 나오면 위 연결·역할·리뷰 단계를 각각 확인하세요.
병합 결과가 불확실해 `NEEDS_HUMAN_ACTION`이 되면 작업 상세와 감사 기록을 확인하고 운영자 복구 경로를 사용합니다.
