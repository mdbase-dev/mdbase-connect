import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readViewBuild, viewPage, type ViewBuild } from "./view.js";

const asset = { type: "text/javascript; charset=utf-8", body: Buffer.from(""), gzip: Buffer.from("") };
const build = (page: string, names: string[] = ["index-abc.js", "index-def.css"]): ViewBuild => ({
  page,
  assets: new Map(names.map((name) => [name, asset]))
});

describe("the MCP App view page", () => {
  it("names the gateway for every file the page loads", () => {
    expect(viewPage(build(
      '<script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="./assets/index-def.css">'
    ), "https://mcp.example")).toBe(
      '<script type="module" crossorigin src="https://mcp.example/view/assets/index-abc.js"></script>'
      + '<link rel="stylesheet" crossorigin href="https://mcp.example/view/assets/index-def.css">'
    );
  });

  it("refuses a page that names a file the build lacks, or one outside its assets", () => {
    expect(() => viewPage(build('<script src="./assets/gone.js"></script>'), "https://mcp.example")).toThrow(/gone\.js/u);
    expect(() => viewPage(build('<link rel="icon" href="./favicon.svg">'), "https://mcp.example")).toThrow(/outside its assets/u);
  });

  it("reads a build's page and files, and refuses a file of an unexpected kind", () => {
    const directory = mkdtempSync(join(tmpdir(), "mdbase-view-"));
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "index.html"), "<!doctype html>");
    writeFileSync(join(directory, "assets", "index-abc.js"), "export {};");
    const read = readViewBuild(pathToFileURL(`${directory}/`));
    expect(read.page).toBe("<!doctype html>");
    const [[name, file]] = [...read.assets];
    expect(name).toBe("index-abc.js");
    expect(file).toMatchObject({ type: "text/javascript; charset=utf-8", body: Buffer.from("export {};") });
    expect(gunzipSync(file!.gzip).toString()).toBe("export {};");
    writeFileSync(join(directory, "assets", "notes.md"), "");
    expect(() => readViewBuild(pathToFileURL(`${directory}/`))).toThrow(/notes\.md/u);
  });
});
