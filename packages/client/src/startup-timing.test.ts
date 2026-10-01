import { afterEach, expect, it, vi } from "vitest";
import { timeStartupRead } from "./startup-timing.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("does not replace a successful read when optional timing fails", async () => {
  vi.stubGlobal("window", {});
  vi.spyOn(performance, "measure").mockImplementation(() => { throw new Error("unsupported"); });
  await expect(timeStartupRead("registration", () => Promise.resolve(123))).resolves.toBe(123);
});

it("preserves the original read failure when optional timing also fails", async () => {
  vi.stubGlobal("window", {});
  vi.spyOn(performance, "measure").mockImplementation(() => { throw new Error("unsupported"); });
  const failure = new Error("original authoritative failure");
  await expect(timeStartupRead("contracts", () => Promise.reject(failure))).rejects.toBe(failure);
});
