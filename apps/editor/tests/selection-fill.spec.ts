import { expect, test, type Locator } from "@playwright/test";

async function measureSurface(surface: Locator) {
  await expect(surface).toBeVisible();
  return surface.evaluate(element => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas").getContext("2d")!;
    const luminance = (color: string) => {
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      const channels = [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const background = luminance(style.backgroundColor);
    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const contrasts: Array<{ text: string; ratio: number }> = [];
    while (text.nextNode()) {
      const parent = text.currentNode.parentElement!;
      if (!text.currentNode.textContent?.trim() || !parent.getBoundingClientRect().width || parent.closest("svg, .sr-only")) continue;
      const foreground = luminance(getComputedStyle(parent).color);
      contrasts.push({ text: text.currentNode.textContent, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) });
    }
    return {
      left: style.borderLeftWidth, right: style.borderRightWidth, padding: style.paddingLeft,
      shadow: style.boxShadow, background: style.backgroundColor, image: style.backgroundImage,
      pseudo: ["::before", "::after"].map(pseudo => getComputedStyle(element, pseudo).content),
      contrasts
    };
  });
}

function expectPlainFill(measurement: Awaited<ReturnType<typeof measureSurface>>, padding: string) {
  expect.soft(measurement.left).toBe("0px");
  expect.soft(measurement.right).toBe("0px");
  expect.soft(measurement.padding).toBe(padding);
  expect.soft(measurement.shadow).toBe("none");
  expect.soft(measurement.image).toBe("none");
  expect.soft(measurement.background).not.toBe("rgba(0, 0, 0, 0)");
  expect.soft(measurement.pseudo).toEqual(["none", "none"]);
  expect(measurement.contrasts.length).toBeGreaterThan(0);
  for (const contrast of measurement.contrasts) expect.soft(contrast.ratio, contrast.text).toBeGreaterThanOrEqual(4.5);
}

for (const theme of ["light", "dark"] as const) {
  test(`shared collection notice tones use tint instead of an edge stripe in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("?demo=12");
    await expect(page.locator(".title-input")).toBeVisible();
    await page.evaluate(() => {
      const fixture = document.createElement("section");
      fixture.className = "mdbase-collections";
      fixture.style.cssText = "position:fixed;inset:16px;z-index:1000;background:var(--canvas);padding:16px;display:grid;gap:16px;align-content:start";
      for (const tone of ["warning", "error", "info"]) for (const variant of ["block", "inline", "banner"]) {
        const notice = document.createElement("div");
        notice.className = `mdbase-collections-notice is-${variant}`;
        notice.dataset.tone = tone;
        const message = document.createElement("p");
        message.className = "mdbase-collections-notice-message";
        message.textContent = `${tone} ${variant}`;
        notice.append(message);
        fixture.append(notice);
      }
      document.body.append(fixture);
    });
    const measurements = [];
    for (const notice of await page.locator(".mdbase-collections-notice").all()) {
      const banner = await notice.evaluate(element => element.classList.contains("is-banner"));
      const inline = await notice.evaluate(element => element.classList.contains("is-inline"));
      const measurement = await measureSurface(notice);
      expect(measurement.left).toBe(banner ? "0px" : "1px");
      expect(measurement.right).toBe(measurement.left);
      expect(measurement.padding).toBe(banner || inline ? "14px" : "16px");
      if (!banner) expect(await notice.evaluate(element => {
        const style = getComputedStyle(element);
        return style.borderLeftColor === style.borderRightColor;
      })).toBe(true);
      expect(measurement.image).toBe("none");
      expect(measurement.shadow).toBe("none");
      expect(measurement.pseudo).toEqual(["none", "none"]);
      for (const contrast of measurement.contrasts) expect(contrast.ratio, contrast.text).toBeGreaterThanOrEqual(4.5);
      measurements.push(measurement);
    }
    await testInfo.attach("collection-notice-measurements", { contentType: "application/json", body: JSON.stringify({ theme, measurements }) });
    await page.screenshot({ path: testInfo.outputPath("collection-notice-tints.png") });
  });

  for (const width of [1440, 390]) {
    test(`note and palette selections use aligned plain fills in ${theme} at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto("?demo=12");
      await expect(page.locator(".title-input")).toBeVisible();
      if (width === 390) await page.getByRole("button", { name: "Back to notes", exact: true }).click();
      const note = await measureSurface(page.locator(".note-row.selected"));
      expectPlainFill(note, "18px");
      await expect(page.locator(".note-row:not(.selected)").first()).toHaveCSS("padding-left", "18px");
      await expect(page.locator(".note-row:not(.selected)").first()).toHaveCSS("border-left-width", "0px");
      await expect(page.locator(".note-row.selected")).toHaveCSS("border-bottom-width", "1px");
      await page.screenshot({ path: testInfo.outputPath("note-fill.png") });
      await page.keyboard.press("Control+k");
      const input = page.getByRole("combobox", { name: "Find a note or action" });
      await expect(input).toBeFocused();
      const selected = page.locator('.mdbase-command-results > button[aria-selected="true"]');
      const palette = await measureSurface(selected);
      expectPlainFill(palette, "10px");
      const nextId = await page.locator('.mdbase-command-results > button[aria-selected="false"]').first().getAttribute("id");
      const next = page.locator(`[id="${nextId}"]`);
      const before = await next.locator(".mdbase-command-copy").evaluate(element => element.getBoundingClientRect().left);
      await page.keyboard.press("ArrowDown");
      await expect(next).toHaveAttribute("aria-selected", "true");
      expect(await next.locator(".mdbase-command-copy").evaluate(element => element.getBoundingClientRect().left)).toBe(before);
      expectPlainFill(await measureSurface(next), "10px");
      await testInfo.attach("fill-measurements", { contentType: "application/json", body: JSON.stringify({ theme, width, note, palette }) });
      await page.screenshot({ path: testInfo.outputPath("palette-fill.png") });
    });
  }

  test(`type and navigation selections and caution use no edge stripe in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.route("https://mdbase.dev/contracts/catalog.json", route => route.fulfill({ json: {
      catalog_version: 2, id: "dev.mdbase.first-party", name: "mdbase contracts", description: "Ready-made types",
      homepage: "https://mdbase.dev/contracts/", publisher: { name: "mdbase", url: "https://mdbase.dev/" }, contracts: [],
      packs: [{
        id: "mdbase.contact", version: "1.0.0", name: "Contact", description: "Contact records",
        digest: `sha256:${"1".repeat(64)}`, provision: "./packs/contact.json", provides: [], resource_count: 1,
        display: { name: "Contact", summary: "Contact records", category: "people", audience: "general", icon: "address-book", badges: [] },
        installation: { visibility: "default", recommendation: "user", primary_type: "contact", types: [{ name: "contact", label: "Contact" }], caution: "Review the type before adding it." }
      }]
    } }));
    await page.goto("?demo=12");
    await expect(page.locator(".note-scroll")).toBeFocused();
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    const type = await measureSurface(page.locator(".type-row.selected"));
    const nav = await measureSurface(page.locator(".collection-rail nav button.selected"));
    expectPlainFill(type, "18px");
    expectPlainFill(nav, "8px");
    await expect(page.locator(".type-list-pane")).toHaveCSS("border-right-width", "1px");
    const packs = page.getByRole("button", { name: /Add a type Start blank/ });
    const before = await packs.locator(".type-row-copy").evaluate(element => element.getBoundingClientRect().left);
    await packs.click();
    const pack = await measureSurface(packs);
    expectPlainFill(pack, "18px");
    expect(await packs.locator(".type-row-copy").evaluate(element => element.getBoundingClientRect().left)).toBe(before);
    await expect(page.locator(".type-row")).toHaveCSS("padding-left", "18px");
    await expect(page.locator(".type-row")).toHaveCSS("border-left-width", "0px");
    const caution = page.locator(".contract-catalog-pack-caution");
    const warning = await measureSurface(caution);
    expectPlainFill(warning, "12px");
    await expect(caution.locator("svg")).toBeVisible();
    await testInfo.attach("fill-measurements", { contentType: "application/json", body: JSON.stringify({ theme, type, nav, pack, warning }) });
    await page.screenshot({ path: testInfo.outputPath("type-and-caution-fill.png") });
  });
}
