import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyThemePreference, loadThemePreference, saveThemePreference } from "./theme";

describe("theme preference", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  });

  it("defaults unsupported values to the system theme", () => {
    localStorage.setItem("mdbase:theme", "sepia");
    expect(loadThemePreference()).toBe("system");
  });

  it("persists and applies explicit themes", () => {
    saveThemePreference("dark");
    expect(localStorage.getItem("mdbase:theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    applyThemePreference("system");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });
});
