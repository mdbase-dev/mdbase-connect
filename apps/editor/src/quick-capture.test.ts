import { describe, expect, it } from "vitest";
import { quickCapture, takeQuickCapture } from "./quick-capture";

describe("quick capture", () => {
  it("prefills the title and body from shared text and links", () => {
    expect(quickCapture(new URLSearchParams("new=Groceries"))).toEqual({ title: "Groceries" });
    expect(quickCapture(new URLSearchParams("new=Read&text=Worth+a+look&url=https://example.com/a")))
      .toEqual({ title: "Read", body: "Worth a look\n\nhttps://example.com/a" });
    expect(quickCapture(new URLSearchParams("text=See+https://example.com/a&url=https://example.com/a")))
      .toEqual({ body: "See https://example.com/a" });
    expect(quickCapture(new URLSearchParams("new="))).toEqual({});
  });

  it("consumes the request from the URL and keeps other parameters", () => {
    history.replaceState({ kept: true }, "", "/?server=https://connect.test&new=Plan&text=Draft");
    expect(takeQuickCapture()).toEqual({ title: "Plan", body: "Draft" });
    expect(location.search).toBe("?server=https%3A%2F%2Fconnect.test");
    expect(history.state).toEqual({ kept: true });
    expect(takeQuickCapture()).toBeUndefined();
  });
});
