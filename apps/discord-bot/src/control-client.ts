const help = {
  INVALID_REPOSITORY:
    '저장소를 owner/repository 또는 https://github.com/owner/repository 형식으로 입력해 주세요.',
  REPOSITORY_NOT_INSTALLED:
    'Hub에 등록되지 않았거나 비활성화된 저장소입니다. 실제 GitHub App installation ID로 pnpm db:seed를 실행했는지 확인해 주세요.',
  FORBIDDEN:
    '이 작업에 대한 권한이 없습니다. 저장소의 Discord 사용자 역할을 확인해 주세요. 취소는 요청자 또는 관리자만 할 수 있습니다.',
  UNAUTHORIZED:
    '봇의 Control API 인증에 실패했습니다. 봇과 API 서버의 BOT_API_TOKEN이 같은지 확인해 주세요. DISCORD_BOT_TOKEN과는 다른 내부 토큰입니다.',
  ADMIN_REQUIRED:
    '관리자용 명령입니다. API 서버의 DISCORD_ADMIN_USER_IDS에 본인의 Discord 사용자 ID를 등록하고 API를 재시작해 주세요.',
  PROJECT_ADMIN_REQUIRED:
    '비용 조회에는 관리자 권한이 필요합니다. 저장소 admin 역할 또는 API 서버의 DISCORD_ADMIN_USER_IDS 설정을 확인해 주세요.',
  BUDGET_EXCEEDED:
    '저장소의 가용 예산이 부족합니다. 대시보드에서 예산 한도와 이미 예약된 금액을 확인해 주세요.',
  JOB_NOT_FOUND: '작업을 찾을 수 없습니다. 작업 생성 응답에 나온 전체 작업 ID를 입력해 주세요.',
  RESOURCE_NOT_FOUND: '대상 데이터를 찾을 수 없습니다. 작업 ID와 저장소 등록 상태를 확인해 주세요.',
  ENGINE_NOT_ALLOWED:
    '이 저장소에서 Codex 엔진 사용이 허용되지 않았습니다. 저장소 allowedEngines 설정을 확인해 주세요.',
  JOB_NOT_CANCELLABLE: '현재 상태의 작업은 취소할 수 없습니다. /status로 상태를 확인해 주세요.',
  GITHUB_NOT_CONFIGURED:
    'Control API에 GitHub App이 설정되지 않았습니다. App ID와 PEM 파일 설정 후 API를 재시작해 주세요.',
  GITHUB_ACCOUNT_LINK_REQUIRED:
    '명령을 실행한 사용자의 GitHub 계정 연결이 필요합니다. 설치 가이드의 /identity/github 연결 절차를 진행해 주세요.',
  DISTINCT_LINKED_REVIEWER_REQUIRED:
    '요청자와 승인자는 서로 다른 GitHub 계정으로 연결되어 있어야 합니다.',
  REVIEWER_ROLE_REQUIRED:
    '저장소의 reviewer 또는 admin 역할이 필요합니다. 역할 설정을 확인해 주세요.',
  REVIEWER_REQUIRED: '연결된 GitHub 계정의 저장소 리뷰 권한과 요청자·승인자 분리를 확인해 주세요.',
  SELF_APPROVAL_FORBIDDEN: '자신이 작성한 PR은 승인할 수 없습니다. 다른 리뷰어가 검토해야 합니다.',
  GITHUB_REVIEW_APPROVAL_REQUIRED: 'GitHub에서 현재 커밋에 Approve 리뷰를 먼저 남겨 주세요.',
  PR_NOT_READY:
    '아직 승인 가능한 PR 상태가 아닙니다. /status와 /logs로 작업 진행 상태를 확인해 주세요.',
  HEAD_CHANGED: 'PR에 새 커밋이 생겼습니다. 현재 커밋을 다시 리뷰하고 승인해 주세요.',
  APPROVAL_REQUIRED:
    '현재 커밋에 유효한 승인이 필요합니다. GitHub 리뷰와 /approve 결과를 확인해 주세요.',
  MERGE_POLICY_REJECTED:
    '병합 정책을 충족하지 못했습니다. 현재 SHA의 승인, 필수 CI, GitHub Rulesets와 병합 가능 상태를 확인해 주세요.',
  GITHUB_WRITES_DISABLED:
    'GitHub 쓰기가 비활성화되어 있습니다. 운영자가 준비를 확인한 뒤 GITHUB_MUTATIONS_ENABLED를 설정해야 합니다.',
  MERGE_APP_NOT_CONFIGURED:
    '별도 병합 App이 설정되지 않았습니다. GITHUB_MERGE_APP_ID와 PEM 경로를 확인해 주세요.',
  MERGE_INSTALLATION_NOT_CONFIGURED: '저장소에 별도 병합 App installation ID를 등록해야 합니다.',
  MERGE_REQUIRES_RECONCILIATION:
    '이전 병합 결과를 운영자가 확인해야 합니다. 같은 병합 요청을 반복하지 말고 감사 기록을 확인해 주세요.',
  CONCURRENT_MODIFICATION: '작업 상태가 변경되었습니다. /status로 최신 상태를 확인해 주세요.',
  IDEMPOTENCY_CONFLICT:
    '같은 요청 ID에 다른 내용이 전달되었습니다. 요청 처리 기록을 확인해 주세요.',
  INTERNAL_ERROR: 'Control API 내부 오류입니다. 운영자가 API 서버의 오류 로그를 확인해야 합니다.',
};
type KnownCode = keyof typeof help;
type ErrorCode =
  | KnownCode
  | 'INVALID_REQUEST'
  | 'HTTP_ERROR'
  | 'CONTROL_API_UNREACHABLE'
  | 'CONTROL_API_INVALID_RESPONSE';
export class ControlApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status?: number,
  ) {
    super('Control API request failed');
    this.name = 'ControlApiError';
  }
}
export interface ControlClient {
  request(
    path: string,
    userId: string,
    method: string,
    body?: unknown,
  ): Promise<Record<string, unknown>>;
}
const knownCode = (value: unknown): value is KnownCode =>
  typeof value === 'string' && Object.hasOwn(help, value);

async function responseCode(response: Response): Promise<ErrorCode> {
  const reader = response.body?.getReader();
  if (!reader) return 'HTTP_ERROR';
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        return 'HTTP_ERROR';
      }
      chunks.push(value);
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const code =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    return code === 'INVALID_REQUEST' || knownCode(code) ? code : 'HTTP_ERROR';
  } catch {
    return 'HTTP_ERROR';
  } finally {
    reader.releaseLock();
  }
}

export function createControlClient(
  baseUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
): ControlClient {
  const base = new URL(baseUrl);
  if (
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))) ||
    base.username ||
    base.password
  )
    throw new Error('Control API requires HTTPS outside loopback and no URL credentials');
  return {
    async request(path, userId, method, body) {
      let response: Response;
      try {
        response = await fetcher(new URL(path, base), {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'x-discord-user-id': userId,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
      } catch {
        throw new ControlApiError('CONTROL_API_UNREACHABLE');
      }
      if (!response.ok) throw new ControlApiError(await responseCode(response), response.status);
      try {
        const result: unknown = await response.json();
        if (!result || typeof result !== 'object') throw new Error();
        return result as Record<string, unknown>;
      } catch {
        throw new ControlApiError('CONTROL_API_INVALID_RESPONSE', response.status);
      }
    },
  };
}

export function commandFailure(error: unknown, command: string) {
  if (!(error instanceof ControlApiError))
    return '봇이 응답을 처리하지 못했습니다. 운영자가 봇 실행 상태를 확인해 주세요. (BOT_COMMAND_FAILED)';
  const code =
    knownCode(error.code) ||
    ['INVALID_REQUEST', 'CONTROL_API_UNREACHABLE', 'CONTROL_API_INVALID_RESPONSE'].includes(
      error.code,
    )
      ? error.code
      : 'HTTP_ERROR';
  let message: string;
  if (knownCode(code)) message = help[code];
  else if (code === 'INVALID_REQUEST')
    message = ['develop', 'refactor'].includes(command)
      ? '입력 형식을 확인해 주세요. repository는 owner/repository 형식, instruction은 공백이 아닌 1~20,000자입니다.'
      : '입력 형식을 확인해 주세요. job에는 작업 생성 응답의 전체 UUID를 입력해야 합니다.';
  else if (code === 'CONTROL_API_UNREACHABLE')
    message =
      'Control API에 연결하지 못했습니다. API 실행 상태와 CONTROL_API_URL을 확인해 주세요. 다른 PC의 localhost는 API 서버를 가리키지 않습니다. 쓰기 요청은 처리되었을 수 있으므로 재요청 전에 작업/PR 상태를 확인해 주세요.';
  else if (code === 'CONTROL_API_INVALID_RESPONSE')
    message =
      'Control API에서 올바른 JSON 응답을 받지 못했습니다. CONTROL_API_URL이 대시보드(3000)가 아닌 API(기본 3001)를 가리키는지 확인해 주세요.';
  else if (error.status === 401) message = help.UNAUTHORIZED;
  else if (error.status === 403) message = help.FORBIDDEN;
  else if (error.status === 404)
    message =
      'Control API 경로를 찾지 못했습니다. CONTROL_API_URL의 서버와 포트가 맞는지 확인해 주세요.';
  else if (error.status === 429)
    message = '요청이 제한되었습니다. 잠시 후 상태를 다시 확인해 주세요.';
  else
    message = 'Control API 요청이 실패했습니다. 운영자가 API 서버 상태와 로그를 확인해야 합니다.';
  return `${message}\n오류 코드: ${code}${error.status === undefined ? '' : ` · HTTP ${error.status}`}`;
}

export function normalizeRepository(value: string) {
  let input = value.trim();
  const markdown = /^\[[^\]\r\n]*\]\((https:\/\/github\.com\/[^)\s]+)\)$/.exec(input);
  if (markdown) input = markdown[1]!;
  if (input.startsWith('<') && input.endsWith('>')) input = input.slice(1, -1);
  const pattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (pattern.test(input)) return input;
  try {
    const url = new URL(input);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password
    )
      return undefined;
    const name = url.pathname
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '');
    return pattern.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}
