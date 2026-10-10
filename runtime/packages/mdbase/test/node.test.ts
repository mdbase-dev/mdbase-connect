import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Collection, MdbaseError } from "../src/node/index.js";

const base = join(tmpdir(), `mdbase-node-${process.pid}`);
mkdirSync(base, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

const TASK_TYPE = `---
kind: mdbase.type
name: task
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title, status]
    properties:
      title: { type: string, minLength: 1 }
      status: { type: string, enum: [open, done] }
---
`;

async function fresh(tag: string): Promise<[string, Collection]> {
  const root = join(base, tag);
  const col = await Collection.init(root, { name: "Test" });
  mkdirSync(join(root, "_types"), { recursive: true });
  writeFileSync(join(root, "_types/task.md"), TASK_TYPE);
  await col.rescan();
  return [root, col];
}

describe("Collection (node)", () => {
  it("refuses a folder without mdbase.yaml, with help", async () => {
    const e = await Collection.open(join(base, "nope")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MdbaseError);
    expect((e as MdbaseError).code).toBe("not_a_collection");
    expect((e as MdbaseError).help).toMatch(/init/);
  });

  it("creates, queries, updates, renames, deletes", async () => {
    const [root, col] = await fresh("crud");
    expect(col.root).toBe(root);
    expect(await col.types()).toEqual(["task"]);

    const a = await col.create({ path: "tasks/a.md", frontmatter: { type: "task", title: "A", status: "open" }, body: "Body.\n" });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.revision).toMatch(/^sha256:/);
    expect(a.types).toEqual(["task"]);
    expect(readFileSync(join(root, "tasks/a.md"), "utf8")).toContain("title: A");

    const page = await col.query({ types: ["task"], where: "status == 'open'", include_body: true });
    expect(page.records.map((r) => r.path)).toEqual(["tasks/a.md"]);
    expect(page.records[0]!.body).toBe("Body.\n");

    const a2 = await col.update(a, { set: { status: "done" }, ifRevision: a.revision });
    expect(a2.frontmatter["status"]).toBe("done");
    const stale = await col.update("tasks/a.md", { set: { status: "open" }, ifRevision: a.revision }).catch((x: unknown) => x as MdbaseError);
    expect(stale).toMatchObject({ code: "conflict" });
    expect((stale as MdbaseError).help).toMatch(/Read it again/);

    const bad = await col.create({ path: "tasks/bad.md", frontmatter: { type: "task", title: "" } }).catch((x: unknown) => x as MdbaseError);
    expect(bad).toMatchObject({ code: "invalid_record" });
    expect(existsSync(join(root, "tasks/bad.md"))).toBe(false);

    const moved = await col.rename("tasks/a.md", "done/a.md");
    expect(moved.id).toBe(a.id);
    expect(existsSync(join(root, "done/a.md"))).toBe(true);
    await col.delete("done/a.md");
    expect(await col.get("done/a.md")).toBeNull();
    const nf = await col.delete("nope.md").catch((x: unknown) => x as MdbaseError);
    expect(nf).toMatchObject({ code: "not_found" });

    const made = await col.batch([
      { op: "create", path: "tasks/b.md", frontmatter: { type: "task", title: "B", status: "open" } },
      { op: "create", path: "tasks/c.md", frontmatter: { type: "task", title: "C", status: "open" } },
    ]);
    expect(made.map((r) => r.path)).toEqual(["tasks/b.md", "tasks/c.md"]);
    const atomic = await col
      .batch([
        { op: "update", target: "tasks/b.md", set: { status: "done" } },
        { op: "create", path: "tasks/d.md", frontmatter: { type: "task", title: "" } },
      ])
      .catch((x: unknown) => x as MdbaseError);
    expect(atomic).toMatchObject({ code: "invalid_record" });
    expect((await col.get("tasks/b.md"))!.frontmatter["status"]).toBe("open");

    expect((await col.status()).pending).toBe(0);
    const start = await col.changes();
    await col.update("tasks/c.md", { set: { status: "done" } });
    const ch = await col.changes(start.cursor);
    expect(ch.changes.length).toBeGreaterThan(0);
    expect(ch.changes.every((c) => c.path === "tasks/c.md" && c.kind === "put")).toBe(true);
    await col.close();
    await col.close();
    const closed = await col.types().catch((x: unknown) => x as MdbaseError);
    expect(closed).toMatchObject({ code: "closed" });
  });

  it("sees outside edits, validates, and resolves links", async () => {
    const [root, col] = await fresh("outside");
    await col.create({ path: "notes/a.md", frontmatter: { title: "A" }, body: "See [[b]].\n" });
    writeFileSync(join(root, "notes/b.md"), "---\ntitle: B\n---\nBack to [[a]].\n");
    writeFileSync(join(root, "notes/bad.md"), "---\ntype: task\ntitle: 1\n---\n");
    await col.rescan();
    const b = await col.get("notes/b.md");
    expect(b?.frontmatter["title"]).toBe("B");
    const links = await col.links("notes/a.md");
    expect(links.outgoing).toEqual([{ target: "b", resolved: b!.id }]);
    expect(links.backlinks).toEqual([b!.id]);
    const report = await col.validate();
    expect(report.map((r) => r.path)).toEqual(["notes/bad.md"]);
    expect(report[0]!.issues[0]!.code).toMatch(/^schema_/);
    await col.close();
  });

  it("refuses a second host and reports who", async () => {
    const [root, col] = await fresh("hosted");
    const e = await Collection.open(root).catch((x: unknown) => x as MdbaseError);
    expect(e).toMatchObject({ code: "already_hosted" });
    expect((e as MdbaseError).details).toMatchObject({ host: "library" });
    await col.close();
    const again = await Collection.open(root);
    await again.close();
  });
});
