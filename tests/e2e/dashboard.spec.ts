import { test, expect } from '@playwright/test';
import { createDatabase } from '@hub/db';
import { randomUUID } from 'node:crypto';

const repository = `test/browser-${randomUUID().slice(0, 8)}`;
test.beforeAll(async () => {
  const db = createDatabase(process.env.TEST_DATABASE_URL!);
  try {
    await db.repository.create({
      data: {
        fullName: repository,
        installationId: '42',
      },
    });
  } finally {
    await db.$disconnect();
  }
});
test('authenticates, creates and cancels a job, and fits a mobile viewport', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Control room' })).toBeVisible();
  await page.getByLabel('Control API access token').fill(process.env.ADMIN_API_TOKEN!);
  await page.getByRole('button', { name: '대시보드 열기' }).click();
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  await expect(page.getByLabel('CLI 실행 제한 (초)')).toHaveValue('600');
  await expect(page.locator('[name="maxCostCents"], [name="limitCents"], #cost')).toHaveCount(0);
  const cookie = (await context.cookies()).find((cookie) => cookie.name === 'hub_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  expect((await page.content()).includes(process.env.ADMIN_API_TOKEN!)).toBe(false);
  await page.getByLabel('저장소', { exact: true }).selectOption(repository);
  await page
    .getByLabel('개발 요청', { exact: true })
    .fill('Browser test request: no external engine or GitHub mutation.');
  await page.getByLabel('CLI 실행 제한 (초)').fill('120');
  await page.getByRole('button', { name: '작업 생성' }).click();
  await expect(page).toHaveURL(/\/jobs\/[a-f0-9-]{36}$/);
  const db = createDatabase(process.env.TEST_DATABASE_URL!);
  try {
    const job = await db.job.findUniqueOrThrow({
      where: { id: new URL(page.url()).pathname.split('/').at(-1)! },
    });
    expect(job.timeoutSeconds).toBe(120);
  } finally {
    await db.$disconnect();
  }
  await expect(page.locator('.status').first()).toHaveText('QUEUED');
  await page.getByRole('button', { name: '취소 요청' }).click();
  await expect(page.locator('.status').first()).toHaveText('CANCELLED');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.screenshot({
    path: '.local/screenshots/job-mobile.png',
    fullPage: true,
    caret: 'initial',
  });
  await page.goto('/');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('.live')).toHaveAttribute('data-active', 'true');
  await page.screenshot({
    path: '.local/screenshots/dashboard.png',
    fullPage: true,
    caret: 'initial',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByLabel('Control API access token')).toBeVisible();
});
