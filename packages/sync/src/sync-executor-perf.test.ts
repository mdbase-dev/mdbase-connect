import { expect, it } from "vitest";
import { PlanOnlySyncExecutor } from "./sync-executor.js";
import type { MirrorState } from "./mirror-state.js";

it("indexes dependency receipts once while preserving appended receipts and batch replacement", () => {
  const executor = new PlanOnlySyncExecutor({} as never) as unknown as {
    dependencyFileRevision(state: MirrorState, action: unknown): string | undefined;
  };
  let reads = 0;
  const count = 1_000;
  const receipt = (index: number) => ({
    get action_id() { reads++; return `action-${index}`; },
    status: "completed", file: { file_id: `file-${index}`, revision: `file:revision-${index}` }
  });
  const state = { batch: { receipts: Array.from({ length: count }, (_, index) => receipt(index)) } } as unknown as MirrorState;
  const action = (index: number) => ({ command: "move_remote", source: { identity: `file-${index}` }, revision_from_dependency: `action-${index}` });
  for (let index = 0; index < count; index++) {
    expect(executor.dependencyFileRevision(state, action(index))).toBe(`file:revision-${index}`);
  }
  expect(reads).toBeLessThan(count * 4);
  state.batch!.receipts.push(receipt(count) as never);
  expect(executor.dependencyFileRevision(state, action(count))).toBe(`file:revision-${count}`);
  state.batch!.receipts = [receipt(count + 1)] as never;
  expect(executor.dependencyFileRevision(state, action(count + 1))).toBe(`file:revision-${count + 1}`);
  expect(() => executor.dependencyFileRevision(state, action(0))).toThrow(/missing its dependency/);
  expect(() => executor.dependencyFileRevision(state, {
    ...action(count + 1), source: { identity: "wrong-file" }
  })).toThrow(/missing its dependency/);
  expect(executor.dependencyFileRevision(state, { source: {} })).toBeUndefined();
  const duplicate = receipt(count + 1);
  duplicate.file.file_id = "wrong-file";
  state.batch!.receipts = [receipt(count + 1), duplicate] as never;
  expect(executor.dependencyFileRevision(state, action(count + 1))).toBe(`file:revision-${count + 1}`);
});
