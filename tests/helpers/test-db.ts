import { Pool } from '@hub/db';
import { spawnSync } from 'node:child_process';
export async function prepareTestDatabase(connection: string) {
  const url = new URL(connection);
  if (url.pathname !== '/hub_cli_test' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('Tests require the dedicated loopback hub_cli_test database');
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString() });
  try {
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname='hub_cli_test'");
    if (!found.rowCount) await admin.query('CREATE DATABASE hub_cli_test');
  } finally {
    await admin.end();
  }
  const result = spawnSync('pnpm', ['db:init'], {
    env: { ...process.env, DATABASE_URL: connection },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Test database initialization failed: ${result.stderr}`);
}
