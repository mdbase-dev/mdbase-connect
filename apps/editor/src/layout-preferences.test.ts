import { describe, expect, it } from "vitest";
import {
  defaultLayoutPreferences,
  loadLayoutPreferences,
  saveLayoutPreferences
} from "./layout-preferences";

describe("layout preferences", () => {
  it("uses calm defaults when no layout has been saved", () => {
    expect(loadLayoutPreferences()).toEqual(defaultLayoutPreferences);
  });

  it("persists widths and independent collapse state", () => {
    saveLayoutPreferences({
      collectionWidth: 212,
      listWidth: 388,
      inspectorWidth: 420,
      collectionCollapsed: true,
      listCollapsed: false
    });

    expect(loadLayoutPreferences()).toEqual({
      collectionWidth: 212,
      listWidth: 388,
      inspectorWidth: 420,
      collectionCollapsed: true,
      listCollapsed: false
    });
  });

  it("repairs malformed and out-of-range stored values", () => {
    localStorage.setItem("mdbase-editor:layout", JSON.stringify({
      collectionWidth: 20,
      listWidth: 900,
      inspectorWidth: 900,
      collectionCollapsed: "yes",
      listCollapsed: true
    }));

    expect(loadLayoutPreferences()).toEqual({
      collectionWidth: 144,
      listWidth: 520,
      inspectorWidth: 560,
      collectionCollapsed: false,
      listCollapsed: true
    });
  });
});
