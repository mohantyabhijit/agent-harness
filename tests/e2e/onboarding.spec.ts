import { expect, test } from "@playwright/test";

const spaces = { spaces: ["ai_ml", "developer_tools", "web", "data", "social_impact"] };

test("opens directly into native TrueForge chat and validated quick starts", async ({ page }) => {
  await page.route("**/api/spaces", async (route) => route.fulfill({ json: spaces }));
  await page.route("**/api/discovery/repositories", async (route) => route.fulfill({ json: { repositories: [] } }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /find work that is worth shipping/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /tell openquest what you want to build/i })).toBeVisible();
  await expect(page.getByText(/trueforge native workspace/i)).toBeVisible();
  await expect(page.getByLabel(/operator capability/i)).toHaveCount(0);

  await page.getByRole("button", { name: /developer tools/i }).click();
  await expect(page).toHaveURL(/\/discover\?spaces=developer_tools/);
  await expect(page.getByRole("heading", { name: /find your next contribution/i })).toBeVisible();
  await expect(page.getByText(/no recommendations yet/i)).toBeVisible();
});

test("fails closed and lets the user return to native chat", async ({ page }) => {
  await page.route("**/api/spaces", async (route) => route.fulfill({ json: spaces }));
  await page.route("**/api/discovery/repositories", async (route) => route.fulfill({ status: 503, json: { code: "harness_unavailable", message: "Agent harness is unavailable" } }));
  await page.goto("/discover?spaces=data");

  await expect(page.getByRole("heading", { name: /verification did not finish/i })).toBeVisible();
  await expect(page.getByText(/no unverified recommendations were shown/i)).toBeVisible();
  await page.getByRole("button", { name: /back to chat/i }).last().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /tell openquest what you want to build/i })).toBeVisible();
});
