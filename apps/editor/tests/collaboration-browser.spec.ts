import { expect, test } from "@playwright/test";

const harness = "/collaboration-harness";

test("Chromium two-editor browser adapter smoke: in-page transport only", async ({ page }) => {
  await page.goto(harness);
  await expect(page.getByRole("heading", { name: "Browser adapter smoke-test harness" })).toBeVisible();
  await expect(page.getByTestId("scope-note")).toContainText("no provider authorization, persistence, or WebSockets");

  const editorA = page.getByRole("textbox", { name: "Editor A" });
  const editorB = page.getByRole("textbox", { name: "Editor B" });
  await expect(editorA).toBeVisible();
  await expect(editorB).toBeVisible();
  const initial = await page.evaluate(() => window.__collaborationHarness!.initialBody);
  const visibleText = (editor: typeof editorA) => editor.evaluate((node) =>
    Array.from(node.querySelectorAll<HTMLElement>(".cm-line")).map((line) => line.textContent ?? "").join("\n")
  );
  expect(await visibleText(editorA)).toBe(initial);
  expect(await visibleText(editorB)).toBe(initial);

  expect(await page.evaluate(() => window.__collaborationHarness!.admit("# ok\nLF only"))).toBe(true);
  expect(await page.evaluate(() => window.__collaborationHarness!.admit("# bad\r\nCRLF"))).toBe(false);
  expect(await page.evaluate(() => window.__collaborationHarness!.admit("# bad\0NUL"))).toBe(false);
  expect(await page.evaluate(() => window.__collaborationHarness!.admit("# bad\rlone CR"))).toBe(false);
  expect(await page.evaluate(() => window.__collaborationHarness!.admit("# bad\nmixed\r\n"))).toBe(false);
  expect(await page.evaluate(() => window.__collaborationHarness!.admit("# bad\ud800surrogate"))).toBe(false);

  await page.evaluate(() => window.__collaborationHarness!.setOnline(false));
  await expect(page.getByTestId("connection-state")).toHaveText("disconnected");
  const concurrentAt = initial.indexOf("Concurrent edits");
  await page.evaluate(({ concurrentAt }) => {
    const h = window.__collaborationHarness!;
    h.edit("a", h.initialBody.length, h.initialBody.length, "A-insert ");
    h.edit("b", h.initialBody.length, h.initialBody.length, "B-insert ");
    h.edit("b", concurrentAt + "Concurrent ".length, concurrentAt + "Concurrent edits ".length, "");
  }, { concurrentAt });
  expect(await page.evaluate(() => window.__collaborationHarness!.queuedPackets())).toBe(3);
  expect(await page.evaluate(() => window.__collaborationHarness!.deliver({ reverse: true }))).toBe(false);
  const disconnected = await page.evaluate(() => ({
    a: window.__collaborationHarness!.text("a"),
    b: window.__collaborationHarness!.text("b")
  }));
  expect(disconnected.a).toContain("A-insert");
  expect(disconnected.a).not.toContain("B-insert");
  expect(disconnected.b).toContain("B-insert");
  expect(disconnected.b).not.toContain("A-insert");
  await page.evaluate(() => window.__collaborationHarness!.setOnline(true));
  expect(await page.evaluate(() => window.__collaborationHarness!.deliver({ reverse: true, duplicate: true }))).toBe(true);

  const convergedAfterConcurrent = await page.evaluate(() => {
    const h = window.__collaborationHarness!;
    return { a: h.text("a"), b: h.text("b") };
  });
  expect(convergedAfterConcurrent.a).toBe(convergedAfterConcurrent.b);
  await expect.poll(() => visibleText(editorA)).toBe(convergedAfterConcurrent.a);
  await expect.poll(() => visibleText(editorB)).toBe(convergedAfterConcurrent.a);
  const exactConcurrentBytes = await page.evaluate(() => {
    const h = window.__collaborationHarness!;
    return {
      yA: [...new TextEncoder().encode(h.text("a"))],
      yB: [...new TextEncoder().encode(h.text("b"))],
      cmA: [...new TextEncoder().encode(h.editorText("a"))],
      cmB: [...new TextEncoder().encode(h.editorText("b"))]
    };
  });
  expect(exactConcurrentBytes.cmA).toEqual(exactConcurrentBytes.yA);
  expect(exactConcurrentBytes.cmB).toEqual(exactConcurrentBytes.yB);

  await page.evaluate(() => window.__collaborationHarness!.setOnline(false));
  await page.evaluate(() => {
    const h = window.__collaborationHarness!;
    h.edit("a", h.text("a").length, h.text("a").length, " reconnect-A");
    h.edit("b", h.text("b").length, h.text("b").length, " reconnect-B");
  });
  expect(await page.evaluate(() => window.__collaborationHarness!.queuedPackets())).toBe(2);
  await page.evaluate(() => {
    window.__collaborationHarness!.setOnline(true);
    window.__collaborationHarness!.reconnectFromStateVectors();
  });
  const convergedAfterReconnect = await page.evaluate(() => window.__collaborationHarness!.text("a"));
  expect(await page.evaluate(() => window.__collaborationHarness!.text("b"))).toBe(convergedAfterReconnect);
  await expect.poll(() => visibleText(editorA)).toBe(convergedAfterReconnect);
  await expect.poll(() => visibleText(editorB)).toBe(convergedAfterReconnect);

  const beforeUndo = await page.evaluate(() => window.__collaborationHarness!.text("b"));
  await page.evaluate(() => window.__collaborationHarness!.stopUndoCapturing("b"));
  const undoDepthBeforeRemote = await page.evaluate(() => window.__collaborationHarness!.undoDepth("b"));
  await page.evaluate(() => window.__collaborationHarness!.remoteInsert("a", 0, "REMOTE "));
  await page.evaluate(() => window.__collaborationHarness!.deliver({ duplicate: true }));
  expect(await page.evaluate(() => window.__collaborationHarness!.undoDepth("b")))
    .toBe(undoDepthBeforeRemote);
  await expect.poll(() => visibleText(editorB)).toContain("REMOTE ");
  const afterRemote = await page.evaluate(() => window.__collaborationHarness!.text("b"));
  expect(afterRemote).toBe(`REMOTE ${beforeUndo}`);
  await page.evaluate(() => {
    const h = window.__collaborationHarness!;
    h.edit("b", h.text("b").length, h.text("b").length, " LOCAL");
  });
  expect(await page.evaluate(() => window.__collaborationHarness!.undoDepth("b")))
    .toBeGreaterThan(undoDepthBeforeRemote);
  await editorB.press("Control+z");
  await expect.poll(() => visibleText(editorB)).toBe(afterRemote);
  await expect.poll(() => visibleText(editorA)).toBe(afterRemote);
  expect(await page.evaluate(() => window.__collaborationHarness!.undoDepth("b")))
    .toBe(undoDepthBeforeRemote);
  await page.evaluate(() => window.__collaborationHarness!.deliver({ duplicate: true }));
  await expect.poll(() => visibleText(editorA)).toBe(afterRemote);
  expect(await page.evaluate(() => window.__collaborationHarness!.text("a"))).toBe(afterRemote);
  expect(await page.evaluate(() => window.__collaborationHarness!.text("b"))).toBe(afterRemote);
});
