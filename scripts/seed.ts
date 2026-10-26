import { createDatabase } from '@hub/db';

const databaseUrl = process.env.DATABASE_URL;
const fullName = process.env.SEED_REPOSITORY;
const installationId = process.env.SEED_INSTALLATION_ID;
const discordId = process.env.SEED_DISCORD_USER_ID;
const mergeInstallationId = process.env.SEED_MERGE_INSTALLATION_ID;
if (mergeInstallationId && !/^\d+$/.test(mergeInstallationId))
  throw new Error('Invalid merge installation ID');
if (!databaseUrl || !fullName || !installationId)
  throw new Error(
    'DATABASE_URL, SEED_REPOSITORY, SEED_INSTALLATION_ID are required. Use a real GitHub App installation ID.',
  );
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) || !/^\d+$/.test(installationId))
  throw new Error('Invalid repository or installation ID');
if (discordId && !/^\d{17,20}$/.test(discordId)) throw new Error('Invalid Discord user ID');
const db = createDatabase(databaseUrl);
try {
  await db.$transaction(async (tx) => {
    const repository = await tx.repository.upsert({
      where: { fullName },
      create: { fullName, installationId, mergeInstallationId },
      update: { installationId, mergeInstallationId },
    });
    if (discordId)
      await tx.roleBinding.upsert({
        where: {
          actorId_repositoryId: { actorId: `discord:${discordId}`, repositoryId: repository.id },
        },
        create: { actorId: `discord:${discordId}`, repositoryId: repository.id, role: 'developer' },
        update: { role: 'developer' },
      });
    await tx.auditEvent.create({
      data: {
        actorId: 'operator',
        action: 'repository.configured',
        resourceId: repository.id,
        details: { fullName },
      },
    });
  });
  console.log(
    'Repository and optional Discord membership configured. Remote installation verification is required before P1 execution.',
  );
} finally {
  await db.$disconnect();
}
