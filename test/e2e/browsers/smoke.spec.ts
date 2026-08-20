import { expect, test } from '@playwright/test';

/**
 * The same pages render on all three engines (NFR-17). Named for what an
 * operator sees, per the task. Depth lives in the agent-browser suite.
 */

test('the landing page shows the failing repository', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Withe' })).toBeVisible();
  await expect(page.getByText('acme/lever').first()).toBeVisible();
});

test('the repository inventory lists the repositories', async ({ page }) => {
  await page.goto('/repos');
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  await expect(page.getByText('acme/sprocket').first()).toBeVisible();
});

test('a state filter in the URL narrows the inventory to matching repositories', async ({ page }) => {
  await page.goto('/repos?state=failing');
  await expect(page.getByText('acme/lever').first()).toBeVisible();
  await expect(page.getByText('acme/sprocket')).toHaveCount(0);
});

test('a repository page renders its run history', async ({ page }) => {
  await page.goto('/repos/acme/lever');
  await expect(page.getByRole('heading', { name: 'acme/lever' })).toBeVisible();
});
