/** Allocated repair DTO codecs against the immutable Rust/CDDL producer vectors. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode, encode, toHex, type CborValue } from "../src/cbor.js";
import { SchemaError } from "../src/codec.js";
import { incident, receipt, resyncing, syncStatus } from "../src/wire.js";
import { Write, type ResyncPhase, type Resyncing } from "../src/index.js";

const root = join(import.meta.dirname, "../../../conformance/wire");
const read = (name: string) => new Uint8Array(readFileSync(join(root, name)));
const map = (name: string): Map<number, CborValue> => {
  const value = decode(read(name));
  if (!(value instanceof Map)) throw new Error("expected producer struct map");
  for (const key of value.keys()) expect(typeof key).toBe("number");
  return value as Map<number, CborValue>;
};

describe("allocated lost-tail repair codecs", () => {



  const phases: ResyncPhase[] = ["probing", "repairing", "rolling_back", "awaiting_control"];
  for (const [tag, phase] of phases.entries()) {
    it(`round-trips the exact Rust ${phase} vector (phase${tag}, key10)`, () => {
      const name = phase.replaceAll("_", "-");
      const bytes = read(`client/status-resync-${name}.cbor`);
      const typed = syncStatus.dec(decode(bytes));
      expect(typed.resyncing).toEqual({ phase, positions: 3 });
      expect(typed.incidents.map((i) => i.kind)).toEqual(["log_regressed", "lost_entries"]);
      expect(toHex(encode(syncStatus.enc(typed)))).toBe(toHex(bytes));
      const publicProgress: Resyncing = { phase, positions: 3 };
      expect(resyncing.enc(publicProgress)).toEqual(new Map([[0, tag], [1, 3]]));
    });
  }

  it("uses only the allocated incident numbers and rejects later variants", () => {
    for (const [tag, kind] of [[11, "lost_entries"], [12, "log_regressed"]] as const) {
      expect(incident.enc({ kind })).toEqual(new Map([[0, tag]]));
      expect(incident.dec(new Map([[0, tag]]))).toEqual({ kind });
    }
    expect(() => incident.dec(new Map([[0, 13]]))).toThrow(SchemaError);
  });


  it("keeps the latest original relocation receipt on an existing Write", async () => {
    const mutation = "0192f3a4-6000-7abc-8def-0123456789ab";
    const write = new Write({ mutation, state: "confirmed", seq: 12 });
    const next = { mutation, state: "confirmed" as const, seq: 15, relocatedFrom: 12 };
    write.update(receipt.dec(decode(encode(receipt.enc(next)))));
    expect(write.receipt).toEqual(next);
    expect((await write.confirmed).seq).toBe(12);
    // Already-resolved promises aren't a second confirmation; consumers inspect
    // the current receipt for subsequent relocation information.
  });


  it("rejects malformed/missing progress, unknown phases and optional null", () => {
    for (const bad of [null, false, 10, "probing", new Map([[0, 0]]),
      new Map([[1, 3]]), new Map([[0, 4], [1, 3]])]) {
      const s = map("client/status.cbor");
      s.set(10, bad);
      expect(() => syncStatus.dec(s)).toThrow(SchemaError);
    }
    expect(() => resyncing.enc({ phase: "unknown" as ResyncPhase, positions: 1 })).toThrow(SchemaError);
  });
});
