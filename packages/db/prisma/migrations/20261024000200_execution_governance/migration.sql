-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "baseSha" TEXT,
ADD COLUMN     "maxCostCents" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "reviewIterations" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timeoutSeconds" INTEGER NOT NULL DEFAULT 600;

-- AlterTable
ALTER TABLE "JobEvent" ADD COLUMN     "sequence" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "allowedEngines" TEXT[] DEFAULT ARRAY['codex']::TEXT[],
ADD COLUMN     "baseBranch" TEXT NOT NULL DEFAULT 'main',
ADD COLUMN     "maxReviewIterations" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "requiredChecks" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TransactionOutbox" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "WebhookInbox" ADD COLUMN     "payload" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "processedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "githubId" TEXT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "limitCents" INTEGER NOT NULL,
    "reservedCents" INTEGER NOT NULL DEFAULT 0,
    "spentCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetReservation" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',

    CONSTRAINT "BudgetReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageSample" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amountMicros" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "pricingVersion" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PRLink" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "branch" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,

    CONSTRAINT "PRLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStep" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MergeRecord" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadLetter" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Identity_actorId_key" ON "Identity"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "Identity_githubId_key" ON "Identity"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_repositoryId_key" ON "Budget"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetReservation_jobId_key" ON "BudgetReservation"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageSample_eventId_key" ON "UsageSample"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "PRLink_jobId_key" ON "PRLink"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "PRLink_branch_key" ON "PRLink"("branch");

-- CreateIndex
CREATE UNIQUE INDEX "JobStep_jobId_key_key" ON "JobStep"("jobId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "MergeRecord_jobId_key" ON "MergeRecord"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "DeadLetter_eventId_key" ON "DeadLetter"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "JobEvent_sequence_key" ON "JobEvent"("sequence");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetReservation" ADD CONSTRAINT "BudgetReservation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageSample" ADD CONSTRAINT "UsageSample_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PRLink" ADD CONSTRAINT "PRLink_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStep" ADD CONSTRAINT "JobStep_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeRecord" ADD CONSTRAINT "MergeRecord_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

