import { expect, test, type Page } from "@playwright/test";

async function noHorizontalScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

test("critical workflow: import, analyse, explore, theme", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/");

  // Enter username → import games.
  await page.getByTestId("username").fill("e2euser");
  await page.getByTestId("import").click();
  await expect(page.getByTestId("game-row")).toHaveCount(3);

  // Open the hanging-queen game (oldest) and analyse it.
  await page.getByTestId("game-row").last().click();
  await expect(page.getByTestId("analyse")).toBeVisible();
  await page.getByTestId("analyse").click();
  await expect(page.getByText("Game review")).toBeVisible({ timeout: 30_000 });

  // The blunder is classified and explained.
  await page.getByTestId("move-4").click();
  const review = page.getByTestId("move-review");
  await expect(review).toContainText("2... Qh4");
  await expect(review).toContainText("Blunder");
  await expect(review).toContainText("hangs the queen on h4");

  // Click the graph → jumps to a position.
  const graph = page.getByLabel("Evaluation graph");
  const box = (await graph.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
  await expect(page.locator(".move-cell[aria-current='true']")).toHaveCount(1);

  // Move backwards with the keyboard and the control.
  await page.getByTestId("move-4").click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("move-3")).toHaveAttribute("aria-current", "true");
  await page.getByTestId("forward").click();
  await expect(page.getByTestId("move-4")).toHaveAttribute("aria-current", "true");

  // Show the best line → variation mode → return to game.
  await page.getByTestId("show-best-line").click();
  await expect(page.getByTestId("variation-bar")).toBeVisible();
  await expect(page.getByText("Analysing variation from 2. Nf3")).toBeVisible();
  await page.getByTestId("return-to-game").click();
  await expect(page.getByTestId("variation-bar")).toHaveCount(0);
  await expect(page.getByTestId("move-3")).toHaveAttribute("aria-current", "true");

  // Change theme.
  await page.getByTestId("palette").selectOption("orange");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "orange");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "orange");
  await page.getByTestId("palette").selectOption("navy");
});

test("a user move from a historical position starts a variation without changing the game", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("game-row").last().click();
  await page.getByTestId("move-2").click();
  // Click-to-move: g1 → f3 is the game move; play b1 → c3 instead.
  await page.locator('#chessanalyser-board-square-b1').click();
  await page.locator('#chessanalyser-board-square-c3').click();
  await expect(page.getByTestId("variation-bar")).toContainText("Nc3");
  await page.getByTestId("return-to-game").click();
  await expect(page.getByTestId("move-3")).toContainText("Nf3");
});

for (const width of [320, 1366, 1920]) {
  test(`no horizontal scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.getByTestId("game-row").first().click();
    await expect(page.getByTestId("analyse").or(page.getByText("Reanalyse"))).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
}
