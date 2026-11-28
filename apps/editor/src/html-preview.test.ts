import { describe, expect, it } from "vitest";
import {
  isHtmlPreviewFile,
  MAX_HTML_SOURCE_CHARACTERS,
  prepareHtmlPreviewDocument,
  truncateHtmlSource
} from "./html-preview";
import type { CollectionFile } from "./model";

function makeFile(overrides: Partial<CollectionFile> = {}): CollectionFile {
  return {
    fileId: "00000000-0000-4000-8000-000000000001",
    path: "files/reader/page.html",
    revision: "r1",
    contentDigest: `sha256:${"a".repeat(64)}`,
    size: 128,
    mediaClass: "other",
    mediaType: "text/html",
    modifiedAt: "",
    ...overrides
  };
}

describe("isHtmlPreviewFile", () => {
  it.each([
    { path: "files/page.html", mediaType: "text/html" },
    { path: "files/page.htm", mediaType: "TEXT/HTML; charset=utf-8" },
    { path: "files/page.xhtml", mediaType: "application/xhtml+xml" },
    { path: "files/page.html", mediaType: undefined },
    { path: "files/page.HTM", mediaType: "application/octet-stream" }
  ])("identifies HTML files: %j", (overrides) => {
    expect(isHtmlPreviewFile(makeFile(overrides))).toBe(true);
  });

  it.each([
    { contentProfile: "unindexed_markdown_blob" as const, mediaType: "text/html", path: "note.html" },
    { contentProfile: "unindexed_markdown_attachment_v1" as const, mediaType: "text/html", path: "note.html" },
    { mediaClass: "image" as const, mediaType: "text/html", path: "upload.html" },
    { mediaClass: "pdf" as const, mediaType: "text/html", path: "upload.html" },
    { mediaType: "text/plain", path: "snippet.html" },
    { mediaType: "application/json", path: "data.json" },
    { mediaType: undefined, path: "archive.bin" }
  ])("rejects non-HTML or higher-precedence files: %j", (overrides) => {
    expect(isHtmlPreviewFile(makeFile(overrides))).toBe(false);
  });
});

describe("prepareHtmlPreviewDocument", () => {
  it("strips scripts, base tags, refresh and author CSP metas, and prepends strict CSP and referrer", () => {
    const raw = `<!doctype html>
      <html>
        <head>
          <base href="https://evil.example/">
          <meta http-equiv="Refresh" content="0; url=https://evil.example/">
          <meta http-equiv="Content-Security-Policy" content="default-src https://evil.example">
          <style>body { color: #222; }</style>
          <script>window.pwned = true;</script>
        </head>
        <body>
          <p>Hello</p>
          <noscript><p>Fallback</p></noscript>
          <img src="data:image/png;base64,AAAA" alt="inline">
          <script src="https://evil.example/a.js"></script>
        </body>
      </html>`;
    const prepared = prepareHtmlPreviewDocument(raw);
    expect(prepared.startsWith("<!DOCTYPE html>\n")).toBe(true);
    const parsed = new DOMParser().parseFromString(prepared, "text/html");
    expect(parsed.querySelectorAll("script, base")).toHaveLength(0);
    expect(parsed.querySelector('meta[http-equiv="Refresh" i]')).toBeNull();
    const csps = [...parsed.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')];
    expect(csps).toHaveLength(1);
    expect(csps[0].getAttribute("content")).toContain("default-src 'none'");
    expect(csps[0].getAttribute("content")).toContain("style-src 'unsafe-inline'");
    expect(csps[0].getAttribute("content")).toContain("img-src data:");
    expect(csps[0].getAttribute("content")).toContain("frame-src 'none'");
    expect(parsed.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    expect(parsed.querySelector("style")?.textContent).toBe("body { color: #222; }");
    expect(parsed.querySelector("noscript")).not.toBeNull();
    expect(parsed.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("rewrites http(s) links to open in a new tab, keeps #anchors in-page, and strips unsafe or relative hrefs", () => {
    const raw = `<html><body>
      <a id="ext" href="https://example.com/article?x=1">External</a>
      <a id="http" href="http://example.com/">HTTP</a>
      <a id="anchor" href="#section-2" target="_blank">Anchor</a>
      <a id="js" href="javascript:alert(1)">JS</a>
      <a id="data" href="data:text/html,<script>alert(1)</script>">Data</a>
      <a id="blob" href="blob:https://editor.mdbase.dev/123">Blob</a>
      <a id="rel" href="/other/page.html" target="_top">Relative</a>
      <map name="m"><area id="area-ext" href="https://example.org/map"><area id="area-js" href="javascript:void(0)"></map>
    </body></html>`;
    const parsed = new DOMParser().parseFromString(prepareHtmlPreviewDocument(raw), "text/html");

    expect(parsed.getElementById("ext")?.getAttribute("href")).toBe("https://example.com/article?x=1");
    expect(parsed.getElementById("ext")?.getAttribute("target")).toBe("_blank");
    expect(parsed.getElementById("ext")?.getAttribute("rel")).toBe("noopener noreferrer");

    expect(parsed.getElementById("http")?.getAttribute("href")).toBe("http://example.com/");
    expect(parsed.getElementById("http")?.getAttribute("target")).toBe("_blank");
    expect(parsed.getElementById("http")?.getAttribute("rel")).toBe("noopener noreferrer");

    expect(parsed.getElementById("anchor")?.getAttribute("href")).toBe("about:srcdoc#section-2");
    expect(parsed.getElementById("anchor")?.getAttribute("target")).toBeNull();

    for (const id of ["js", "data", "blob", "rel", "area-js"]) {
      const element = parsed.getElementById(id);
      expect(element?.getAttribute("href")).toBeNull();
      expect(element?.getAttribute("target")).toBeNull();
      expect(element?.getAttribute("rel")).toBeNull();
    }

    expect(parsed.getElementById("area-ext")?.getAttribute("href")).toBe("https://example.org/map");
    expect(parsed.getElementById("area-ext")?.getAttribute("target")).toBe("_blank");
    expect(parsed.getElementById("area-ext")?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("truncateHtmlSource", () => {
  it("keeps sources within the character ceiling intact", () => {
    expect(truncateHtmlSource("<p>short</p>")).toEqual({ text: "<p>short</p>", truncated: false });
  });

  it("truncates oversized source without splitting a UTF-16 surrogate pair", () => {
    const boundary = "a".repeat(MAX_HTML_SOURCE_CHARACTERS - 1) + "😀" + "b";
    const result = truncateHtmlSource(boundary);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(MAX_HTML_SOURCE_CHARACTERS - 1);
  });
});
