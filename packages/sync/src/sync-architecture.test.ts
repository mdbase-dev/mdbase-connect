import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (name: string): Promise<string> =>
  readFile(new URL(name, import.meta.url), "utf8");

describe("plan-only sync architecture", () => {
  it("keeps the command executor unable to inspect or plan", async () => {
    const executor = await source("sync-executor.ts");
    expect(executor).not.toMatch(/from ["']\.\/sync-(?:inspector|planner)/u);
  });

  it("keeps the pure planner free of runtime and I/O capabilities", async () => {
    const planner = await source("sync-planner.ts");
    expect(planner).not.toMatch(/from ["']\.\/(?:sync-types|mirror-state|sync-inspector|sync-journal)/u);
    expect(planner).not.toMatch(/\b(?:Promise|Date|fetch|readFile|writeFile)\b/u);
  });

  it("constructs production commands only in the planner", async () => {
    for (const file of [
      "directory-mirror.ts",
      "sync-inspector.ts",
      "sync-revalidator.ts",
      "sync-executor.ts",
      "sync-journal.ts",
      "sync-checkpoint.ts"
    ]) {
      const value = (await source(file)).replace(
        /Extract<SyncAction,\s*\{\s*command:\s*[^}]+\}>/gu,
        "ACTION_TYPE"
      );
      expect(value, file).not.toMatch(
        /command:\s*["'](?:write_local|delete_local|move_local|put_remote|delete_remote|move_remote|record_conflict|clear_conflict|advance_checkpoint)["']/u
      );
    }
  });

  it("publishes checkpoints only through the checkpoint authority", async () => {
    for (const file of [
      "directory-mirror.ts",
      "sync-inspector.ts",
      "sync-revalidator.ts",
      "sync-executor.ts",
      "sync-journal.ts"
    ]) {
      expect(await source(file), file).not.toMatch(/state\.(?:cursor|generation)\s*=/u);
    }
  });

  it("transitions prepared batches only in journal and checkpoint modules", async () => {
    for (const file of [
      "directory-mirror.ts",
      "sync-inspector.ts",
      "sync-revalidator.ts",
      "sync-executor.ts"
    ]) {
      const value = await source(file);
      expect(value, file).not.toMatch(/state\.batch\s*=|delete state\.batch/u);
      expect(value, file).not.toMatch(
        /batch\.phase\s*=|batch\.next_action\s*(?:=|\+=)|batch\.receipts\.(?:push|splice)/u
      );
    }
  });
});
