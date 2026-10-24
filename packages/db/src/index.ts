import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

export { Prisma, PrismaClient };
export { Pool } from 'pg';
export function createDatabase(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
export type Database = ReturnType<typeof createDatabase>;
export type Transaction = Prisma.TransactionClient;
