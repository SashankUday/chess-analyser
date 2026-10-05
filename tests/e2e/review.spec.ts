import { expect, test, type Page } from "@playwright/test";

// Games are listed newest first: promotion, opera-game, missed-mate, legal-mate, hanging-queen.
const row = (page: Page, which: "promotion" | "opera" | "hanging-queen") =>
  which === "promotion"
    ? page.getByTestId("game-row").first()
    : which === "opera"
      ? page.getByTestId("game-row").nth(1)
      : page.getByTestId("game-row").last();

async function noHorizontalScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function analyse(page: Page) {
  await page.getByTestId("analyse").click();
  await expect(page.getByText("Game review", { exact: true })).toBeVisible({ timeout: 45_000 });
}

test("critical workflow: import, analyse, explore, theme", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/");

  await page.getByTestId("username").fill("e2euser");
  await page.getByTestId("import").click();
  await expect(page.getByTestId("game-row")).toHaveCount(5);

  await row(page, "hanging-queen").click();
  await analyse(page);

  // The blunder is classified and explained with a concrete, engine-grounded reason.
  await page.getByTestId("move-4").click();
  const review = page.getByTestId("move-review");
  await expect(review).toContainText("2... Qh4");
  await expect(review).toContainText("Blunder");
  await expect(page.getByTestId("explanation")).toContainText("loses the queen");

  // Click the graph → jumps to a position.
  const graph = page.getByLabel("Evaluation graph");
  const box = (await graph.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
  await expect(page.locator(".move-cell[aria-current='true']")).toHaveCount(1);

  // Move backwards with the keyboard and forwards with the control.
  await page.getByTestId("move-4").click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("move-3")).toHaveAttribute("aria-current", "true");
  await page.getByTestId("forward").click();
  await expect(page.getByTestId("move-4")).toHaveAttribute("aria-current", "true");

  // Show the best line → ENGINE VARIATION → return to game.
  await page.getByTestId("show-best-line").click();
  await expect(page.getByTestId("mode-banner")).toContainText("ENGINE VARIATION");
  await expect(page.getByTestId("mode-banner")).toContainText("after 2. Nf3");
  await expect(page.getByTestId("variation-bar")).toBeVisible();
  await page.getByTestId("return-to-game").click();
  await expect(page.getByTestId("mode-banner")).toHaveCount(0);
  await expect(page.getByTestId("move-3")).toHaveAttribute("aria-current", "true");

  // Change theme.
  await page.getByTestId("palette").selectOption("orange");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "orange");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "orange");
  await page.getByTestId("palette").selectOption("navy");
});

test("user variations are analysed, extendable and branch without changing the game", async ({ page }) => {
  await page.goto("/");
  await row(page, "hanging-queen").click();
  await page.getByTestId("move-2").click();

  // Click-to-move: g1→f3 is the game move; play b1→c3 instead.
  await page.locator("#chessanalyser-board-square-b1").click();
  await page.locator("#chessanalyser-board-square-c3").click();
  await expect(page.getByTestId("mode-banner")).toContainText("YOUR VARIATION");
  const panel = page.getByTestId("user-variation");
  await expect(panel).toContainText("Nc3");
  await expect(panel).toContainText("Best response");
  await expect(page.getByTestId("best-continuation")).toBeVisible();

  // Play Stockfish's suggested reply into the variation.
  await page.getByTestId("best-continuation").locator("button").first().click();
  await expect(page.getByTestId("variation-bar").locator("button.line-move")).toHaveCount(2);

  // Go back to the branch position and play a different first move → a new branch.
  await page.keyboard.press("Home");
  await page.locator("#chessanalyser-board-square-d2").click();
  await page.locator("#chessanalyser-board-square-d4").click();
  await expect(panel).toContainText("Branches");
  await expect(panel.locator(".branch-list button")).toHaveCount(2);

  await page.getByTestId("return-to-game").click();
  await expect(page.getByTestId("move-3")).toContainText("Nf3");
});

test("promotion offers a choice of piece (underpromotion)", async ({ page }) => {
  await page.goto("/");
  await row(page, "promotion").click();
  await page.locator("#chessanalyser-board-square-a7").click();
  await page.locator("#chessanalyser-board-square-a8").click();
  await expect(page.getByRole("dialog", { name: "Choose promotion piece" })).toBeVisible();
  await page.getByTestId("promote-n").click();
  await expect(page.getByTestId("variation-bar")).toContainText("a8=N");
});

test("navigating moves never scrolls the page away from the board", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 700 });
  await page.goto("/");
  await row(page, "opera").click();
  await expect(page.getByTestId("move-33")).toBeAttached();
  await page.evaluate(() => window.scrollTo(0, 120));
  const before = await page.evaluate(() => window.scrollY);
  for (let i = 0; i < 33; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("move-33")).toHaveAttribute("aria-current", "true");
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  // The move list scrolled itself to keep the current move visible.
  expect(await page.locator(".move-table").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // Jumping around (Home / End / arrows) never moves the page either. (Mouse clicks are not used
  // here because Playwright itself scrolls the window to reach an off-screen element.)
  await page.keyboard.press("Home");
  await expect(page.getByTestId("move-1")).toHaveAttribute("aria-current", "false");
  expect(await page.locator(".move-table").evaluate((el) => el.scrollTop)).toBe(0);
  await page.keyboard.press("End");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("move-28")).toHaveAttribute("aria-current", "true");
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("debug review mode shows the same-root diagnostics", async ({ page }) => {
  await page.goto("/?debugReview=1");
  await row(page, "hanging-queen").click();
  await expect(page.getByTestId("analyse")).toBeVisible();
  if ((await page.getByTestId("analyse").textContent()) !== "Reanalyse") await analyse(page);
  await page.getByTestId("move-4").click();
  const debug = page.getByTestId("debug-panel");
  await expect(debug).toContainText("Stockfish rank");
  await expect(debug).toContainText("from Black POV");
  await expect(debug).toContainText("Result transition");
  await expect(debug).toContainText("Review Algorithm 2");
});

for (const width of [320, 1366, 1920]) {
  test(`no horizontal scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    expect(await noHorizontalScroll(page)).toBe(true);
    await row(page, "hanging-queen").click();
    await expect(page.getByTestId("analyse").or(page.getByText("Reanalyse"))).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
}
