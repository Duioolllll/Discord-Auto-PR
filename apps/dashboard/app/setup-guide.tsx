export function SetupGuide() {
  return (
    <section id="setup" className="setup-guide" aria-labelledby="setup-heading">
      <div className="section-title">
        <h2 id="setup-heading">키 발급·설정 안내</h2>
        <a href="https://github.com/Duioolllll/Discord-Auto-PR#키-발급과-설정">전체 설정 문서 ↗</a>
      </div>
      <p>
        처음 설치한다면{' '}
        <a href="https://github.com/Duioolllll/Discord-Auto-PR/blob/main/docs/getting-started.md">
          설치부터 실행까지 따라 하는 가이드
        </a>
        를 먼저 확인하세요. Windows·Ubuntu 준비부터 대시보드 실행, 서비스 연결, 오류 해결까지
        순서대로 설명합니다.
      </p>
      <p>
        각 항목을 펼쳐 발급 위치와 설정 순서를 확인하세요. 설정은 실행 서버의 <code>.env</code>에
        저장하고, <code>_FILE</code>에는 비밀값이 담긴 파일의 절대 경로를 넣습니다.
      </p>
      <details open>
        <summary>1. Codex CLI — ChatGPT 계정으로 로그인</summary>
        <div className="setup-body">
          <p>
            개인 Linux/WSL 워커에 Codex CLI 0.163.0을 설치하고 저장소 폴더에서 실행하세요. 기본값은{' '}
            <code>HUB_CODEX_AUTH_MODE=chatgpt</code>이며 OpenAI API 키가 필요 없습니다.
          </p>
          <pre>
            <code>
              {'npm install --global @openai/codex@0.163.0\npnpm codex:login\npnpm codex:status'}
            </code>
          </pre>
          <p>
            CLI가 안내하는 페이지에서 로그인합니다. 기본 로그인 폴더는{' '}
            <code>.local/codex-auth</code>이고, 다른 전용 폴더를 사용하려면{' '}
            <code>HUB_CODEX_AUTH_DIR</code>에 절대 경로를 지정하세요.
          </p>
          <p>
            API 과금 방식을 선택할 때만{' '}
            <a href="https://platform.openai.com/api-keys">OpenAI API keys</a>에서 키를 만들고{' '}
            <code>HUB_CODEX_AUTH_MODE=api-key</code>와 <code>HUB_CODEX_API_KEY_FILE</code>을
            설정합니다. ChatGPT 모드에서는 이 키 항목을 비워 두세요.
          </p>
        </div>
      </details>
      <details>
        <summary>2. GitHub — 개발 App·병합 App·웹훅</summary>
        <div className="setup-body">
          <ol>
            <li>
              <a href="https://github.com/settings/apps/new">GitHub App 생성</a>에서 개발용과 병합용
              App을 각각 만듭니다. 각 App의 General에 있는 App ID를 <code>GITHUB_APP_ID</code> /{' '}
              <code>GITHUB_MERGE_APP_ID</code>에 입력합니다.
            </li>
            <li>
              각 App의 Private keys → Generate a private key에서 PEM을 다운로드하고{' '}
              <code>GITHUB_APP_PRIVATE_KEY_FILE</code> /{' '}
              <code>GITHUB_MERGE_APP_PRIVATE_KEY_FILE</code>에 해당 파일의 절대 경로를 지정합니다.
              Client ID나 Client secret을 넣는 항목이 아닙니다.
            </li>
            <li>
              개발 App의 Repository permissions는 Contents·Pull requests를 Read and write,
              Checks·Commit statuses를 Read-only로 설정합니다. 병합 App은 Contents를 Read and write,
              Pull requests를 Read-only로 설정합니다. 두 App 모두 Install App에서 대상 저장소에
              설치하세요.
            </li>
            <li>
              개발 App의 Webhook URL은 공개 HTTPS 주소의 <code>/webhooks/github</code>입니다. 직접
              생성한 32자 이상의 임의 문자열을 Webhook secret에 입력하고, 같은 값을 파일에 저장해{' '}
              <code>GITHUB_WEBHOOK_SECRET_FILE</code>로 지정합니다. Pull request·Check run·Check
              suite·Status 이벤트를 선택하세요.
            </li>
          </ol>
          <p>
            설치 후 URL의 installation ID로 저장소를 등록합니다. App ID와 installation ID는
            다릅니다. 실제 PR 쓰기는 준비가 끝난 뒤 <code>GITHUB_MUTATIONS_ENABLED=true</code>로
            활성화하며, 필수 리뷰·체크는 GitHub Rulesets에서 별도로 설정하세요.
          </p>
        </div>
      </details>
      <details>
        <summary>3. Discord — 봇 토큰·애플리케이션·서버·관리자 ID</summary>
        <div className="setup-body">
          <ol>
            <li>
              <a href="https://discord.com/developers/applications">Discord Developer Portal</a>
              에서 New Application을 만들고, General Information의 Application ID를{' '}
              <code>DISCORD_APPLICATION_ID</code>에 입력합니다.
            </li>
            <li>
              Bot → Reset Token에서 발급한 토큰을 비공개 파일에 저장하고{' '}
              <code>DISCORD_BOT_TOKEN_FILE</code>에 절대 경로를 지정합니다.
            </li>
            <li>
              OAuth2 → URL Generator에서 <code>bot</code>·<code>applications.commands</code>를
              선택해 대상 서버로 초대합니다. 채널 보기·메시지 보내기 권한을 부여합니다.
            </li>
            <li>
              Discord 사용자 설정 → 고급 → 개발자 모드를 켭니다. 서버 우클릭 → 서버 ID 복사로{' '}
              <code>DISCORD_GUILD_ID</code>, 사용자 우클릭 → 사용자 ID 복사로{' '}
              <code>DISCORD_ADMIN_USER_IDS</code>를 설정합니다. 여러 관리자 ID는 쉼표로 구분합니다.
            </li>
          </ol>
          <pre>
            <code>{'pnpm --filter @hub/discord-bot dev --register-commands\npnpm dev:bot'}</code>
          </pre>
          <p>명령 등록은 대상 서버의 기존 애플리케이션 명령 목록을 갱신합니다.</p>
        </div>
      </details>
      <details>
        <summary>4. 워커 — 이미지·네트워크·테스트 명령은 직접 지정</summary>
        <div className="setup-body">
          <p>
            아래 항목은 발급받는 키가 아닙니다. <code>pnpm runner:build</code>로 이미지를 만든 뒤
            다음 명령으로 얻은 <code>sha256:…</code> 값을 <code>HUB_CODEX_IMAGE</code>에 넣습니다.
          </p>
          <pre>
            <code>{"docker image inspect hub-codex:0.163.0 --format '{{.Id}}'"}</code>
          </pre>
          <p>
            <code>HUB_RUNNER_NETWORK</code>에는 운영자가 Codex 접속 목적지를 제한해 준비한{' '}
            <code>hub-egress-*</code> Docker 네트워크 이름을 넣습니다. 이름만 맞춘 네트워크를 만드는
            것으로 접속 제한이 적용되지는 않습니다.
          </p>
          <p>
            <code>WORKER_TEST_COMMAND</code>는 대상 저장소의 테스트 명령을 JSON 배열로 지정합니다.
            예: <code>{'["pnpm","test"]'}</code>. 실행 이미지에 해당 도구와 의존성이 준비되어 있어야
            합니다. <code>pnpm runner:check</code>가 성공한 호스트에서만 워커를 시작하세요.
          </p>
        </div>
      </details>
      <details>
        <summary>5. 대시보드 로그인·내부 토큰·저장 위치</summary>
        <div className="setup-body">
          <p>
            <code>pnpm setup:local</code>이 로컬 <code>.env</code>에 <code>ADMIN_API_TOKEN</code>,{' '}
            <code>BOT_API_TOKEN</code>, <code>WORKER_ENROLLMENT_TOKEN</code>,{' '}
            <code>DASHBOARD_SESSION_SECRET</code> 등을 생성합니다. 대시보드에는{' '}
            <code>ADMIN_API_TOKEN</code> 값으로 로그인하세요. Discord 봇 토큰과 내부{' '}
            <code>BOT_API_TOKEN</code>은 서로 다릅니다.
          </p>
          <p>
            기존 <code>.env</code>는 보존하므로, 외부 연동 항목은 저장소의{' '}
            <a href="https://github.com/Duioolllll/Discord-Auto-PR/blob/main/.env.example">
              .env.example
            </a>
            을 참고해 추가하세요. 변경 후 해당 서비스를 재시작합니다. 클라우드에서는 비밀 파일을
            런타임에 마운트하고, 환경변수에 그 경로를 넣습니다.
          </p>
          <p>
            키 파일은 소유자만 읽도록 설정하고 Git·채팅·공유 이미지에 올리지 마세요. Codex 로그인
            폴더도 공유 환경 스냅샷에 포함하지 마세요.
          </p>
        </div>
      </details>
    </section>
  );
}
