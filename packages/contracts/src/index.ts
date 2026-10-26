import { z } from 'zod';

export const Engine = z.literal('codex');
export const Kind = z.enum(['develop', 'fix', 'refactor', 'review']);
export const JobStatus = z.enum([
  'QUEUED',
  'LEASED',
  'RUNNING',
  'PUBLISHING',
  'PR_OPEN',
  'REVIEWING',
  'FIXING',
  'CI_WAIT',
  'APPROVAL_WAIT',
  'MERGING',
  'MERGED',
  'CANCELLED',
  'FAILED',
  'NEEDS_HUMAN_ACTION',
]);
export const CreateJob = z
  .object({
    externalRequestId: z.string().min(1).max(200),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    instruction: z.string().trim().min(1).max(20000),
    engine: Engine.default('codex'),
    kind: Kind.default('develop'),
    timeoutSeconds: z.number().int().min(10).max(3600).default(600),
  })
  .strict();
export type CreateJob = z.infer<typeof CreateJob>;
export type Engine = z.infer<typeof Engine>;
export type Kind = z.infer<typeof Kind>;
export type JobStatus = z.infer<typeof JobStatus>;

export const RegisterWorker = z
  .object({
    name: z.string().min(1).max(100),
    engines: z.array(Engine).max(1),
    maxConcurrent: z.number().int().min(1).max(8).default(1),
  })
  .strict();
export const LeaseProof = z
  .object({
    leaseToken: z.string().min(32).max(128),
    leaseVersion: z.number().int().positive(),
  })
  .strict();
export const RunResult = z
  .object({
    status: z.enum(['success', 'failed', 'cancelled']),
    summary: z.string().max(8000),
    changedPaths: z.array(z.string().max(1000)).max(1000),
    artifacts: z.array(z.string().max(2000)).max(100),
  })
  .strict();
export type RunResult = z.infer<typeof RunResult>;
export const CompleteAttempt = LeaseProof.extend({
  eventId: z.string().min(1).max(200),
  result: RunResult,
});
export const SafePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path
        .split('/')
        .every((part) => part !== '.' && part !== '..' && part !== '' && part !== '.git'),
    'Unsafe repository path',
  );
export const FileChange = z
  .object({
    path: SafePath,
    contentBase64: z.string().max(1400000).nullable(),
    executable: z.boolean().optional(),
  })
  .strict();
export type FileChange = z.infer<typeof FileChange>;
export const PublishResult = LeaseProof.extend({
  eventId: z.string().min(1).max(200),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  changes: z.array(FileChange).min(1).max(100),
  result: RunResult,
});
export interface RepositorySnapshot {
  baseSha: string;
  files: { path: string; contentBase64: string; executable?: boolean }[];
}
export const AttemptEvent = LeaseProof.extend({
  eventId: z.string().min(1).max(200),
  message: z.string().max(8000),
});
export interface RunSpec {
  jobId: string;
  attemptId: string;
  kind: Kind;
  engine: Engine;
  repo: { owner: string; name: string; baseSha: string };
  workspaceId: string;
  instruction: string;
  limits: { timeoutSeconds: number; maxOutputBytes: number };
}
