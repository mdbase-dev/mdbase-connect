import { describe, expect, it } from "vitest";
import { VaultPlatform } from "../src/vault/platform.js";
import { VaultEvents } from "../src/vault/events.js";
import type { FileEvent, FileOp, FileOpResult } from "../src/vault/types.js";
import { FakeVault } from "./fakeVault.js";

const desktop = { isMobileApp: false, isAndroidApp: false, isIosApp: false };
const android = { isMobileApp: true, isAndroidApp: true, isIosApp: false };
const b = (s: string) => new TextEncoder().encode(s);
const t = (u: Uint8Array) => new TextDecoder().decode(u);

function setup(opts: { android?: boolean; root?: string } = {}) {
  const fv = new FakeVault({ android: opts.android, insensitive: opts.android });
  const events: FileEvent[] = [];
  let now = 10_000;
  const app = fv.app;
  let pf!: VaultPlatform;
  const ev = new VaultEvents(app, (p) => pf.relPath(p), (e) => events.push(e), () => now);
  pf = new VaultPlatform(app, { root: opts.root ?? "", platform: opts.android ? android : desktop, events: ev });
  ev.start();
  const run = (op: FileOp) => pf.perform(op);
  return { fv, pf, ev, events, run, tick: (ms: number) => (now += ms) };
}
const val = (r: FileOpResult) => {
  if (!r.ok) throw r.error;
  return r.value;
};

describe("VaultPlatform capabilities", () => {
  it("declares the GuardedInPlace contract; Android is case-insensitive despite the adapter", () => {
    expect(setup().pf.capabilities).toMatchObject({ replace: "GuardedInPlace", exclusiveCreate: false, durability: "None", events: "Hint", case: "Sensitive" });
    expect(setup({ android: true }).pf.capabilities.case).toBe("Insensitive");
  });
});

describe("guarded operations", () => {
  it("replaces only when the content is exactly as expected", async () => {
    const { fv, run } = setup();
    fv.setText("a.md", "one");
    expect(val(await run({ op: "GuardedReplace", path: "a.md", expect: b("one"), new: b("two") }))).toEqual({ kind: "Guarded", value: { kind: "Done" } });
    expect(fv.text("a.md")).toBe("two");
    const r = val(await run({ op: "GuardedReplace", path: "a.md", expect: b("one"), new: b("three") }));
    expect(r.kind === "Guarded" && r.value.kind === "Mismatch" && t(r.value.current)).toBe("two");
    expect(fv.text("a.md")).toBe("two");
    expect(val(await run({ op: "GuardedReplace", path: "nope.md", expect: b(""), new: b("x") }))).toEqual({ kind: "Guarded", value: { kind: "Missing" } });
  });

  it("refuses non-UTF-8 content instead of guessing", async () => {
    const { fv, run } = setup();
    fv.setText("a.md", "x");
    const r = await run({ op: "GuardedReplace", path: "a.md", expect: new Uint8Array([0xff]), new: b("y") });
    expect(r.ok === false && r.error.kind).toBe("Unsupported");
  });

  it("preserves a BOM through the comparison", async () => {
    const { fv, run } = setup();
    fv.setText("a.md", "﻿hello");
    expect(val(await run({ op: "GuardedReplace", path: "a.md", expect: b("﻿hello"), new: b("﻿bye") }))).toMatchObject({ value: { kind: "Done" } });
    expect(fv.text("a.md")).toBe("﻿bye");
  });

  it("creates only on a free path (case-insensitively where the volume is)", async () => {
    const { fv, run } = setup({ android: true });
    expect(val(await run({ op: "GuardedCreate", path: "dir/New.md", bytes: b("x") }))).toMatchObject({ value: { kind: "Done" } });
    expect(fv.dirs.has("dir")).toBe(true);
    expect(val(await run({ op: "GuardedCreate", path: "dir/new.md", bytes: b("y") }))).toMatchObject({ value: { kind: "Exists" } });
    expect(fv.text("dir/New.md")).toBe("x");
  });

  it("trashes only the expected content, through the user's trash", async () => {
    const { fv, run } = setup();
    fv.setText("a.md", "keep me");
    expect(val(await run({ op: "GuardedTrash", path: "a.md", expect: b("old") }))).toMatchObject({ value: { kind: "Mismatch" } });
    expect(val(await run({ op: "GuardedTrash", path: "a.md", expect: b("keep me") }))).toMatchObject({ value: { kind: "Done" } });
    expect(fv.trashed).toEqual(["a.md"]);
  });
});

describe("renames", () => {
  it("never replaces", async () => {
    const { fv, run } = setup();
    fv.setText("a.md", "a");
    fv.setText("b.md", "b");
    const r = await run({ op: "RenameNoreplace", from: "a.md", to: "b.md" });
    expect(r.ok === false && r.error.kind).toBe("AlreadyExists");
    expect(fv.text("b.md")).toBe("b");
  });

  it("case-only rename on Android goes through a temporary name and keeps the file", async () => {
    const { fv, run } = setup({ android: true });
    fv.setText("case.md", "precious");
    val(await run({ op: "RenameNoreplace", from: "case.md", to: "Case.md" }));
    expect([...fv.files.keys()]).toEqual(["Case.md"]);
    expect(fv.text("Case.md")).toBe("precious");
  });

  it("control: the bridge rename alone would have deleted it", async () => {
    const fv = new FakeVault({ android: true, insensitive: true });
    fv.setText("case.md", "precious");
    await fv.app.vault.adapter.rename("case.md", "Case.md");
    expect(fv.files.size).toBe(0);
  });
});

describe("collection root", () => {
  it("maps paths under the root and ignores the rest", async () => {
    const { fv, run, events } = setup({ root: "Tasks" });
    fv.dirs.add("Tasks");
    fv.setText("Tasks/a.md", "x");
    fv.setText("Other/b.md", "y");
    expect(val(await run({ op: "List", dir: "" }))).toEqual({ kind: "Entries", value: [{ name: "a.md", kind: "File" }] });
    expect(events.map((e) => `${e.kind}:${e.path}`)).toEqual(["Rescan:", "Created:a.md"]);
  });
});

describe("events", () => {
  it("own writes don't reset the quiet period; outside writes do", async () => {
    const { fv, run, ev, tick } = setup();
    fv.setText("a.md", "1");
    tick(5000);
    expect(ev.isQuiet("a.md", 2000)).toBe(true);
    await run({ op: "GuardedReplace", path: "a.md", expect: b("1"), new: b("2") });
    expect(ev.isQuiet("a.md", 2000)).toBe(true);
    fv.setText("a.md", "3");
    expect(ev.isQuiet("a.md", 2000)).toBe(false);
    tick(2000);
    expect(ev.isQuiet("a.md", 2000)).toBe(true);
  });

  it("pairs an outside move (create then delete, same size) as a rename hint", () => {
    const { fv, events, tick } = setup();
    fv.setText("old/n.md", "content");
    events.length = 0;
    tick(200);
    fv.setText("new/n.md", "content"); // outside tool: create new...
    tick(100);
    fv.files.delete("old/n.md"); // ...then delete old ~100 ms later
    for (const l of fv.listeners) if (l.ev === "delete") l.cb({ path: "old/n.md", stat: { size: 7, mtime: 0, ctime: 0 } });
    expect(events.map((e) => `${e.kind}:${e.path}:${e.cookie ?? ""}`)).toEqual(["Created:new/n.md:", "Removed:old/n.md:", "RenamedFrom:old/n.md:1", "RenamedTo:new/n.md:1"]);
  });

  it("does not pair outside the window or on a size mismatch", () => {
    const { fv, events, tick } = setup();
    fv.setText("new/n.md", "content");
    tick(5000);
    for (const l of fv.listeners) if (l.ev === "delete") l.cb({ path: "old/n.md", stat: { size: 7, mtime: 0, ctime: 0 } });
    fv.setText("new/m.md", "content!!");
    for (const l of fv.listeners) if (l.ev === "delete") l.cb({ path: "old/m.md", stat: { size: 7, mtime: 0, ctime: 0 } });
    expect(events.filter((e) => e.kind.startsWith("Renamed"))).toEqual([]);
  });
});

describe("sync-tool detection", () => {
  it("reports Obsidian Sync only with a remote vault, plugins, markers and paths", async () => {
    const { fv, run } = setup();
    let env = val(await run({ op: "Environment" }));
    expect(env.kind === "Environment" && env.value.signals).toEqual([]);
    fv.syncVaultId = "abc";
    fv.enabledPlugins.add("remotely-save");
    fv.setText(".stfolder", "");
    fv.basePath = "/Users/u/Library/Mobile Documents/iCloud~md~obsidian/Documents/v";
    env = val(await run({ op: "Environment" }));
    const tools = env.kind === "Environment" ? env.value.signals.map((s) => `${s.tool}/${s.strength}`) : [];
    expect(tools).toEqual(["Obsidian Sync/Strong", "Remotely Save/Strong", "iCloud Drive/Medium", "Syncthing/Strong"]);
  });
});

describe("process() is not CAS against outside writers", () => {
  it("documents the residual: an outside write between read and write is lost", async () => {
    const { fv, run } = setup();
    fv.setText("a.md", "one");
    fv.betweenReadAndWrite = () => fv.setText("a.md", "outside");
    await run({ op: "GuardedReplace", path: "a.md", expect: b("one"), new: b("two") });
    // This is the outside-writer race; the store's quiet gate,
    // sync-tool detection and post-write verification exist because of it.
    expect(fv.text("a.md")).toBe("two");
  });
});

describe("event pairing regressions", () => {
  it("a trashed file is not paired with a create whose path was renamed away", () => {
    const { fv, events } = setup();
    fv.setText("n/a.md", "x".repeat(27)); // create a.md
    // a.md renamed away (Obsidian rename), then the renamed file is trashed
    for (const l of fv.listeners) if (l.ev === "rename") l.cb({ path: "n/b.md" }, "n/a.md");
    events.length = 0;
    for (const l of fv.listeners) if (l.ev === "delete") l.cb({ path: "n/b.md", stat: { size: 27, mtime: 0, ctime: 0 } });
    expect(events.map((e) => e.kind)).toEqual(["Removed"]);
  });
});
