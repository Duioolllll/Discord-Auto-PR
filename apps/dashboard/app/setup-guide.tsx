import toolchain from '../../../toolchain.json';

export function SetupGuide() {
  return (
    <section id="setup" className="setup-guide" aria-labelledby="setup-heading">
      <div className="section-title">
        <h2 id="setup-heading">키 발급·설정 안내</h2>
        <a href="https://github.com/Duioolllll/Discord-Auto-PR/blob/main/docs/integration-settings.md">
          키·ID·파일 경로 안내표 ↗
        </a>
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
        기준 버전: Node {toolchain.node} LTS · pnpm {toolchain.pnpm} · Codex {toolchain.codex} 안정
        버전.{' '}
        <a href="https://github.com/Duioolllll/Discord-Auto-PR/blob/main/docs/toolchain.md">
          기존 설치 버전 맞추기
        </a>
      </p>
      <p>
        <strong>Discord에서 명령 목록이 안 보이나요?</strong> 저장소 폴더에서{' '}
        <code>pnpm discord:setup</code>으로 토큰 입력·서버 선택을 마친 뒤 <code>pnpm dev:bot</code>
        을 실행하세요. GitHub·Codex 연결 전에도 서버에서 <code>/help</code>부터 확인할 수 있습니다.
      </p>
      <p>
        각 항목을 펼쳐 발급 위치와 설정 순서를 확인하세요. 설정은 실행 서버의 <code>.env</code>에
        저장하고, <code>_FILE</code>에는 비밀값이 담긴 파일의 절대 경로를 넣습니다.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>필요한 것</th>
              <th>어디서 얻나요?</th>
              <th>어디에 쓰나요?</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>대시보드 로그인 값</td>
              <td>
                <code>pnpm setup:local</code>이 생성
              </td>
              <td>
                <code>ADMIN_API_TOKEN</code> 값만 로그인 창에 입력
              </td>
            </tr>
            <tr>
              <td>Discord Bot 토큰</td>
              <td>Developer Portal → Bot → Reset Token</td>
              <td>
                <code>pnpm discord:setup</code>에 숨김 입력
              </td>
            </tr>
            <tr>
              <td>봇의 API 내부 토큰</td>
              <td>
                <code>setup:local</code>이 별도로 생성
              </td>
              <td>
                API와 봇의 <code>BOT_API_TOKEN</code>을 일치시킴
              </td>
            </tr>
            <tr>
              <td>GitHub App ID / 설치 ID</td>
              <td>App General / 설치 설정 URL</td>
              <td>
                <code>GITHUB_APP_ID</code> / <code>SEED_INSTALLATION_ID</code>
              </td>
            </tr>
            <tr>
              <td>GitHub App PEM</td>
              <td>App → Private keys</td>
              <td>
                <code>GITHUB_APP_PRIVATE_KEY_FILE</code>에 파일의 절대 경로
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        로컬 기본 설정은 <code>pnpm config:check</code>, Discord 설정은{' '}
        <code>pnpm config:check --scope discord</code>로 확인하세요. 비밀값을 출력하거나 설정을
        바꾸지 않습니다. 실제 연결은 <code>discord:check</code>, Codex 실행 준비는{' '}
        <code>codex:status</code>·<code>runner:check</code>로 따로 확인합니다.
      </p>
      <details open>
        <summary>1. Codex CLI — ChatGPT 계정으로 로그인</summary>
        <div className="setup-body">
          <p>
            개인 Linux/WSL 워커에 Codex CLI {toolchain.codex}를 설치하고 저장소 폴더에서 실행하세요.
            ChatGPT 계정으로 로그인한 CLI 전용 프로필을 사용하며 모델 API 키를 설정하지 않습니다.
          </p>
          <pre>
            <code>
              {`npm install --global @openai/codex@${toolchain.codex}\npnpm codex:login\npnpm codex:status`}
            </code>
          </pre>
          <p>
            CLI가 안내하는 페이지에서 로그인합니다. 기본 로그인 폴더는{' '}
            <code>.local/codex-auth</code>이고, 다른 전용 폴더를 사용하려면{' '}
            <code>HUB_CODEX_AUTH_DIR</code>에 절대 경로를 지정하세요.
          </p>
          <p>
            작업별 실행 시간과 격리 한도를 적용합니다. 예산 입력·금액 예약·비용 정산은 없습니다. CLI
            로그인과 워커 준비가 끝나면 바로 작업을 요청할 수 있습니다.
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
              개발 App의 Webhook URL은 공개 HTTPS 주소의 <code>/webhooks/github</code>입니다.{' '}
              <code>setup:local</code>이 생성한 <code>GITHUB_WEBHOOK_SECRET</code> 값을 App의
              Webhook secret에도 입력합니다. <code>GITHUB_WEBHOOK_SECRET_FILE</code>을 지정했다면 그
              파일 내용이 기준입니다. Pull request·Check run·Check suite·Status 이벤트를 선택하세요.
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
        <summary>3. Discord — 토큰 입력 → 서버 선택 → 봇 실행</summary>
        <div className="setup-body">
          <ol>
            <li>
              <a href="https://discord.com/developers/applications">Discord Developer Portal</a>
              에서 앱을 만들고 Bot → Reset Token으로 봇 토큰을 준비합니다.
            </li>
            <li>
              아래 연결 도우미를 실행합니다. 토큰은 숨김 입력하고, 서버는 목록에서 선택합니다.
              Application ID 확인·초대 링크·설정 저장·명령 등록은 자동으로 처리합니다.
            </li>
            <li>
              봇 실행 후 대상 서버 채팅창에서 <code>/</code>를 누르고 <code>/help</code>,{' '}
              <code>/ping</code>을 목록에서 선택합니다. 봇 터미널은 계속 켜 둡니다.
            </li>
          </ol>
          <pre>
            <code>{'pnpm discord:setup\npnpm dev:bot'}</code>
          </pre>
          <p>
            명령 목록이 없으면 <code>pnpm discord:check</code>로 토큰·서버·명령 등록·API 연결을
            구분해서 확인하세요. 봇 시작 시 누락된 명령을 자동 등록하며 다른 명령은 보존합니다.
            저장소와 최근 작업도 명령 옵션의 추천 목록에서 선택할 수 있습니다.
          </p>
          <p>
            GitHub·Codex 설정 전에도 <code>/help</code>부터 사용할 수 있습니다.{' '}
            <a href="https://github.com/Duioolllll/Discord-Auto-PR/blob/main/docs/discord-quickstart.md">
              Discord 빠른 연결·명령이 안 보일 때 해결 방법
            </a>
          </p>
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
            <code>{`docker image inspect hub-codex:${toolchain.codex} --format '{{.Id}}'`}</code>
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
