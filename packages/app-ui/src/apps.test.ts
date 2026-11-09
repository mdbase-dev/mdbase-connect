import { describe, expect, it } from "vitest";

import { mdbaseAppHref, mdbaseApps, officialApps, withAppUrls } from "./apps.js";

describe("mdbaseAppHref", () => {
  it("carries the collection and server to the other app", () => {
    expect(
      mdbaseAppHref(
        "https://writer.mdbase.dev/",
        "https://reader.mdbase.dev/?collection=col_123&server=https%3A%2F%2Fconnect.example.org"
      )
    ).toBe("https://writer.mdbase.dev/?collection=col_123&server=https%3A%2F%2Fconnect.example.org");
  });

  it("leaves app-specific parameters behind", () => {
    expect(
      mdbaseAppHref(
        "https://editor.mdbase.dev/",
        "https://reader.mdbase.dev/?collection=col_123&source=smith-2021#page=4"
      )
    ).toBe("https://editor.mdbase.dev/?collection=col_123");
  });

  it("opens the app without a collection when none is selected", () => {
    expect(mdbaseAppHref("https://editor.mdbase.dev/", "https://reader.mdbase.dev/"))
      .toBe("https://editor.mdbase.dev/");
  });

  it("keeps the target app's own base path", () => {
    expect(mdbaseAppHref("http://127.0.0.1:5320/lab/", "http://127.0.0.1:5173/?collection=c"))
      .toBe("http://127.0.0.1:5320/lab/?collection=c");
  });
});

describe("mdbaseApps", () => {
  it("lists Editor first without assuming a deployment environment", () => {
    expect(mdbaseApps.map((app) => app.id)).toEqual(["editor", "reader", "writer"]);
    for (const app of mdbaseApps) {
      expect(app.url).toBe("");
    }
  });

  it("offers only the URLs a build provides, without production fallbacks", () => {
    const apps = withAppUrls({ writer: "http://127.0.0.1:5320/", reader: undefined });

    expect(apps.map((app) => app.url)).toEqual([
      "http://127.0.0.1:5320/"
    ]);
    expect(mdbaseApps[2]?.url).toBe("");
    expect(withAppUrls({})).toEqual([]);
    expect(withAppUrls({ editor: "https://editor.lab.example/", reader: "https://reader.lab.example/", writer: "https://writer.lab.example/" })
      .map(app => app.url)).toEqual(["https://editor.lab.example/", "https://reader.lab.example/", "https://writer.lab.example/"]);
  });
});

describe("officialApps", () => {
  it("adds Journal and TaskNotes after the mdbase family, with URLs from the deployment", () => {
    expect(officialApps.map((app) => app.id)).toEqual(["editor", "reader", "writer", "journal", "tasknotes"]);
    expect(withAppUrls({ tasknotes: "https://tasks.lab.example/", editor: "https://editor.lab.example/" }, officialApps)
      .map((app) => [app.id, app.url])).toEqual([["editor", "https://editor.lab.example/"], ["tasknotes", "https://tasks.lab.example/"]]);
  });
});
