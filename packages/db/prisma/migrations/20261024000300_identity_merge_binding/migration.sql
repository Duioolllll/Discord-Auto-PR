-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "githubId" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "mergeInstallationId" TEXT;

