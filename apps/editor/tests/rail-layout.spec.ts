import { expect, test } from "@playwright/test";

for (const width of [1440, 360, 390]) {
  test(`keeps collection tools fixed when folders overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await page.goto("?demo=12");
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
    if (width <= 760) {
      await page.getByRole("button", { name: "Back to notes", exact: true }).click();
      await page.getByRole("button", { name: "Collections", exact: true }).click();
    }
    const rail = page.getByRole("complementary", { name: "Collection navigation" });
    await expect(rail.getByRole("group", { name: "Folders" })).toHaveAttribute("aria-busy", "false");
    // Stress the actual rail layout without issuing dozens of unrelated writes.
    await rail.locator(".folder-tree > ul").evaluate((list) => {
      const template = list.firstElementChild!;
      for (let index = 0; index < 48; index += 1) {
        const row = template.cloneNode(true) as HTMLElement;
        const action = row.querySelector<HTMLButtonElement>(".rail-row-action")!;
        action.setAttribute("aria-label", `Show notes in Stress ${index}, 0 notes`);
        action.dataset.folderPath = `Stress ${index}`;
        action.querySelector(".rail-row-label")!.textContent = `Stress ${index}`;
        list.append(row);
      }
    });
    const scroll = rail.locator(".rail-scroll");
    const tools = rail.getByRole("group", { name: "Collection tools" });
    await expect.poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const before = await tools.boundingBox();
    expect(before).not.toBeNull();
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const after = await tools.boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 1);
    const [scrollBox, footerBox, railBox] = await Promise.all([
      scroll.boundingBox(), rail.locator(".connection-footer").boundingBox(), rail.boundingBox()
    ]);
    expect(scrollBox!.y + scrollBox!.height).toBeLessThanOrEqual(after!.y);
    expect(after!.y + after!.height).toBeLessThanOrEqual(footerBox!.y);
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(railBox!.y + railBox!.height);
    for (const target of [
      tools.getByRole("button", { name: "Types (1)" }),
      tools.getByRole("button", { name: "Settings", exact: true }),
      tools.getByRole("link", { name: "Connect", exact: true })
    ]) {
      await expect(target).toBeInViewport({ ratio: 1 });
      if (width <= 760) expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await rail.getByRole("button", { name: "New folder", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(tools.getByRole("button", { name: "Types (1)" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tools.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tools.getByRole("link", { name: "Connect", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  });
}
