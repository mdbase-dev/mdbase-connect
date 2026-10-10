#!/usr/bin/env node
// Explicit owned synthetic vault/profile/process only. Never attach to a port,
// use an existing profile, scan a live vault, or invoke the user's launcher.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import {
  assertNotLive,
  confinedPath,
  ownedEnvironment,
} from "./bases-obsidian-isolation.mjs";
import { installOwnedClock } from "./bases-obsidian-clock.mjs";
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (
    !["--binary", "--fixture", "--tasknotes", "--root"].includes(key) ||
    !process.argv[i + 1]
  )
    throw Error(
      "usage: --binary ABS --fixture JSON --tasknotes ABS --root NEW_ABS_DIRECTORY",
    );
  options[key.slice(2)] = path.resolve(process.argv[i + 1]);
}
for (const key of ["binary", "fixture", "tasknotes", "root"])
  if (!options[key]) throw Error(`missing ${key}`);
assertNotLive(options);
const root = options.root;
await fs.mkdir(root, { mode: 0o700 });
const owner = randomUUID();
await fs.writeFile(
  path.join(root, "owner.json"),
  JSON.stringify({
    owner,
    created: new Date().toISOString(),
    version: "1.12.7",
  }),
);
const fixture = JSON.parse(await fs.readFile(options.fixture, "utf8"));
if (fixture.kind !== "first-slice-filter-set-reference")
  throw Error("expected owned synthetic reference fixture");
if (
  fixture.records.some(
    (record) =>
      record.body !== undefined &&
      (typeof record.body !== "string" ||
        Buffer.byteLength(record.body) > 1 << 20),
  )
)
  throw Error("owned synthetic body must be bounded text");
const require = createRequire(path.join(options.tasknotes, "package.json"));
const { chromium } = require("@playwright/test");
const YAML = require("yaml");
fixture.parsed_bases = Object.fromEntries(
  fixture.sources.map((source) => [source.command, YAML.parse(source.source)]),
);
const vault = path.join(root, "vault"),
  profile = path.join(root, "profile"),
  runtime = path.join(root, "runtime");
for (const p of [
  vault,
  profile,
  runtime,
  path.join(vault, ".obsidian/plugins/tasknotes"),
])
  await fs.mkdir(p, { recursive: true, mode: 0o700 });
const confined = (relative) => confinedPath(vault, relative);
async function write(relative, data) {
  const output = confined(relative);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, data);
}
await write(
  ".obsidian/core-plugins.json",
  JSON.stringify(["file-explorer", "properties", "bases"]),
);
await write(".obsidian/community-plugins.json", JSON.stringify(["tasknotes"]));
await write(
  ".obsidian/types.json",
  JSON.stringify({ types: fixture.property_types }),
);
for (const name of ["main.js", "manifest.json", "styles.css"]) {
  try {
    await fs.copyFile(
      path.join(options.tasknotes, name),
      confined(".obsidian/plugins/tasknotes/" + name),
    );
  } catch (e) {
    if (name !== "styles.css") throw e;
  }
}
for (const record of fixture.records)
  await write(
    record.path,
    "---\n" +
      YAML.stringify({ ...record.note, tags: record.tags }) +
      "---\n" +
      (record.body ?? ""),
  );
for (const source of fixture.sources)
  await write("Views/" + source.command + ".base", source.source);
await write(
  "Views/oracle-seed.base",
  'formulas:\n  seed: "1"\nviews:\n  - type: table\n    name: Seed\n    order: [file.name]\n',
);
await fs.writeFile(
  path.join(profile, "obsidian.json"),
  JSON.stringify({
    vaults: { [owner]: { path: vault, ts: Date.now(), open: true } },
    updateDisabled: true,
  }),
);
const env = ownedEnvironment(process.env, root, profile, runtime);
const child = spawn(
  "xvfb-run",
  [
    "-a",
    "dbus-run-session",
    options.binary,
    "--no-sandbox",
    "--password-store=basic",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--ozone-platform=x11",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    vault,
  ],
  {
    cwd: path.dirname(options.binary),
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
await fs.writeFile(
  path.join(root, "process.json"),
  JSON.stringify({
    owner,
    pid: child.pid,
    binary: options.binary,
    vault,
    profile,
  }),
);
let browser, page;
let output = "";
let cdp;
const readiness = new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(Error("owned Electron debugger timeout")),
    60_000,
  );
  const data = (chunk) => {
    output = (output + chunk.toString()).slice(-262144);
    const match = output.match(
      /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-z0-9-]+)/i,
    );
    if (match && !cdp) {
      cdp = match[1];
      clearTimeout(timer);
      resolve(cdp);
    }
  };
  child.stdout.on("data", data);
  child.stderr.on("data", data);
  child.on("error", reject);
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(Error(`owned process exited ${code}`));
  });
});
try {
  const endpoint = await readiness;
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  page =
    context.pages()[0] ??
    (await context.waitForEvent("page", { timeout: 60000 }));
  await page.waitForFunction(
    () => window.app?.vault && window.app?.workspace?.layoutReady,
    { timeout: 60000 },
  );
  const proof = await page.evaluate(() => ({
    version:
      window.app.getVersion?.() ??
      window.require("electron").remote.app.getVersion(),
    vault: window.app.vault.adapter.getBasePath(),
    userData: window.require("electron").remote.app.getPath("userData"),
  }));
  if (
    proof.version !== "1.12.7" ||
    path.resolve(proof.vault) !== vault ||
    path.resolve(proof.userData) !== profile
  )
    throw Error(
      "version/vault/profile ownership proof failed: " + JSON.stringify(proof),
    );
  // Trust ONLY this proven-owned synthetic vault and the explicitly copied build.
  for (const name of [
    "Trust author and enable plugins",
    "Turn on community plugins",
    "Enable community plugins",
  ]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.isVisible().catch(() => false)) await button.click();
  }
  await page.waitForFunction(
    () => !!window.app.plugins.plugins.tasknotes,
    null,
    { timeout: 30000 },
  );
  await page.bringToFront();
  await page.evaluate(() => {
    const win = window.require("electron").remote.getCurrentWindow();
    win.show();
    win.focus();
  });
  // Freeze only this owned renderer, before opening any Base. Probe native
  // formulas below must independently prove now()/today(), not trust the patch.
  await page.evaluate(installOwnedClock, fixture.now_ms);
  await page.evaluate(async () => {
    const file = window.app.vault.getAbstractFileByPath(
      "Views/oracle-seed.base",
    );
    const leaf = window.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    await app.workspace.revealLeaf(leaf);
    leaf.tabHeaderEl.click();
    window.__ownedOracleLeaf = leaf;
  });
  await page.waitForFunction(
    () => window.__ownedOracleLeaf?.view?.controller?.ctx?.formulas?.seed,
    { timeout: 30000 },
  );
  await page.waitForFunction(
    (records) =>
      records.every((record) => {
        const file = window.app.vault.getAbstractFileByPath(record.path);
        const frontmatter =
          file && window.app.metadataCache.getFileCache(file)?.frontmatter;
        return (
          frontmatter?.status === record.note.status &&
          JSON.stringify(frontmatter.tags) === JSON.stringify(record.tags)
        );
      }),
    fixture.records,
    { timeout: 30000 },
  );
  const observations = await page.evaluate(
    async ({ fixture, proof }) => {
      const app = window.app;
      const controller = window.__ownedOracleLeaf.view.controller;
      const Formula = Object.getPrototypeOf(
        controller.ctx.formulas.seed,
      ).constructor;
      const Context = Object.getPrototypeOf(controller.ctx).constructor;
      const parseSource = (source) => fixture.parsed_bases[source.command];
      function normalize(value) {
        if (value == null) return null;
        if (typeof value !== "object") return value;
        const type = value.constructor?.type ?? value.constructor?.name;
        if (type === "Null") return null;
        if (type === "Error")
          return { error: value.message ?? value.toString() };
        if (type === "Date" && value.moment)
          return { date_ms: value.moment.valueOf() };
        if (Object.hasOwn(value, "date") && Object.hasOwn(value, "time"))
          return {
            native_date: value.toString(),
            date_part: String(value.date),
            time_part: String(value.time),
          };
        if (Array.isArray(value)) return value.map(normalize);
        if (Object.prototype.toString.call(value.data) === "[object Date]")
          return { date_ms: value.data.getTime() };
        if (Array.isArray(value.data)) return value.data.map(normalize);
        if (Object.hasOwn(value, "data")) {
          if (value.data && typeof value.data === "object")
            return Object.fromEntries(
              Object.entries(value.data).map(([k, v]) => [k, normalize(v)]),
            );
          return value.data;
        }
        return {
          type: value.constructor?.name,
          keys: Object.keys(value).slice(0, 16),
        };
      }
      function scalar(expression, ctx) {
        return normalize(new Formula(expression).getValue(ctx.local));
      }
      function filter(value, ctx) {
        if (value === undefined) return true;
        if (typeof value === "string")
          return scalar(`(${value}).isTruthy()`, ctx) === true;
        const keys = Object.keys(value);
        if (keys.length !== 1) throw Error("unqualified native filter shape");
        const op = keys[0],
          p = value[op],
          parts = Array.isArray(p) ? p : [p];
        if (op === "and") return parts.every((x) => filter(x, ctx));
        if (op === "or") return parts.some((x) => filter(x, ctx));
        if (op === "not") return parts.every((x) => !filter(x, ctx));
        throw Error("unqualified native filter operator");
      }
      const seedFile = app.vault.getAbstractFileByPath(fixture.records[0].path);
      const clockContext = new Context(app, null, {}, seedFile);
      const clock = {
        now: scalar("number(now())", clockContext),
        today: scalar('today().format("YYYY-MM-DD")', clockContext),
      };
      if (clock.now !== fixture.now_ms || clock.today !== "2026-06-10")
        throw Error(
          "native frozen-clock proof failed: " + JSON.stringify(clock),
        );
      const nativeTagFacts = fixture.records.map((record) => {
        const file = app.vault.getAbstractFileByPath(record.path);
        const ctx = new Context(app, null, {}, file);
        return {
          id: record.id,
          tags: scalar("file.tags", ctx),
          has_task: scalar('file.hasTag("task")', ctx),
          cache_tags: (app.metadataCache.getFileCache(file)?.tags ?? []).map(
            (tag) => tag.tag,
          ),
        };
      });
      function linkValueFacts(value, depth = 0) {
        if (depth > 4) throw Error("owned link observation depth exceeded");
        if (value == null || typeof value !== "object") return value;
        const elements = Array.isArray(value)
          ? value
          : Array.isArray(value.data)
            ? value.data
            : null;
        if (elements)
          return {
            type: value.constructor?.type ?? value.constructor?.name,
            elements: elements
              .slice(0, 16)
              .map((item) => linkValueFacts(item, depth + 1)),
          };
        const primitive = Object.fromEntries(
          Object.entries(value).filter(
            ([, field]) =>
              field == null ||
              ["string", "number", "boolean"].includes(typeof field),
          ),
        );
        return {
          type: value.constructor?.type ?? value.constructor?.name,
          own: Object.keys(value).slice(0, 16),
          methods: Object.getOwnPropertyNames(
            Object.getPrototypeOf(value),
          ).slice(0, 32),
          primitive,
          display: normalize(value.display),
          text: value.toString(),
          normalized: normalize(value),
          resolveArity: value.resolve?.length,
          resolved:
            typeof value.resolve === "function"
              ? (value.resolve()?.path ?? null)
              : null,
        };
      }
      const nativeLinkFacts = fixture.native_link_display
        ? fixture.records.map((record) => {
            const file = app.vault.getAbstractFileByPath(record.path);
            const ctx = new Context(app, null, {}, file);
            return {
              id: record.id,
              path: record.path,
              properties: Object.fromEntries(
                ["projects", "contexts", "blockedBy"].map((name) => [
                  name,
                  linkValueFacts(
                    new Formula(`note.${name}`).getValue(ctx.local),
                  ),
                ]),
              ),
            };
          })
        : [];
      const result = [];
      for (const view of fixture.views) {
        const source = fixture.sources.find((s) => s.command === view.command);
        const base = parseSource(source);
        const formulas = Object.fromEntries(
          Object.entries(base.formulas ?? {}).map(([k, v]) => [
            k,
            new Formula(v),
          ]),
        );
        const selected = base.views[view.index];
        const rows = [];
        for (const record of fixture.records) {
          const file = app.vault.getAbstractFileByPath(record.path);
          const ctx = new Context(app, null, formulas, file);
          if (filter(base.filters, ctx) && filter(selected.filters, ctx)) {
            const selectors = selected.sort ?? [];
            rows.push({
              id: record.id,
              sort: selectors.map((s) => scalar(s.column ?? s.property, ctx)),
              group: selected.groupBy
                ? scalar(selected.groupBy.property, ctx)
                : null,
              cells: selected.order.map((s) => ({
                selector: s,
                value: scalar(s, ctx),
              })),
            });
          }
        }
        result.push({
          command: view.command,
          index: view.index,
          name: selected.name,
          matched: rows.map((r) => r.id),
          rows,
        });
      }
      const controllerViews = [];
      for (const selected of fixture.views) {
        const sourcePath = "Views/" + selected.command + ".base";
        const leaf = app.workspace.getLeaf(true);
        await leaf.setViewState({
          type: window.__ownedOracleLeaf.view.getViewType(),
          state: { file: sourcePath, viewName: selected.name },
          active: true,
        });
        await app.workspace.revealLeaf(leaf);
        leaf.tabHeaderEl.click();
        const deadline = performance.now() + 30000;
        let current;
        while (performance.now() < deadline) {
          current = leaf.view.controller;
          if (
            leaf.view.getState().file === sourcePath &&
            current?.viewName === selected.name &&
            current.ctx?.formulas?.priorityWeight
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!current?.ctx?.formulas?.priorityWeight)
          throw Error("owned source controller did not load");
        if (current.viewName !== selected.name)
          throw Error(
            "native selected view state was not applied: " +
              JSON.stringify(leaf.view.getState()),
          );
        let stable = "",
          ticks = 0,
          data;
        while (performance.now() < deadline) {
          if (app.workspace.activeLeaf !== leaf) {
            await app.workspace.revealLeaf(leaf);
            leaf.tabHeaderEl.click();
          }
          data = current.view?.data;
          const entries = data?.data;
          const signature = JSON.stringify(
            Array.isArray(entries)
              ? entries.map((entry) => entry.file?.path)
              : null,
          );
          if (
            current.viewName === selected.name &&
            signature === stable &&
            Array.isArray(entries)
          )
            ticks++;
          else ticks = 0;
          stable = signature;
          if (ticks >= 5) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (ticks < 5)
          throw Error(
            "selected controller data did not settle: " +
              selected.name +
              " " +
              JSON.stringify({
                viewName: current.viewName,
                initialScan: current.initialScan,
                error: current.error,
                state: leaf.view.getState(),
                expectedPath: sourcePath,
                settleTicks: ticks,
                dataArray: Array.isArray(data?.data),
                clockRemaining: deadline - performance.now(),
                resultsCount: current.results.size,
                dataCount: current.view?.data?.data?.length,
                shown: current.viewContainerEl.isShown(),
                activeLeaf: app.workspace.activeLeaf === leaf,
              }),
          );
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const horizontalFrames = [];
        if (selected.command === "native-link-table") {
          const scroll = current.view.scrollEl;
          for (const left of [0, scroll.scrollWidth]) {
            scroll.scrollTo({ left });
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            horizontalFrames.push({
              left: scroll.scrollLeft,
              width: scroll.clientWidth,
              total: scroll.scrollWidth,
              rows: Array.from(
                current.viewContainerEl.querySelectorAll(".bases-tr"),
              ).map((row) => ({
                text: row.textContent,
                cells: Array.from(row.querySelectorAll(".bases-td")).map(
                  (cell) => ({
                    property: cell.getAttribute("data-property"),
                    text: cell.textContent,
                    links: Array.from(
                      cell.querySelectorAll(".internal-link[data-href]"),
                    ).map((link) => ({
                      text: link.textContent,
                      target: link.getAttribute("data-href"),
                      unresolved: link.classList.contains("is-unresolved"),
                    })),
                  }),
                ),
              })),
            });
          }
        }
        controllerViews.push({
          horizontalFrames,
          command: selected.command,
          index: selected.index,
          name: selected.name,
          rows: data.data.map((entry) => entry.file.path),
          cells: data.data.map((entry) => ({
            path: entry.file.path,
            cells: fixture.parsed_bases[selected.command].views[
              selected.index
            ].order.map((selector) => ({
              selector,
              value: normalize(
                entry.getValue(
                  selector.includes(".") ? selector : "note." + selector,
                ),
              ),
            })),
          })),
          renderedAnchors: Array.from(
            fixture.native_link_display
              ? current.viewContainerEl.querySelectorAll(
                  ".internal-link[data-href]",
                )
              : [],
          )
            .slice(0, 256)
            .map((anchor) => ({
              text: anchor.textContent,
              href: anchor.getAttribute("href"),
              target: anchor.getAttribute("data-href"),
              classes: Array.from(anchor.classList),
            })),
          renderedRows: Array.from(
            fixture.native_link_display
              ? current.viewContainerEl.querySelectorAll(".bases-tr")
              : [],
          )
            .slice(0, 32)
            .map((row) => ({
              text: row.textContent,
              cells: Array.from(row.querySelectorAll(".bases-td")).map(
                (cell) => ({
                  property: cell.getAttribute("data-property"),
                  text: cell.textContent,
                  links: Array.from(
                    cell.querySelectorAll(".internal-link[data-href]"),
                  ).map((link) => ({
                    text: link.textContent,
                    target: link.getAttribute("data-href"),
                    unresolved: link.classList.contains("is-unresolved"),
                  })),
                }),
              ),
            })),
          dataShape: Object.keys(data).slice(0, 24),
          groups: Array.isArray(data.groupedData)
            ? data.groupedData.map((group) => ({
                keys: Object.keys(group),
                key: normalize(group.key ?? group.value),
                entries: Array.isArray(group.entries)
                  ? group.entries.map((entry) => entry.file.path)
                  : null,
              }))
            : null,
        });
      }
      return {
        controllerViews,
        proof,
        clock,
        nativeTagFacts,
        nativeLinkFacts,
        observations: result,
      };
    },
    { fixture, proof },
  );
  const evidence = {
    kind: "obsidian-1.12.7-native-controller-order-groups-cells",
    source_sha256: fixture.sources.map((s) => ({
      command: s.command,
      sha256: createHash("sha256").update(s.source).digest("hex"),
    })),
    ...observations,
  };
  await fs.writeFile(
    path.join(root, "observations.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  const differences = evidence.observations
    .filter((view) => {
      const expected = fixture.views.find(
        (v) => v.command === view.command && v.index === view.index,
      );
      return (
        JSON.stringify([...view.matched].sort()) !==
        JSON.stringify([...expected.matched].sort())
      );
    })
    .map((v) => ({
      name: v.name,
      matched: v.matched,
      expected: fixture.views.find(
        (w) => w.command === v.command && w.index === v.index,
      ).matched,
    }));
  const recordsByPath = new Map(
    fixture.records.map((record) => [record.path, record.id]),
  );
  const controllerDifferences = evidence.controllerViews
    .map((view) => {
      const matched = view.rows.map((filePath) => {
        const id = recordsByPath.get(filePath);
        if (!id) throw Error("unknown native matched path: " + filePath);
        return id;
      });
      const expected = fixture.views.find(
        (candidate) =>
          candidate.command === view.command && candidate.index === view.index,
      ).matched;
      return { name: view.name, matched, expected };
    })
    .filter(
      (view) =>
        JSON.stringify([...view.matched].sort()) !==
        JSON.stringify([...view.expected].sort()),
    );
  await fs.writeFile(
    path.join(root, "comparison.json"),
    JSON.stringify(
      {
        membership_differences: differences,
        controller_membership_differences: controllerDifferences,
        controller_order_groups_qualification:
          "native observations; inventory-tie reference is NOT native path-tie policy",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      root,
      version: proof.version,
      membership_differences: differences.length,
      controller_membership_differences: controllerDifferences.length,
    }),
  );
  if (differences.length || controllerDifferences.length) process.exitCode = 1;
} finally {
  await page
    ?.screenshot({ path: path.join(root, "owned-window.png") })
    .catch(() => {});
  await fs.writeFile(path.join(root, "launch.log"), output);
  await browser?.close().catch(() => {});
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}
