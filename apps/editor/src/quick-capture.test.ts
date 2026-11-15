import { describe, expect, it } from "vitest";
import { CAPTURE_BODY_LIMIT, CAPTURE_TITLE_LIMIT, quickCapture, takeQuickCapture } from "./quick-capture";

describe("quick capture", () => {
  it("prefills the title and body from shared text and links", () => {
    expect(quickCapture(new URLSearchParams("new=Groceries"))).toEqual({ title: "Groceries" });
    expect(quickCapture(new URLSearchParams("new=Read&text=Worth+a+look&url=https://example.com/a")))
      .toEqual({ title: "Read", body: "Worth a look\n\nhttps://example.com/a" });
    expect(quickCapture(new URLSearchParams("text=See+https://example.com/a&url=https://example.com/a")))
      .toEqual({ body: "See https://example.com/a" });
    expect(quickCapture(new URLSearchParams("new="))).toEqual({});
  });

  it("keeps a capture up to its limits whole and refuses a longer one instead of cutting it", () => {
    const body = "a".repeat(CAPTURE_BODY_LIMIT);
    const title = "t".repeat(CAPTURE_TITLE_LIMIT);
    expect(quickCapture(new URLSearchParams({ new: title, text: body }))).toEqual({ title, body });
    expect(quickCapture(new URLSearchParams({ text: `${body}b` }))).toBe("too_long");
    expect(quickCapture(new URLSearchParams({ new: `${title}t` }))).toBe("too_long");
    // The limit applies to the body that would be saved, the shared link included.
    expect(quickCapture(new URLSearchParams({ text: "a".repeat(CAPTURE_BODY_LIMIT - 10), url: "https://example.com/long" })))
      .toBe("too_long");
  });

  it("consumes a refused request from the URL as well", () => {
    history.replaceState(null, "", `/?new=Plan&text=${"a".repeat(CAPTURE_BODY_LIMIT + 1)}`);
    expect(takeQuickCapture()).toBe("too_long");
    expect(location.search).toBe("");
  });

  it("consumes the request from the URL and keeps other parameters", () => {
    history.replaceState({ kept: true }, "", "/?server=https://connect.test&new=Plan&text=Draft");
    expect(takeQuickCapture()).toEqual({ title: "Plan", body: "Draft" });
    expect(location.search).toBe("?server=https%3A%2F%2Fconnect.test");
    expect(history.state).toEqual({ kept: true });
    expect(takeQuickCapture()).toBeUndefined();
  });
});
