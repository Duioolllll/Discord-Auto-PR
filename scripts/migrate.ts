import { spawnSync } from 'node:child_process';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const result = spawnSync('pnpm', ['--filter', '@hub/db', 'migrate'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
