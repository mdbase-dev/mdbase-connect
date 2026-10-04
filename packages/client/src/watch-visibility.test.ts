import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseCollectionClient } from "./collection-client.js";

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  show(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("change polling in hidden pages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("backs off while the page is hidden and polls at once when it is visible again", async () => {
    vi.useFakeTimers();
    const page = new FakeDocument();
    vi.stubGlobal("document", page);
    let polls = 0;
    const client = new MdbaseCollectionClient({
      async operation<Result>() {
        polls += 1;
        return { events: [], cursor: polls, has_more: false } as Result;
      }
    });
    const controller = new AbortController();
    const watching = client.watch({ pollIntervalMs: 1_000, signal: controller.signal }).next();

    // Bootstrap reads the head cursor, then polls from it.
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toBe(3);

    page.show("hidden");
    // The delay already under way when the page was hidden still completes.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toBe(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls).toBe(4);

    page.show("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toBe(6);

    // A page hidden for longer still checks once a minute.
    page.show("hidden");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toBe(7);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(polls).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(8);

    controller.abort();
    await expect(watching).resolves.toEqual({ done: true, value: undefined });
  });

  it("polls at the requested interval outside a browser", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", undefined);
    let polls = 0;
    const client = new MdbaseCollectionClient({
      async operation<Result>() {
        polls += 1;
        return { events: [], cursor: polls, has_more: false } as Result;
      }
    });
    const controller = new AbortController();
    const watching = client.watch({ pollIntervalMs: 1_000, signal: controller.signal }).next();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(polls).toBe(5);
    controller.abort();
    await expect(watching).resolves.toEqual({ done: true, value: undefined });
  });
});
