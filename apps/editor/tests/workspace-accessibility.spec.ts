import AxeBuilder from "@axe-core/playwright";
import { expect, test, type FrameLocator, type Page, type TestInfo } from "@playwright/test";
import type { TestApp } from "@mdbase-dev/sdk/testing";
import { replaceOpeningNoteBody } from "./note-body";

const fixture = "tests/fixtures/editor-regressions.html";

async function audit(page: Page, testInfo: TestInfo, surface: string, frame?: FrameLocator) {
  const overflow = await (frame ?? page).locator("html").evaluate(element => {
    const withinWidth = (node: Element) => node.scrollWidth <= node.clientWidth + 1;
    return [element, ...element.querySelectorAll(".conflict-resolver")].filter(node => !withinWidth(node))
      .map(node => ({ element: node.className || node.tagName, width: node.clientWidth, content: node.scrollWidth }));
  });
  expect.soft(overflow, surface).toEqual([]);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const findings = violations.map(rule => ({
    rule: rule.id,
    nodes: rule.nodes.map(({ target, failureSummary }) => ({ target, failureSummary }))
  }));
  await testInfo.attach(surface, { body: JSON.stringify(findings, null, 2), contentType: "application/json" });
  expect.soft(findings, surface).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [360, 1280]) {
    test(`Editor surfaces pass axe at ${width}px in ${colorScheme}`, async ({ page, context }, testInfo) => {
      test.setTimeout(90_000);
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 820 });
      await page.goto(fixture);
      const body = page.getByRole("textbox", { name: "Note body", exact: true });
      await expect(body).toBeVisible();
      await audit(page, testInfo, "workspace");

      await page.getByRole("button", { name: "Note properties", exact: true }).click();
      const rating = page.getByRole("textbox", { name: "rating" });
      await rating.fill("9");
      await rating.press("Tab");
      await expect(page.getByText("Enter 5 or less.")).toBeVisible();
      await audit(page, testInfo, "properties");
      await page.getByRole("button", { name: "Close properties" }).click();

      if (width === 360) {
        await page.getByRole("button", { name: "Back to notes", exact: true }).click();
        await page.getByRole("button", { name: "Collections", exact: true }).click();
      }
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const collection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Collection", exact: true }) });
      await collection.getByText("Details", { exact: true }).click();
      await audit(page, testInfo, "settings");

      await page.goto("?demo=4");
      await replaceOpeningNoteBody(body, "A revised version of the note.");
      await expect(page.getByRole("main", { name: "Note editor" })).toHaveAttribute("data-save-state", "saved");
      if (width === 360) {
        await page.getByRole("button", { name: "More note actions" }).click();
        await page.getByRole("menuitem", { name: "Version history", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Version history", exact: true }).click();
      }
      const history = page.getByRole("complementary", { name: "Version history" });
      await history.getByRole("button", { name: /Created/ }).click();
      await expect(history.getByRole("table", { name: "Differences from the note now" })).toBeVisible();
      await audit(page, testInfo, "version-history");

      await page.goto(`${fixture}?scenario=offline-replica`);
      const iframe = page.locator('iframe[title="Editor"]');
      await iframe.evaluate(element => { (element as HTMLElement).style.border = "0"; });
      const frame = iframe.contentFrame();
      const offlineBody = frame.getByRole("textbox", { name: "Note body" });
      await expect(offlineBody).toHaveText("Base text");
      await page.evaluate(async () => {
        await navigator.serviceWorker.register("/mdbase-shell-sw.js", { type: "module" });
        await navigator.serviceWorker.ready;
      });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.evaluate(() => (window as Window & { offlineFixture: TestApp }).offlineFixture.replica().setOnline(false));
      const recoveredText = `Offline edits to recover ${"long-unsaved-fragment".repeat(12)}`;
      await offlineBody.fill(recoveredText);
      await expect.poll(() => page.evaluate(() => {
        const key = Object.keys(localStorage).find(name => name.startsWith("mdbase-editor:draft:v1:"));
        return key && JSON.parse(localStorage.getItem(key)!).awaitingSync;
      })).toBe(true);
      await context.setOffline(false);
      await page.evaluate(() => {
        const fixture = (window as Window & { offlineFixture: TestApp }).offlineFixture;
        const [pending] = fixture.client().ledger.getSnapshot().pending;
        fixture.replica().reject(pending.mutationId);
        fixture.replica().editElsewhere(pending.records[0], { body: "Concurrent remote edit" });
        fixture.replica().setOnline(true);
      });
      await expect(offlineBody).toHaveText("Concurrent remote edit");
      const recovery = frame.getByRole("status", { name: "Unsaved draft found" });
      await recovery.getByText("Review recovered text").click();
      await expect(recovery.locator("pre")).toHaveText(recoveredText);
      await audit(page, testInfo, "draft-recovery", frame);
      await recovery.getByRole("button", { name: "Restore unsaved edits" }).click();
      const conflict = frame.getByRole("alert", { name: "Note changed elsewhere" });
      await conflict.getByText("Review differences").click();
      await expect(conflict.getByRole("table", { name: "Body differences" })).toBeVisible();
      await audit(page, testInfo, "conflict-recovery", frame);
    });
  }
}
