import { prepareTestDatabase } from '../helpers/test-db.js';
export default async function setup() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  await prepareTestDatabase(process.env.TEST_DATABASE_URL);
}
