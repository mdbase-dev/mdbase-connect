// @vitest-environment jsdom
import "../test/dialog.js";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useOverlay } from "./overlay.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); });

function Overlay({ open }: { open: boolean }) {
  const { ref, present } = useOverlay<HTMLDivElement>(open);
  return present ? <div ref={ref} data-open={open} /> : null;
}

it("keeps native dialogs and their backdrops displayed for discrete exits", () => {
  const css = readFileSync("css/motion.css", "utf8");
  expect(css).toMatch(/\.mdbase-dialog\.mdbase-overlay\s*\{[^}]*transition-property: opacity, transform, display, overlay;[^}]*allow-discrete/);
  expect(css).toMatch(/\.mdbase-dialog\.mdbase-overlay::backdrop\s*\{[^}]*transition-property: opacity, display, overlay;[^}]*allow-discrete/);
});

it("waits for every actual exit animation, including cancellation", async () => {
  let finishOpacity!: () => void;
  let cancelTransform!: (cause: Error) => void;
  const opacity = new Promise<void>(resolve => { finishOpacity = resolve; });
  const transform = new Promise<void>((_resolve, reject) => { cancelTransform = reject; });
  vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([{ finished: opacity }, { finished: transform }] as Animation[]);
  await act(async () => root.render(<Overlay open />));
  await act(async () => root.render(<Overlay open={false} />));
  expect(host.firstChild).not.toBeNull();
  await act(async () => finishOpacity());
  expect(host.firstChild).not.toBeNull();
  await act(async () => cancelTransform(new Error("cancelled")));
  expect(host.firstChild).toBeNull();
});

it("does not let a stale exit remove a reopened overlay", async () => {
  let finish!: () => void;
  vi.spyOn(HTMLElement.prototype, "getAnimations").mockReturnValue([{ finished: new Promise<void>(resolve => { finish = resolve; }) }] as Animation[]);
  await act(async () => root.render(<Overlay open />));
  await act(async () => root.render(<Overlay open={false} />));
  await act(async () => root.render(<Overlay open />));
  await act(async () => finish());
  expect(host.firstChild).not.toBeNull();
});

it("removes an exit with no animations without waiting for a nominal duration", async () => {
  await act(async () => root.render(<Overlay open />));
  (host.firstChild as HTMLElement).style.transitionDuration = "10s";
  await act(async () => root.render(<Overlay open={false} />));
  expect(host.firstChild).toBeNull();
});
