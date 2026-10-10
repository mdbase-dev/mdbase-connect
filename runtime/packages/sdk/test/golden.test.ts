/**
 * Golden wire fixtures (`conformance/wire/`, 00-overview.md §8), run from TS.
 *
 * - Every positive `*.cbor` in every format passes the profile decoder, and
 *   decode → encode reproduces the bytes exactly (so data map order, int/float and
 *   bigint handling all survive).
 * - Every `cbor/*.bad.cbor` (profile rules) is rejected by the decoder.
 * - Client API and mutation fixtures decode with the typed codecs, and the typed
 *   value re-encodes to identical bytes, so no field is dropped or renamed.
 * - Schema-level negative fixtures for the formats this SDK types are rejected.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode, encode, toHex } from "../src/cbor.js";
import type { Codec } from "../src/codec.js";
import * as w from "../src/wire.js";
import { accountKeyStatus } from "../src/private.js";
import { runtimeMutation } from "../src/runtime-wire.js";

const root = join(import.meta.dirname, "../../../conformance/wire");

function read(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(root, rel)));
}

const formats = readdirSync(root).filter((f) => statSync(join(root, f)).isDirectory());

describe("profile: every positive fixture round-trips", () => {
  for (const fmt of formats) {
    for (const file of readdirSync(join(root, fmt))) {
      if (!file.endsWith(".cbor") || file.endsWith(".bad.cbor")) continue;
      it(`${fmt}/${file}`, () => {
        const bytes = read(`${fmt}/${file}`);
        expect(toHex(encode(decode(bytes)))).toBe(toHex(bytes));
      });
    }
  }
});

describe("profile: negative fixtures are rejected", () => {
  for (const file of readdirSync(join(root, "cbor"))) {
    if (!file.endsWith(".bad.cbor")) continue;
    const why = readFileSync(join(root, "cbor", file.replace(".cbor", ".txt")), "utf8").trim();
    it(`cbor/${file}: ${why}`, () => {
      expect(() => decode(read(`cbor/${file}`))).toThrow();
    });
  }
});

/** `_type` in the fixture's JSON debug view → the TS codec for it. */
const TYPED: Record<string, Codec<any>> = {
  Request: w.clientFrame,
  Response: w.clientFrame,
  Push: w.clientFrame,
  HelloParams: w.helloParams,
  HelloResult: w.helloResult,
  Receipt: w.receipt,
  PublishState: w.publishState,
  SyncStatus: w.syncStatus,
  Resyncing: w.resyncing,
  ConfirmedHead: w.confirmedHead,
  AppliedPrefix: w.appliedPrefix,
  AppliedPrefixParams: w.appliedPrefixParams,
  QueryUpdate: w.queryUpdate,
  QueryResult: w.queryResult,
  FileView: w.fileView,
  OpenUploadParams: w.openUploadParams,
  OpenUploadResult: w.openUploadResult,
  TransferProgress: w.transferProgress,
  Hold: w.hold,
  Materialization: w.materialization,
  Peer: w.peer,
  Problem: w.problem,
  Mutation: w.mutation,
  BacklinksResult: w.backlinksResult,
  DescribeResult: w.describeResult,
  // The fixture `_type` is the method name for this schema.
  describe_typing: w.describeTypingResult,
  DescribeTypingResult: w.describeTypingResult,
  account_key_status: accountKeyStatus,
  AccountKeyStatus: accountKeyStatus,
  account_key_setup: w.receipt,
  ExecuteViewParams: w.executeViewParams,
  ListPendingResult: w.listPendingResult,
  ListResourcesResult: w.listResourcesResult,
  ListViewsResult: w.listViewsResult,
  Preflight: w.preflight,
  QueryParams: w.queryParams,
  ResourceView: w.resourceView,
  ViewSourceDocument: w.viewSourceDocument,
};

function fixtureType(fmt: string, name: string): string {
  const json = JSON.parse(readFileSync(join(root, fmt, `${name}.json`), "utf8")) as { _type: string };
  return json._type;
}

// Explicit fixture family selection. Negative runtime fixtures must exercise
// their own schema, not pass vacuously because the legacy codec denies op13.
function fixtureCodec(fmt: string, name: string): Codec<any> {
  if (fmt === "mutation" && name.startsWith("runtime-v1-")) return runtimeMutation;
  return TYPED[fixtureType(fmt, name)]!;
}

for (const fmt of ["client", "mutation"]) {
  describe(`typed: ${fmt}`, () => {
    const names = readdirSync(join(root, fmt))
      .filter((f) => f.endsWith(".cbor") && !f.endsWith(".bad.cbor"))
      .map((f) => f.slice(0, -5));
    it("every fixture type has a TS codec", () => {
      const missing = names.filter((n) => !TYPED[fixtureType(fmt, n)]).map((n) => `${n}: ${fixtureType(fmt, n)}`);
      expect(missing).toEqual([]);
    });
    for (const name of names) {
      it(`${fmt}/${name} decodes and re-encodes identically`, () => {
        const codec = fixtureCodec(fmt, name);
        const bytes = read(`${fmt}/${name}.cbor`);
        const typed = codec.dec(decode(bytes));
        expect(toHex(encode(codec.enc(typed)))).toBe(toHex(bytes));
      });
    }
    for (const file of readdirSync(join(root, fmt)).filter((f) => f.endsWith(".bad.cbor"))) {
      const why = readFileSync(join(root, fmt, file.replace(".cbor", ".txt")), "utf8").trim();
      it(`${fmt}/${file} is rejected: ${why}`, () => {
        const codec = fmt === "mutation" ? (file.startsWith("runtime-v1-") ? runtimeMutation : w.mutation) : w.clientFrame;
        expect(() => codec.dec(decode(read(`${fmt}/${file}`)))).toThrow();
      });
    }
  });
}

describe("typed: values", () => {
  it("value/frontmatter-kinds keeps order, ints, floats and big ints", () => {
    const v = decode(read("value/frontmatter-kinds.cbor"));
    expect(toHex(encode(w.fmMap.enc(w.fmMap.dec(v))))).toBe(toHex(read("value/frontmatter-kinds.cbor")));
  });
  for (const file of readdirSync(join(root, "value")).filter((f) => f.endsWith(".bad.cbor"))) {
    it(`value/${file} is rejected`, () => {
      expect(() => w.fmMap.dec(decode(read(`value/${file}`)))).toThrow();
    });
  }
});

describe("typed: spot checks against the debug views", () => {
  it("submit-request carries a mutation ID, time zone and include", () => {
    const f = w.clientFrame.dec(decode(read("client/submit-request.cbor")));
    expect(f.kind).toBe("request");
    if (f.kind !== "request") return;
    expect(f.method).toBe("submit");
    const p = w.submitParams.dec(f.params);
    expect(p.mutationId).toBe("0192f3a4-6000-7abc-8def-0123456789ab");
    expect(p.timezone).toBe("Australia/Melbourne");
    expect(p.include).toEqual({ body: true });
    const op = p.ops[0]!;
    expect(op.kind).toBe("update");
    if (op.kind !== "update") return;
    expect([...op.patch!.keys()]).toEqual(["status", "priority", "estimate"]);
    expect(op.bodyEdits).toEqual([
      [0, 5, "Agenda"],
      [42, 42, "\n- follow up with Bo"],
    ]);
    expect(op.bodyBase).toMatch(/^sha256:38732073/);
    expect(op.base).toEqual([{ key: "status", observed: "open" }, { key: "snoozed" }]);
  });

  it("receipt-rejected carries a conflict problem with recovery", () => {
    const r = w.receipt.dec(decode(read("client/receipt-rejected.cbor")));
    expect(r.state).toBe("rejected");
    expect(r.problem?.code).toBe("conflict");
    expect(r.problem?.recovery).toBe("resolve_conflict");
    expect(r.problem?.reason).toBe("revision");
  });

  it("hold-file has blob refs for mine and theirs", () => {
    const h = w.hold.dec(decode(read("client/hold-file.cbor")));
    expect(h.reason).toBe("conflict");
    expect(typeof h.mine).toBe("object");
    expect(h.saves).toBe(0);
  });
});
