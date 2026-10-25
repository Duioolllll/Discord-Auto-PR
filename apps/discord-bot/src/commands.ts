import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import {
  commandFailure,
  ControlApiError,
  normalizeRepository,
  type ControlClient,
} from './control-client.js';
export type { ControlClient } from './control-client.js';

const development = ['develop', 'refactor'];
const jobCommands = ['status', 'logs', 'cancel', 'approve', 'merge'];
export const commands = [
  ...development.map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(name === 'develop' ? '개발 작업을 요청합니다' : '리팩터링 작업을 요청합니다')
      .addStringOption((option) =>
        option.setName('repository').setDescription('owner/repository').setRequired(true),
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
        option.setName('job').setDescription('작업 ID').setRequired(true),
      ),
  ),
  new SlashCommandBuilder().setName('workers').setDescription('관리자용 워커 현황'),
  new SlashCommandBuilder().setName('cost').setDescription('관리자용 비용 분류별 현황'),
];
export async function handleCommand(
  interaction: Pick<
    ChatInputCommandInteraction,
    'commandName' | 'id' | 'user' | 'options' | 'deferReply' | 'editReply'
  >,
  client: ControlClient,
) {
  const command = interaction.commandName;
  if (![...development, ...jobCommands, 'workers', 'cost'].includes(command)) return;
  await interaction.deferReply({ ephemeral: true });
  try {
    let content: string;
    if (development.includes(command)) {
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
    } else if (command === 'cost') {
      const result = await client.request('/cost', interaction.user.id, 'GET');
      const rows = result.bySource as {
        source: string;
        currency: string;
        _sum: { amountMicros: number | null };
      }[];
      content =
        rows
          .map(
            (row) =>
              `${row.source}: ${row.currency} ${((row._sum.amountMicros ?? 0) / 1e6).toFixed(4)}`,
          )
          .join('\n') || '기록된 비용 관측치가 없습니다.';
    } else {
      const jobId = encodeURIComponent(interaction.options.getString('job', true));
      const mutation = ['cancel', 'approve', 'merge'].includes(command);
      const result = await client.request(
        `/jobs/${jobId}${command === 'logs' ? '/events' : mutation ? `/${command}` : ''}`,
        interaction.user.id,
        mutation ? 'POST' : 'GET',
        mutation ? {} : undefined,
      );
      if (command === 'logs')
        content =
          (result.events as { kind: string; message: string }[])
            .slice(-10)
            .map((event) => `${event.kind}: ${event.message}`)
            .join('\n') || '아직 이벤트가 없습니다.';
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
