import { z } from 'zod';

export const ApiEnvironment = z
  .object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    ADMIN_API_TOKEN: z.string().min(32),
    BOT_API_TOKEN: z.string().min(32),
    WORKER_ENROLLMENT_TOKEN: z.string().min(32),
    GITHUB_WEBHOOK_SECRET: z.string().min(32),
    DISCORD_ADMIN_USER_IDS: z
      .string()
      .regex(/^(\d{17,20}(,\d{17,20})*)?$/)
      .optional(),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  })
  .superRefine((value, context) => {
    const tokens = [value.ADMIN_API_TOKEN, value.BOT_API_TOKEN, value.WORKER_ENROLLMENT_TOKEN];
    if (new Set(tokens).size !== tokens.length)
      context.addIssue({ code: 'custom', message: 'Role tokens must be distinct' });
  });
export type ApiEnvironment = z.infer<typeof ApiEnvironment>;
