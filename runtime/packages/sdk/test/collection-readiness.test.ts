import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decode, type CborValue } from "../src/cbor.js";
import { connect } from "../src/client.js";
import { MemoryReplica } from "../src/testing/index.js";
import type { Connector, FramePort } from "../src/transport/port.js";
import {
  clientFrame,
  describeResult,
  listResourcesResult,
  resourceView,
  type DescribeResult,
  type ResourceView,
  type Problem,
  type ListResourcesResult,
} from "../src/wire.js";
import {
  createAppCollectionReadiness,
  type AppCollectionReadinessRequirements,
} from "../src/app-host/collection-readiness.js";

const native = new Uint8Array(
  Buffer.from(
    readFileSync(
      new URL("../../../conformance/describe/populated.hex", import.meta.url),
      "utf8",
    ).trim(),
    "hex",
  ),
);
const generation = "b961c101-4123-4123-8123-123456789abc";
const declared: AppCollectionReadinessRequirements = {
  capabilityContractVersion: 2,
  requiredNativeCapabilities: ["collection.read", "records.edit"],
  contracts: [
    {
      id: "acme.task",
      version: "1.2.0",
      digest: `sha256:${"55".repeat(32)}`,
    },
  ],
};
// Real SDK/session/watch/codec; explicit wire producer stand-ins for READ cuts.
// Native fixture provenance does NOT turn these lifecycle tests into immutable-source acceptance.
async function fixture() {
  const replica = new MemoryReplica();
  const original = replica.connector();
  let catalog: DescribeResult = describeResult.dec(decode(native));
  let rows: ResourceView[] = ["_contracts/task.md", "_types/task.md"].map(
    (path) => ({
      path,
      revision: `sha256:${"11".repeat(32)}`,
      size: 3,
      state: "confirmed",
      text: "abc",
    }),
  );
  let refusal: Problem | undefined,
    current = true,
    opens = 0,
    inventories = 0;
  let beforeReply: (() => void) | undefined;
  let responseGate: Promise<void> | undefined;
  let pageReply:
    ((cursor: CborValue | undefined) => ListResourcesResult) | undefined;
  const requests: string[] = [];
  const connector: Connector = {
    description: "readiness-original-session-wire-stand-in",
    async open(hello, signal) {
      opens++;
      const opened = await original.open(hello, signal);
      const port: FramePort = {
        onframe: null,
        onclose: null,
        send(value) {
          const frame = clientFrame.dec(value);
          if (frame.kind !== "request") {
            opened.port.send(value);
            return;
          }
          requests.push(frame.method);
          let result: CborValue;
          if (frame.method === "describe") result = describeResult.enc(catalog);
          else if (frame.method === "list_resources") {
            inventories++;
            result = listResourcesResult.enc(
              pageReply
                ? pageReply((frame.params as Map<number, CborValue>).get(2))
                : { resources: rows, complete: true },
            );
          } else if (frame.method === "get_resource") {
            const path = (frame.params as Map<number, CborValue>).get(0);
            const row = rows.find((row) => row.path === path);
            if (!row) throw Error("unexpected resource read");
            result = resourceView.enc(row);
          } else {
            opened.port.send(value);
            return;
          }
          const response = refusal
            ? clientFrame.enc({
                kind: "response",
                id: frame.id,
                problem: refusal,
              })
            : clientFrame.enc({
                kind: "response",
                id: frame.id,
                result,
              });
          queueMicrotask(async () => {
            await responseGate;
            beforeReply?.();
            port.onframe?.(response);
          });
        },
        close() {
          opened.port.close();
        },
      };
      opened.port.onframe = (value) => port.onframe?.(value);
      opened.port.onclose = (value) => port.onclose?.(value);
      return { ...opened, port };
    },
  };
  const client = await connect({
    connector,
    app: { name: "readiness-test", version: "0" },
    reconnect: false,
  });
  const scope = new AbortController();
  const make = (requirements = declared) =>
    createAppCollectionReadiness(client, requirements, {
      collection: client.hello.collection,
      generation,
      signal: scope.signal,
      isCurrent: () => current,
    });
  return {
    client,
    scope,
    replica,
    requests,
    make,
    opens: () => opens,
    inventories: () => inventories,
    setCatalog: (value: DescribeResult) => {
      catalog = value;
    },
    catalog: () => catalog,
    setRows: (value: ResourceView[]) => {
      rows = value;
    },
    rows: () => rows,
    refuse: (value: Problem) => {
      refusal = value;
    },
    fence: () => {
      current = false;
    },
    beforeReply: (value: () => void) => {
      beforeReply = value;
    },
    holdReplies: (gate: Promise<void>) => {
      responseGate = gate;
    },
    pages: (value: (cursor: CborValue | undefined) => ListResourcesResult) => {
      pageReply = value;
    },
  };
}

describe("original selected collection semantic readiness", () => {
  it("starts unassessed and qualifies mapped native catalog on the SAME client", async () => {
    const f = await fixture(),
      assessor = f.make();
    try {
      expect(assessor.getSnapshot()).toEqual({
        checking: false,
        assessment: null,
        problem: null,
      });
      const result = await assessor.start();
      expect(result.status).toBe("ready");
      expect(result.witness.resources.map((row) => row.path)).toEqual([
        "_contracts/task.md",
        "_types/task.md",
      ]);
      expect(f.inventories()).toBe(2);
      expect(f.opens()).toBe(1);
      expect(
        f.requests.filter((method) =>
          ["describe", "get_resource", "list_resources"].includes(method),
        ),
      ).toEqual([
        "list_resources",
        "describe",
        "get_resource",
        "get_resource",
        "list_resources",
      ]);
      expect(f.requests).not.toContain("describe_typing");
      expect(
        f.requests.some((method) => /submit|apply|create|put/.test(method)),
      ).toBe(false);
    } finally {
      await assessor.close();
      f.client.close();
    }
  });
  it.each(["missing", "digest", "invalid"])(
    "reports genuine catalog %s without a default/setup write",
    async (mode) => {
      const f = await fixture(),
        assessor = f.make();
      const catalog = f.catalog();
      f.setCatalog(
        mode === "missing"
          ? { ...catalog, contracts: [] }
          : mode === "invalid"
            ? {
                ...catalog,
                issues: [
                  {
                    code: "bad",
                    severity: "error",
                    message: "PRIVATE",
                  },
                ],
              }
            : {
                ...catalog,
                contracts: catalog.contracts.map((row) =>
                  mode === "digest"
                    ? {
                        ...row,
                        digest: `sha256:${"99".repeat(32)}`,
                      }
                    : { ...row, implementedBy: [] },
                ),
              },
      );
      try {
        expect((await assessor.start()).status).toBe(
          mode === "missing" || mode === "implementation"
            ? "setup_required"
            : "incompatible",
        );
        expect(JSON.stringify(assessor.getSnapshot())).not.toContain("PRIVATE");
      } finally {
        await assessor.close();
        f.client.close();
      }
    },
  );
  it("does not let an earlier missing requirement mask an incompatible required contract", async () => {
    const f = await fixture();
    const assessor = f.make({
      ...declared,
      contracts: [
        {
          id: "acme.absent",
          version: "1.0.0",
          digest: `sha256:${"33".repeat(32)}`,
        },
        ...declared.contracts,
      ],
    });
    f.setCatalog({
      ...f.catalog(),
      contracts: f.catalog().contracts.map((row) => ({
        ...row,
        digest: `sha256:${"99".repeat(32)}`,
      })),
    });
    try {
      expect(await assessor.start()).toMatchObject({
        status: "incompatible",
        problem: { reason: "contract_mismatch" },
      });
    } finally {
      await assessor.close();
      f.client.close();
    }
  });
  it("does not derive WRITE capability from full collection READ or optional groups", async () => {
    const f = await fixture(),
      assessor = f.make({
        ...declared,
        requiredNativeCapabilities: ["ungranted-required-group"],
      });
    try {
      expect(await assessor.start()).toMatchObject({
        status: "incompatible",
        problem: { reason: "capability_missing" },
      });
    } finally {
      await assessor.close();
      f.client.close();
    }
  });
  it("accepts explicit v2 empty required groups only after genuine READs", async () => {
    const f = await fixture(),
      assessor = f.make({ ...declared, requiredNativeCapabilities: [] });
    try {
      expect((await assessor.start()).status).toBe("ready");
      expect(f.inventories()).toBe(2);
    } finally {
      await assessor.close();
      f.client.close();
    }
  });
  it("does not reinterpret legacy, absent or malformed capability projection as empty v2", async () => {
    const f = await fixture();
    const binding = {
      collection: f.client.hello.collection,
      generation,
      signal: f.scope.signal,
      isCurrent: () => true,
    };
    try {
      for (const projection of [
        { ...declared, capabilityContractVersion: 1 },
        { ...declared, capabilityContractVersion: undefined },
        { ...declared, requiredNativeCapabilities: undefined },
      ])
        expect(() =>
          Reflect.apply(createAppCollectionReadiness, undefined, [
            f.client,
            projection,
            binding,
          ]),
        ).toThrow();
      expect(f.inventories()).toBe(0);
      expect(f.requests).not.toContain("describe");
    } finally {
      f.client.close();
    }
  });
  it("refuses a pending resource cut rather than publishing setup/READY", async () => {
    const f = await fixture(),
      assessor = f.make();
    f.setRows(f.rows().map((row) => ({ ...row, state: "pending" })));
    try {
      await expect(assessor.start()).rejects.toMatchObject({
        reason: "readiness_catalog_response",
      });
      expect(assessor.getSnapshot().assessment).toBeNull();
    } finally {
      await assessor.close();
      f.client.close();
    }
  });
  it("retains native pending inventory refusal and bounded null snapshot", async () => {
    const f = await fixture(),
      assessor = f.make();
    f.refuse({
      code: "unavailable",
      message: "PRIVATE_CREDENTIAL",
      recovery: "retry",
      reason: "resource_inventory_pending",
    });
    try {
      await expect(assessor.start()).rejects.toMatchObject({
        reason: "resource_inventory_pending",
      });
      expect(assessor.getSnapshot()).toEqual({
        checking: false,
        assessment: null,
        problem: { reason: "unavailable" },
      });
      expect(JSON.stringify(assessor.getSnapshot())).not.toContain(
        "PRIVATE_CREDENTIAL",
      );
    } finally {
      await assessor.close();
      f.client.close();
    }
  });
  it("refuses source revision changes across the READ cut", async () => {
    const f = await fixture(),
      assessor = f.make();
    let changed = false;
    f.beforeReply(() => {
      if (!changed) {
        changed = true;
        f.setRows(
          f.rows().map((row) => ({
            ...row,
            revision: `sha256:${"77".repeat(32)}`,
          })),
        );
      }
    });
    try {
      await expect(assessor.start()).rejects.toMatchObject({
        reason: "readiness_changed",
      });
      expect(assessor.getSnapshot().assessment).toBeNull();
    } finally {
      await assessor.close();
      f.client.close();
    }
  });
  it("retains original cursor and requires COMPLETE bounded inventory", async () => {
    const f = await fixture(),
      assessor = f.make();
    const cursors: Array<CborValue | undefined> = [];
    f.pages((cursor) => {
      cursors.push(cursor);
      return cursor === undefined
        ? {
            resources: f.rows().slice(0, 1),
            complete: false,
            cursor: "original-cut",
          }
        : { resources: f.rows().slice(1), complete: true };
    });
    try {
      expect((await assessor.start()).status).toBe("ready");
      expect(cursors).toEqual([
        undefined,
        "original-cut",
        undefined,
        "original-cut",
      ]);
    } finally {
      await assessor.close();
      f.client.close();
    }
  });
  it.each(["repeat", "missing"])(
    "refuses %s inventory cursor without a prefix fallback",
    async (mode) => {
      const f = await fixture(),
        assessor = f.make();
      f.pages((cursor) =>
        mode === "missing"
          ? { resources: [], complete: false }
          : mode === "terminal-with-cursor"
            ? { resources: [], complete: true, cursor: "bad" }
            : {
                resources: cursor ? f.rows().slice(1) : f.rows().slice(0, 1),
                complete: false,
                cursor: "same",
              },
      );
      try {
        await expect(assessor.start()).rejects.toMatchObject({
          reason: "readiness_catalog_response",
        });
        expect(assessor.getSnapshot().assessment).toBeNull();
        expect(f.opens()).toBe(1);
      } finally {
        await assessor.close();
        f.client.close();
      }
    },
  );
  it("keeps a cancelled caller's original READ occupied until its reply", async () => {
    const f = await fixture(),
      assessor = f.make(),
      caller = new AbortController();
    let release!: () => void;
    f.holdReplies(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const original = new Error("PRIVATE_ABORT_DETAIL");
    const settled = assessor.start(caller.signal).then(
      () => undefined,
      (value) => value,
    );
    try {
      await vi.waitFor(() => expect(f.inventories()).toBe(1));
      caller.abort(original);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(assessor.refresh()).rejects.toMatchObject({
        reason: "readiness_busy",
      });
      expect(f.inventories()).toBe(1);
      expect(f.requests).not.toContain("cancel");
      release();
      expect(await settled).toBe(original);
      expect(assessor.getSnapshot().assessment).toBeNull();
    } finally {
      release();
      await settled;
      await assessor.close();
      f.client.close();
    }
  });
  it("subscription changes invalidate and requalify the current cut without a new client", async () => {
    const f = await fixture(),
      assessor = f.make();
    const revisions: Array<string | null> = [];
    const stop = assessor.subscribe(() =>
      revisions.push(
        assessor.getSnapshot().assessment?.witness.resources[0]?.revision ??
          null,
      ),
    );
    try {
      await assessor.start();
      const initial = revisions.length;
      const next = `sha256:${"44".repeat(32)}`;
      f.setRows(f.rows().map((row) => ({ ...row, revision: next })));
      f.replica.seed({
        path: "changes/event.md",
        body: "new native change notification stand-in",
      });
      await vi.waitFor(() =>
        expect(
          assessor.getSnapshot().assessment?.witness.resources[0]?.revision,
        ).toBe(next),
      );
      expect(revisions.slice(initial)).toContain(null);
      expect(f.opens()).toBe(1);
    } finally {
      stop();
      await assessor.close();
      f.client.close();
    }
  });
  it("stale original scope cannot retain cached READY even before a notification", async () => {
    const f = await fixture(),
      assessor = f.make();
    try {
      await assessor.start();
      f.fence();
      expect(assessor.getSnapshot().assessment).toBeNull();
    } finally {
      await assessor.close();
      f.client.close();
    }
  });
  it("observer cuts fence success and borrowed close does not close original client", async () => {
    const f = await fixture(),
      assessor = f.make(),
      originalClose = vi.spyOn(f.client, "close");
    const stop = assessor.subscribe(() => {
      if (assessor.getSnapshot().assessment) f.fence();
    });
    try {
      await expect(assessor.start()).rejects.toMatchObject({
        reason: "readiness_fenced",
      });
      expect(assessor.getSnapshot().assessment).toBeNull();
      stop();
      await assessor.close();
      expect(originalClose).not.toHaveBeenCalled();
      expect(f.client.currentSession()?.closed).toBe(false);
    } finally {
      stop();
      await assessor.close();
      f.client.close();
    }
  });
});
