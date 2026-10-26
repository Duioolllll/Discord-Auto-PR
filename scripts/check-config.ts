import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codexAuthDirectory,
  validateCodexAuthDirectory,
} from '../packages/agent-codex/src/auth.js';

export const scopes = ['local', 'discord', 'github', 'merge', 'worker'] as const;
export type Scope = (typeof scopes)[number];
export interface ConfigCheck {
  key: string;
  status: 'pass' | 'warn' | 'fail';
  hint: string;
}

// Local configuration checks only. Never return values, paths, or caught error messages.
export async function checkConfiguration(
  scope: Scope,
  env: Readonly<Record<string, string | undefined>>,
) {
  const checks: ConfigCheck[] = [];
  const value = (name: string) => env[name] ?? '';
  const add = (key: string, ok: boolean, hint: string) =>
    checks.push({ key, status: ok ? 'pass' : 'fail', hint });
  const warn = (key: string, hint: string) => checks.push({ key, status: 'warn', hint });
  const token = (name: string, hint: string) =>
    add(name, value(name).length >= 32 && !/\s/.test(value(name)), hint);
  const discordId = /^\d{17,20}$/;
  const appId = (name: string) =>
    add(
      name,
      /^[1-9]\d*$/.test(value(name)) && Number.isSafeInteger(Number(value(name))),
      'GitHub App의 General → App ID 숫자. Client ID와 installation ID를 넣지 마세요.',
    );
  const url = (name: string, schemes: string[], localHttp = false) => {
    let ok = false;
    try {
      const parsed = new URL(value(name));
      ok =
        schemes.includes(parsed.protocol) &&
        (!localHttp ||
          parsed.protocol === 'https:' ||
          ['127.0.0.1', 'localhost'].includes(parsed.hostname)) &&
        (name !== 'CONTROL_API_URL' || (!parsed.username && !parsed.password));
    } catch {
      /* Only the setting name and static guidance are printed. */
    }
    add(
      name,
      ok,
      name === 'CONTROL_API_URL'
        ? 'API 주소: 같은 PC는 http://127.0.0.1:3001, 다른 PC는 HTTPS. 대시보드 주소와 구분하세요.'
        : '주소 형식을 확인하세요. 접속·인증 성공은 별도 검사입니다.',
    );
  };

  async function secret(raw: string, file: string, privateFile = false) {
    if (!value(file)) return value(raw);
    if (value(raw))
      warn(file, `${file}이 우선합니다. 인라인 ${raw}는 이 설정에서 사용되지 않습니다.`);
    if (!isAbsolute(value(file))) {
      add(
        file,
        false,
        '실행하는 컴퓨터에서 읽을 수 있는 파일의 절대 경로를 넣으세요. 키 내용이나 URL을 넣지 마세요.',
      );
      return '';
    }
    let handle;
    try {
      handle = await open(
        value(file),
        constants.O_RDONLY | constants.O_NONBLOCK | (privateFile ? constants.O_NOFOLLOW : 0),
      );
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 131072) throw new Error();
      const exposed =
        (metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid());
      if (exposed && privateFile) throw new Error();
      if (exposed) warn(file, '소유자만 읽을 수 있도록 파일 권한과 소유자를 확인하세요.');
      const contents = (await handle.readFile('utf8')).trim();
      add(
        file,
        contents.length > 0,
        '파일 존재·읽기·크기를 확인했습니다. 비밀값은 출력하지 않습니다.',
      );
      return contents;
    } catch {
      add(
        file,
        false,
        privateFile
          ? '비어 있지 않은 본인 소유 일반 파일이 필요합니다. 권한 0600, 심볼릭 링크 제외.'
          : '읽을 수 있는 비어 있지 않은 일반 파일이 필요합니다. 실제 파일 위치와 마운트를 확인하세요.',
      );
      return '';
    } finally {
      await handle?.close();
    }
  }

  async function github(merge: boolean) {
    appId('GITHUB_APP_ID');
    const pem = await secret('GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE');
    const rsaFingerprint = (contents: string) => {
      try {
        const key = createPrivateKey(contents.replaceAll('\\n', '\n'));
        if (key.asymmetricKeyType !== 'rsa') return null;
        return createHash('sha256')
          .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
          .digest('hex');
      } catch {
        return null;
      }
    };
    const fingerprint = rsaFingerprint(pem);
    add(
      'GITHUB_APP_PRIVATE_KEY',
      fingerprint !== null,
      '개발 App → Private keys에서 다운로드한 RSA PEM. App ID나 사용자 토큰이 아닙니다.',
    );
    if (
      merge ||
      value('GITHUB_MERGE_APP_ID') ||
      value('GITHUB_MERGE_APP_PRIVATE_KEY') ||
      value('GITHUB_MERGE_APP_PRIVATE_KEY_FILE')
    ) {
      appId('GITHUB_MERGE_APP_ID');
      const mergePem = await secret(
        'GITHUB_MERGE_APP_PRIVATE_KEY',
        'GITHUB_MERGE_APP_PRIVATE_KEY_FILE',
      );
      const mergeFingerprint = rsaFingerprint(mergePem);
      add(
        'GITHUB_MERGE_APP_PRIVATE_KEY',
        mergeFingerprint !== null,
        '별도로 만든 병합 App의 RSA PEM을 연결하세요.',
      );
      add(
        'GITHUB_MERGE_APP_ID',
        value('GITHUB_APP_ID') !== value('GITHUB_MERGE_APP_ID'),
        '개발 App과 병합 App은 서로 다른 App ID여야 합니다.',
      );
      if (fingerprint && mergeFingerprint)
        add(
          'GITHUB_MERGE_APP_PRIVATE_KEY',
          fingerprint !== mergeFingerprint,
          '개발 App의 PEM을 병합 App에 재사용하지 마세요.',
        );
    }
    add(
      'GITHUB_MUTATIONS_ENABLED',
      !value('GITHUB_MUTATIONS_ENABLED') ||
        ['true', 'false'].includes(value('GITHUB_MUTATIONS_ENABLED')),
      '정확히 true 또는 false. 쓰기 허용 전 기본값 false를 유지하세요.',
    );
    if (value('GITHUB_MUTATIONS_ENABLED') !== 'true')
      warn(
        'GITHUB_MUTATIONS_ENABLED',
        '현재 PR 생성·병합 쓰기는 꺼져 있습니다. 준비 완료 후에만 true로 바꾸세요.',
      );
    warn(
      'GITHUB_APP_ID',
      '숫자 형식만 확인했습니다. installation ID·저장소 역할은 db:seed와 원격 검증이 별도로 필요합니다.',
    );
  }

  if (scope === 'local') {
    url('DATABASE_URL', ['postgresql:', 'postgres:']);
    url('REDIS_URL', ['redis:', 'rediss:']);
    url('CONTROL_API_URL', ['http:', 'https:'], true);
    for (const name of ['ADMIN_API_TOKEN', 'BOT_API_TOKEN', 'WORKER_ENROLLMENT_TOKEN'])
      token(name, 'pnpm setup:local이 생성합니다. 최소 32자이며 공백·Bearer 접두사는 넣지 마세요.');
    add(
      'DASHBOARD_SESSION_SECRET',
      value('DASHBOARD_SESSION_SECRET').length >= 32,
      'setup:local이 생성하는 최소 32자의 cookie 암호화 키. 대시보드 로그인 값과 구분하세요.',
    );
    const internal = ['ADMIN_API_TOKEN', 'BOT_API_TOKEN', 'WORKER_ENROLLMENT_TOKEN'].map(value);
    add(
      'INTERNAL_API_TOKENS',
      new Set(internal).size === 3,
      'ADMIN_API_TOKEN·BOT_API_TOKEN·WORKER_ENROLLMENT_TOKEN은 서로 다른 값이어야 합니다.',
    );
    const webhook = await secret('GITHUB_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET_FILE');
    add(
      'GITHUB_WEBHOOK_SECRET',
      webhook.length >= 32,
      '서버가 읽는 웹훅 비밀값은 최소 32자. GitHub App의 Webhook secret에도 같은 값을 입력하세요.',
    );
  }
  if (scope === 'discord') {
    if (value('CONTROL_API_URL') || value('BOT_API_TOKEN')) {
      url('CONTROL_API_URL', ['http:', 'https:'], true);
      token(
        'BOT_API_TOKEN',
        'Control API와 봇에서 같은 내부 토큰을 사용합니다. Developer Portal의 Bot 토큰과 다릅니다.',
      );
    } else {
      warn(
        'CONTROL_API_URL',
        'API 설정이 없는 도움말 전용 모드입니다. /help는 사용 가능하며 /ping·작업 명령에는 API 주소와 BOT_API_TOKEN이 필요합니다.',
      );
    }
    const discordToken = (await secret('DISCORD_BOT_TOKEN', 'DISCORD_BOT_TOKEN_FILE', true)).trim();
    add(
      'DISCORD_BOT_TOKEN',
      /^[A-Za-z0-9_.-]+$/.test(discordToken) && !/^\d+$/.test(discordToken),
      'Developer Portal → Bot → Reset Token의 값. pnpm discord:setup으로 숨김 입력하세요.',
    );
    if (discordToken && value('BOT_API_TOKEN'))
      add(
        'DISCORD_BOT_TOKEN',
        discordToken !== value('BOT_API_TOKEN'),
        'DISCORD_BOT_TOKEN과 내부 BOT_API_TOKEN을 같은 값으로 설정하지 마세요.',
      );
    if (value('DISCORD_APPLICATION_ID'))
      add(
        'DISCORD_APPLICATION_ID',
        discordId.test(value('DISCORD_APPLICATION_ID')),
        'Developer Portal → General Information → Application ID. 서버 ID·사용자 ID와 구분하세요.',
      );
    else
      warn(
        'DISCORD_APPLICATION_ID',
        '봇 시작 시 토큰으로 자동 확인합니다. discord:setup이 이 값을 저장합니다.',
      );
    add(
      'DISCORD_GUILD_ID',
      discordId.test(value('DISCORD_GUILD_ID')),
      '봇을 초대한 Discord 서버 ID. discord:setup에서 서버를 선택하세요.',
    );
    if (value('DISCORD_ADMIN_USER_IDS'))
      add(
        'DISCORD_ADMIN_USER_IDS',
        /^\d{17,20}(,\d{17,20})*$/.test(value('DISCORD_ADMIN_USER_IDS')),
        '관리자 사용자 ID를 쉼표로 구분하고 공백은 넣지 마세요. 변경 후 API를 재시작하세요.',
      );
    if (value('DISCORD_CHECK_USER_ID'))
      add(
        'DISCORD_CHECK_USER_ID',
        discordId.test(value('DISCORD_CHECK_USER_ID')),
        '진단 대상 사용자 ID입니다. 이 값만으로 역할·관리자 권한은 부여되지 않습니다.',
      );
  }
  if (scope === 'github' || scope === 'merge') await github(scope === 'merge');
  if (scope === 'worker') {
    url('CONTROL_API_URL', ['http:', 'https:'], true);
    token(
      'WORKER_ENROLLMENT_TOKEN',
      'API 서버와 동일한 워커 등록용 내부 토큰. ADMIN_API_TOKEN이나 봇 토큰이 아닙니다.',
    );
    add(
      'HUB_CODEX_IMAGE',
      /^sha256:[a-f0-9]{64}$/.test(value('HUB_CODEX_IMAGE')),
      'runner:build 후 docker image inspect로 얻은 전체 이미지 ID. 이미지 태그나 API 키가 아닙니다.',
    );
    add(
      'HUB_RUNNER_NETWORK',
      /^hub-egress-[a-z0-9-]+$/.test(value('HUB_RUNNER_NETWORK')),
      '운영자가 접속 목적지를 제한한 Docker 네트워크 이름. Reason Network 이름과 다릅니다. 이름 검사는 방화벽 검증이 아닙니다.',
    );
    let commandOk = false;
    try {
      const command: unknown = JSON.parse(value('WORKER_TEST_COMMAND'));
      commandOk =
        Array.isArray(command) &&
        command.length > 0 &&
        command.length <= 32 &&
        command.every((part) => typeof part === 'string' && part.length <= 512) &&
        ['node', 'npm', 'pnpm', 'python3', 'pytest', 'cargo', 'go'].includes(command[0]);
    } catch {
      /* Invalid JSON is reported without printing it. */
    }
    add(
      'WORKER_TEST_COMMAND',
      commandOk,
      'JSON argv 배열로 지정하세요. 예: ["node","--test"]. 도구·의존성은 워커 이미지에 준비해야 합니다.',
    );
    let loggedIn = false;
    try {
      await validateCodexAuthDirectory(codexAuthDirectory(value('HUB_CODEX_AUTH_DIR')));
      loggedIn = true;
    } catch {
      /* No credential details are returned. */
    }
    add(
      'HUB_CODEX_AUTH_DIR',
      loggedIn,
      '전용 CLI 로그인 파일·권한만 확인합니다. 없으면 워커에서 pnpm codex:login을 실행하세요. 실제 준비는 codex:status·runner:check로 확인합니다.',
    );
  }
  return checks;
}

export function formatChecks(checks: ConfigCheck[]) {
  const labels = { pass: '확인', warn: '참고', fail: '수정 필요' };
  return checks.map((check) => `[${labels[check.status]}] ${check.key}: ${check.hint}`).join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      '사용법: pnpm config:check [--scope local|discord|github|merge|worker]\n기본 local. 값은 출력하지 않으며 설정 변경·네트워크 호출은 하지 않습니다.',
    );
    return;
  }
  if (
    args.length &&
    (args.length !== 2 || args[0] !== '--scope' || !scopes.includes(args[1] as Scope))
  ) {
    console.error('사용법: pnpm config:check [--scope local|discord|github|merge|worker]');
    process.exitCode = 2;
    return;
  }
  const envFile = new URL('../.env', import.meta.url);
  if (existsSync(envFile)) process.loadEnvFile(fileURLToPath(envFile));
  const checks = await checkConfiguration((args[1] ?? 'local') as Scope, process.env);
  console.log(formatChecks(checks));
  console.log(
    '\n로컬 설정 검사입니다. 실제 연결·권한·실행 준비는 docs/integration-settings.md의 단계별 검증을 진행하세요.',
  );
  process.exitCode = checks.some((check) => check.status === 'fail') ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error(
      '설정 검사 실패: .env 또는 비밀 파일의 형식·읽기 권한을 확인하세요. 값은 출력하지 않았습니다.',
    );
    process.exitCode = 1;
  });
}
