import { expect, it } from "vitest";
import { checkpointMirrorStatus } from "./mirror-status.js";
import type { MirrorState } from "./mirror-state.js";

it("builds one status row per unique planned-conflict key without rescanning previous rows", () => {
  const count = 1_000;
  let entityReads = 0;
  const planned_conflicts = Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index), {
    get entity() { entityReads++; return "record"; },
    decision_id: `decision-${index}`, conflict_kind: "both_changed",
    local: { state: "exact", object: { path: `${index}.md` } }, remote: { state: "absent" }
  }]));
  const status = checkpointMirrorStatus({ cursor: 1, planned_conflicts } as unknown as MirrorState, "read_write");
  expect(status.conflicts).toHaveLength(count);
  expect(status.conflicts[0]).toMatchObject({ entity: "record", object_id: "0", decision_id: "decision-0", path: "0.md" });
  expect(status.conflicts.at(-1)).toMatchObject({ object_id: "999", path: "999.md" });
  expect(entityReads).toBeLessThan(count * 10);
});
