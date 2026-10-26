import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '@hub/db';

export const cliFoundation = '20261026000100_cli_foundation';
export async function requireCliDatabase(client: Pick<Pool, 'query'>, schema = 'public') {
  const tables = (
    await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [
      schema,
    ])
  ).rows.map((row) => row.table_name);
  if (!tables.length) return;
  if (tables.includes('_prisma_migrations')) {
    const quotedSchema = '"' + schema.replaceAll('"', '""') + '"';
    const history = (
      await client.query(
        `SELECT migration_name, finished_at, rolled_back_at FROM ${quotedSchema}."_prisma_migrations"`,
      )
    ).rows;
    if (tables.length === 1 && history.length === 0) return;
    if (
      history.length === 1 &&
      history[0].migration_name === cliFoundation &&
      history[0].finished_at &&
      !history[0].rolled_back_at
    )
      return;
  }
  throw new Error(
    'CLI_DATABASE_NOT_EMPTY: use a new empty database for this CLI build; existing data is not modified.',
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('CLI_DATABASE_URL_REQUIRED: configure a new CLI database.');
  const client = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    await requireCliDatabase(client);
  } finally {
    await client.end();
  }
  const result = spawnSync('pnpm', ['--filter', '@hub/db', 'run', 'init'], { stdio: 'inherit' });
  if (result.error || result.status !== 0)
    throw new Error('CLI_DATABASE_INIT_FAILED: check the new database and initialization log.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(
      error instanceof Error && error.message.startsWith('CLI_DATABASE_')
        ? error.message
        : 'CLI_DATABASE_INIT_FAILED: check the new database connection. Values withheld.',
    );
    process.exitCode = 1;
  });
}
