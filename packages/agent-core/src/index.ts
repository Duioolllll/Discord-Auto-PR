import type { Engine, Kind, RunSpec, RunResult } from '@hub/contracts';

export interface AgentAdapter {
  engine: Engine;
  supports(kind: Kind): boolean;
  healthcheck(): Promise<boolean>;
  run(spec: RunSpec, signal: AbortSignal): Promise<RunResult>;
}

export function selectAdapter(adapters: AgentAdapter[], engine: Engine, kind: Kind): AgentAdapter {
  const adapter = adapters.find(
    (candidate) => candidate.engine === engine && candidate.supports(kind),
  );
  if (!adapter) throw new Error(`Unsupported engine/kind: ${engine}/${kind}`);
  return adapter;
}
