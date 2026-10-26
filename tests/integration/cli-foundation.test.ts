import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from '@hub/db';
import { requireCliDatabase } from '../../scripts/init-database.js';
import { prepareTestDatabase } from '../helpers/test-db.js';

process.loadEnvFile('.env');
const connection = process.env.TEST_DATABASE_URL!;
const url = new URL(connection);
if (url.pathname !== '/hub_cli_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('Foundation tests require the dedicated loopback hub_cli_test database');
const pool = new Pool({ connectionString: connection });
beforeAll(async () => prepareTestDatabase(connection));
afterAll(async () => pool.end());

it('initializes a fresh CLI schema without accounting or archive tables', async () => {
  const client = await pool.connect();
  const schema = `cli_foundation_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await requireCliDatabase(client, schema);
    await client.query(`SET search_path TO "${schema}"`);
    const sql = await readFile(
      new URL(
        '../../packages/db/prisma/migrations/20261026000100_cli_foundation/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await client.query(sql);
    const tables = (
      await client.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
        [schema],
      )
    ).rows.map((row) => row.table_name);
    expect(tables).toEqual(
      expect.arrayContaining(['Repository', 'Job', 'JobAttempt', 'PRLink', 'Approval']),
    );
    for (const absent of ['Budget', 'BudgetReservation', 'UsageSample', 'LegacyAccountingArchive'])
      expect(tables).not.toContain(absent);
    const columns = (
      await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Job'`,
        [schema],
      )
    ).rows.map((row) => row.column_name);
    expect(columns).toContain('timeoutSeconds');
    expect(columns).not.toContain('maxCostCents');
  } finally {
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
});

it('refuses to initialize a populated unrelated schema and leaves its data untouched', async () => {
  const client = await pool.connect();
  const schema = `existing_data_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`CREATE TABLE "${schema}"."ExistingData" (value text)`);
    await client.query(`INSERT INTO "${schema}"."ExistingData" VALUES ('preserve')`);
    await expect(requireCliDatabase(client, schema)).rejects.toThrow('CLI_DATABASE_NOT_EMPTY');
    expect((await client.query(`SELECT value FROM "${schema}"."ExistingData"`)).rows).toEqual([
      { value: 'preserve' },
    ]);
    await expect(requireCliDatabase(client)).resolves.toBeUndefined();
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
});
