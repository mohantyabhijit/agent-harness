import { expect, test } from "@playwright/test";

test("lets a contributor choose a space and reach discovery", async ({ page }) => {
  await page.route("**/api/spaces", async (route) => route.fulfill({ json: { spaces: ["ai_ml", "developer_tools", "web", "data", "social_impact"] } }));
  await page.route("**/api/discovery/repositories", async (route) => route.fulfill({ json: { repositories: [] } }));
  await page.goto("/");
  await page.getByLabel("Operator capability").fill("fixture-capability");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: /what kind of open source/i })).toBeVisible();
  await page.getByRole("button", { name: /developer tools/i }).click();
  await expect(page).toHaveURL(/\/discover\?spaces=developer_tools/);
  await expect(page.getByRole("heading", { name: /find a project worth your next pull request/i })).toBeVisible();
  await expect(page.getByText(/no recommendations yet/i)).toBeVisible();
  await expect(page.getByRole("status")).not.toContainText("LIVE EVIDENCE");
});

test("classifies conversational intake before verified discovery", async ({ page }) => {
  await page.route("**/api/spaces", async (route) => route.fulfill({ json: { spaces: ["ai_ml", "developer_tools", "web", "data", "social_impact"] } }));
  await page.route("**/api/discovery/classify", async (route) => route.fulfill({ json: { kind: "category", space: "data" } }));
  await page.route("**/api/discovery/repositories", async (route) => route.fulfill({ json: { repositories: [] } }));
  await page.goto("/");
  await page.getByLabel("Operator capability").fill("fixture-capability");
  await page.getByRole("button", { name: "Connect" }).click();

  await page.getByRole("textbox", { name: /what would you like to contribute to/i }).fill("I want database infrastructure projects");
  await page.getByRole("button", { name: /find repositories/i }).click();
  await expect(page).toHaveURL(/\/discover\?spaces=data/);
});
