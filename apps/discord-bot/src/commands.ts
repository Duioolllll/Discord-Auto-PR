import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js';
import {
  commandFailure,
  ControlApiError,
  normalizeRepository,
  type ControlClient,
} from './control-client.js';
export type { ControlClient } from './control-client.js';

const development = ['develop', 'refactor'];
const jobCommands = ['status', 'logs', 'cancel', 'approve', 'merge'];
function recentLogs(events: { kind: string; message: string }[]) {
  const lines: string[] = [];
  let remaining = 1800;
  for (const event of events.slice(-10).reverse()) {
    const line = `${event.kind}: ${event.message}`;
    if (line.length > remaining) {
      if (!lines.length) lines.push(`${line.slice(0, remaining - 1)}…`);
      break;
    }
    lines.unshift(line);
    remaining -= line.length + 1;
  }
  return lines.join('\n') || '아직 이벤트가 없습니다.';
}
export const commands = [
  ...development.map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(name === 'develop' ? '개발 작업을 요청합니다' : '리팩터링 작업을 요청합니다')
      .addStringOption((option) =>
        option
          .setName('repository')
          .setDescription('목록에서 선택하거나 GitHub 저장소 링크 입력')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option.setName('instruction').setDescription('작업 요청 내용').setRequired(true),
      ),
  ),
  ...jobCommands.map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(
        (
          {
            status: '작업 상태',
            logs: '작업 로그',
            cancel: '작업 취소',
            approve: '현재 SHA 승인 의사 기록',
            merge: 'GitHub 정책 확인 후 병합 요청',
          } as Record<string, string>
        )[name]!,
      )
      .addStringOption((option) =>
        option
          .setName('job')
          .setDescription('최근 작업 선택 또는 전체 작업 ID')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  ),
  new SlashCommandBuilder().setName('workers').setDescription('관리자용 워커 현황'),
  new SlashCommandBuilder().setName('help').setDescription('처음 사용하기 · 명령어와 연결 방법'),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Discord · API 연결과 내 저장소 권한 확인'),
];

export async function handleAutocomplete(
  interaction: Pick<AutocompleteInteraction, 'commandName' | 'user' | 'options' | 'respond'>,
  client: ControlClient,
) {
  const field = interaction.options.getFocused(true);
  if (
    ![...development, ...jobCommands].includes(interaction.commandName) ||
    !['repository', 'job'].includes(field.name)
  )
    return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let choices: { name: string; value: string }[] = [];
  try {
    const result = await Promise.race([
      client.request(
        field.name === 'repository' ? '/repositories' : '/jobs?limit=25',
        interaction.user.id,
        'GET',
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), 2000);
      }),
    ]);
    const search = String(field.value).toLowerCase();
    if (Array.isArray(result))
      choices = result
        .flatMap((item) => {
          if (field.name === 'repository')
            return item.enabled && typeof item.fullName === 'string' && item.fullName.length <= 100
              ? [{ name: item.fullName, value: item.fullName }]
              : [];
          return typeof item.id === 'string' && item.id.length <= 100
            ? [
                {
                  name: `${item.status} · ${item.repository?.fullName ?? ''} · ${item.id}`.slice(
                    0,
                    100,
                  ),
                  value: item.id,
                },
              ]
            : [];
        })
        .filter((item) => `${item.name} ${item.value}`.toLowerCase().includes(search))
        .slice(0, 25);
  } catch {
    /* Autocomplete cannot show an error; /ping explains connection and role failures. */
  } finally {
    clearTimeout(timer);
  }
  await interaction.respond(choices);
}
export async function handleCommand(
  interaction: Pick<
    ChatInputCommandInteraction,
    'commandName' | 'id' | 'user' | 'options' | 'deferReply' | 'editReply'
  >,
  client: ControlClient,
) {
  const command = interaction.commandName;
  if (![...development, ...jobCommands, 'workers', 'help', 'ping'].includes(command)) return;
  await interaction.deferReply({ ephemeral: true });
  try {
    let content: string;
    if (command === 'help') {
      content =
        '처음이라면 /ping으로 연결과 내 저장소 권한을 확인하세요.\n/develop: Codex CLI로 기능 개발 · /refactor: 코드 수정·리팩터링\nrepository와 job은 입력창의 추천 목록에서 선택할 수 있습니다. 저장소는 GitHub 링크를 붙여 넣어도 됩니다.\n/status: 상태 · /logs: 기록 · /cancel: 취소\n/approve: 현재 커밋 승인 · /merge: 정책 확인 후 병합\n/workers: 관리자 워커 조회\n검토만 하는 /review는 아직 없습니다.\n연결 문제: 서버 터미널에서 pnpm discord:check\n설치 안내: https://github.com/Duioolllll/Discord-Auto-PR/blob/main/docs/discord-quickstart.md';
    } else if (command === 'ping') {
      await client.request('/me', interaction.user.id, 'GET');
      const repositories = await client.request('/repositories', interaction.user.id, 'GET');
      if (!Array.isArray(repositories)) throw new ControlApiError('CONTROL_API_INVALID_RESPONSE');
      const count = repositories.filter((repo) => repo.enabled).length;
      content = `Discord 연결: 정상\nControl API 인증: 정상\n내가 사용할 수 있는 활성 저장소: ${count}개\n${count ? '/develop 또는 /refactor에서 repository 추천 목록을 선택하세요.' : '저장소가 없다면 운영자가 내 Discord 사용자 ID에 저장소 역할을 등록해야 합니다.'}\n이 검사는 작업이나 PR을 만들지 않습니다. 실제 워커 준비는 별도입니다.`;
    } else if (development.includes(command)) {
      const repository = normalizeRepository(interaction.options.getString('repository', true));
      if (!repository) throw new ControlApiError('INVALID_REPOSITORY');
      const response = await client.request('/jobs', interaction.user.id, 'POST', {
        externalRequestId: `discord:${interaction.id}`,
        repository,
        instruction: interaction.options.getString('instruction', true),
        kind: command,
        engine: 'codex',
      });
      const job = response.job as { id: string; status: string };
      content = `작업 ${job.id}: ${job.status}`;
    } else if (command === 'workers') {
      const result = await client.request('/workers', interaction.user.id, 'GET');
      content = Array.isArray(result)
        ? result
            .map(
              (worker: { name: string; engines: string[]; draining: boolean }) =>
                `${worker.name}: ${worker.draining ? 'DRAINING' : worker.engines.join(', ') || 'probe'}`,
            )
            .join('\n')
        : '워커를 조회하지 못했습니다.';
    } else {
      const jobId = encodeURIComponent(interaction.options.getString('job', true));
      const mutation = ['cancel', 'approve', 'merge'].includes(command);
      const result = await client.request(
        `/jobs/${jobId}${command === 'logs' ? '/events?latest=true&limit=10' : mutation ? `/${command}` : ''}`,
        interaction.user.id,
        mutation ? 'POST' : 'GET',
        mutation ? {} : undefined,
      );
      if (command === 'logs')
        content = recentLogs(result.events as { kind: string; message: string }[]);
      else if (command === 'approve')
        content = `승인 의사를 현재 SHA ${String(result.headSha)}에 기록했습니다. GitHub 리뷰와 필수 체크는 별도로 검증합니다.`;
      else if (command === 'merge') content = `병합 확인: ${String(result.sha)}`;
      else content = `작업 ${String(result.id)}: ${String(result.status)}`;
    }
    await interaction.editReply({
      content: (content || '조회 결과가 없습니다.').slice(0, 1800),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await interaction.editReply({
      content: commandFailure(error, command),
      allowedMentions: { parse: [] },
    });
  }
}
