import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectProblem } from "@mdbase-dev/connect/advanced";
import { createRecordTestAuthority } from "./index.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function editing() {
  const authority = createRecordTestAuthority<{ title?: string }>();
  authority.seed("Notes/one.md", { body: "Original", frontmatter: { title: "One" } });
  authority.records.follow(authority.watch);
  const opened = await authority.records.open("Notes/one.md", { autosave: false });
  if (!opened.ok) throw new Error(opened.problem.message);
  return { authority, session: opened.value.session };
}

describe("createRecordTestAuthority", () => {
  it("saves through revision-checked writes", async () => {
    const { authority, session } = await editing();
    session.setBody("Mine");
    await expect(session.flush()).resolves.toMatchObject({ ok: true });
    expect(authority.get("Notes/one.md")?.body).toBe("Mine");
    expect(authority.writes).toEqual([{ path: "Notes/one.md", ifRevision: "rev-1", patch: {}, body: "Mine" }]);
  });

  it("drives a conflict from another client's edit", async () => {
    const { authority, session } = await editing();
    session.setBody("Mine");
    authority.editElsewhere("Notes/one.md", { body: "Theirs" });
    await vi.runAllTimersAsync();
    expect(session.snapshot).toMatchObject({ state: "conflict", remote: { body: "Theirs" } });
  });

  it("follows renames and deletions made elsewhere", async () => {
    const { authority, session } = await editing();
    authority.renameElsewhere("Notes/one.md", "Notes/moved.md");
    await vi.runAllTimersAsync();
    expect(session.snapshot.record.path).toBe("Notes/moved.md");
    authority.deleteElsewhere("Notes/moved.md");
    await vi.runAllTimersAsync();
    expect(session.snapshot.state).toBe("deleted");
  });

  it("loses a response so recovery can be tested without a second write", async () => {
    const { authority, session } = await editing();
    authority.loseNextResponse();
    session.setBody("Lost");
    await expect(session.save()).resolves.toMatchObject({ ok: false, problem: { code: "operation_outcome_unknown" } });
    expect(session.snapshot.state).toBe("recovery");
    await expect(session.flush()).resolves.toMatchObject({ ok: true, value: { body: "Lost" } });
    expect(authority.writes).toHaveLength(1);
  });

  it("fails the next write with a chosen problem", async () => {
    const { authority, session } = await editing();
    authority.failNextWrite(connectProblem("connector_offline", "Offline"));
    session.setBody("Offline text");
    await expect(session.save()).resolves.toMatchObject({ ok: false, problem: { code: "connector_offline" } });
    expect(session.snapshot).toMatchObject({ state: "error", body: "Offline text" });
  });

  it("reports a change gap so followers re-read", async () => {
    const authority = createRecordTestAuthority();
    authority.seed("a.md", { body: "Before" });
    const opened = await authority.records.open("a.md");
    if (!opened.ok) throw new Error(opened.problem.message);
    authority.records.follow({ subscribe: (_listener, onStatus) => authority.watch.subscribe(() => undefined, onStatus) });
    authority.editElsewhere("a.md", { body: "Missed" });
    authority.resetWatch();
    await vi.runAllTimersAsync();
    expect(opened.value.session.snapshot.body).toBe("Missed");
  });
});
