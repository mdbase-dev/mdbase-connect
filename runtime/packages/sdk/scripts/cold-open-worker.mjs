// Synthetic encrypted log from mdbn-bench. AppWasmRuntime verifies and applies
// each reply. Only the fixture transport is in memory.
import { AppWasmRuntime } from "../src/app-host/wasm-runtime.ts";
import {
  AppBinaryIndexHost,
  appSqlHost,
  openAppSahpoolIndex,
} from "../src/app-storage/app-sqlite-index.ts";
import { decode, encode } from "../src/cbor.ts";
import { uuidFromBytes } from "../src/codec.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const bytes = (n) => new Uint8Array(32).fill(n);
const id = (n) => uuidFromBytes(bytes(n).subarray(0, 16));
const hex = (bytes) =>
  Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
const load = async (name) =>
  new Uint8Array(await (await fetch(name)).arrayBuffer());

function fixtureLog([genesis, head, behind, control, tail, sealed]) {
  const objects = new Map(
    sealed.map(([address, body]) => [
      hex(address),
      { body, checksum: sha256(body) },
    ]),
  );
  const snapshot = head.get(3).get(0);
  function result(method, params) {
    switch (method) {
      case "head":
        return head;
      case "get_snapshot":
        return new Map([[0, [head.get(3)]]]);
      case "get_object": {
        const { body, checksum } = objects.get(hex(params.get(1)));
        const [start, len] = params.get(2) ?? [0, body.length];
        return new Map([
          [0, body.subarray(start, start + len)],
          [2, body.length],
          [3, checksum],
        ]);
      }
      case "read": {
        const after = params.get(1),
          limit = params.get(2);
        const controls = params.get(3) === 1;
        if (!controls && after < snapshot) return behind;
        const page = new Map(controls ? control : tail);
        const items = page.get(0).filter(([seq]) => seq > after);
        page.set(0, items.slice(0, limit));
        page.set(6, items.length > limit);
        return page;
      }
      default:
        throw Error("unexpected fixture request: " + method);
    }
  }
  return {
    genesis,
    head: head.get(0),
    snapshot,
    reply(call) {
      const frame = decode(call.frame),
        id = frame.get(1);
      return [
        BigInt(id),
        encode(
          new Map([
            [0, 1],
            [1, id],
            [2, result(frame.get(2), frame.get(3))],
          ]),
        ),
      ];
    },
  };
}
const metrics = () => ({
  hostMs: 0,
  sqlMs: 0,
  writeMs: 0,
  flushMs: 0,
  readMs: 0,
  fixtureMs: 0,
  statements: 0,
  calls: 0,
  requestBytes: 0,
});
async function run() {
  const log = fixtureLog(decode(await load("/fixture")));
  const runtimeBytes = await load("/runtime.wasm");
  const { default: initialize } = await import(
    /* @vite-ignore */ new URL("/sqlite3.js", location.origin).href
  );
  globalThis.sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, "opfs-wl": true } },
  };
  let m = metrics();
  for (const [method, key] of [
    ["write", "writeMs"],
    ["flush", "flushMs"],
    ["read", "readMs"],
  ]) {
    const proto = FileSystemSyncAccessHandle.prototype,
      original = proto[method];
    proto[method] = function (...args) {
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        m[key] += performance.now() - start;
      }
    };
  }
  const sqlite = await initialize({ wasmBinary: await load("/sqlite3.wasm") });
  const collection = id(7),
    deviceId = id(101);
  const { index, pool } = await openAppSahpoolIndex(sqlite, {
    account: id(1),
    installation: id(2),
    collection,
  });
  try {
    const bridge = new AppBinaryIndexHost({
      get needsRecovery() {
        return index.needsRecovery;
      },
      fence: () => index.fence(),
      run(batch, limits) {
        m.statements += batch.stmts.length;
        const start = performance.now();
        try {
          return index.run(batch, limits);
        } finally {
          m.sqlMs += performance.now() - start;
        }
      },
    });
    const runtime = await AppWasmRuntime.create(runtimeBytes, {
      get needsRecovery() {
        return bridge.needsRecovery;
      },
      fence: () => bridge.fence(),
      import(exports) {
        const run = appSqlHost(bridge, exports);
        return (ptr, len) => {
          m.calls++;
          m.requestBytes += len;
          const start = performance.now();
          try {
            return run(ptr, len);
          } finally {
            m.hostMs += performance.now() - start;
          }
        };
      },
    });
    const root = ed25519.getPublicKey(bytes(0x71)),
      policy = ed25519.getPublicKey(bytes(0x72));
    const kid = (key) => sha256(key).slice(0, 16);
    runtime.openAppConsuming({
      collection,
      deviceId,
      replicaId: id(1),
      endpoint: 1,
      trustedRoots: [root],
      policyPins: encode([
        [[kid(root), root]],
        [[kid(policy), policy, kid(root)]],
      ]),
      trustedSigners: [deviceId],
      expectedGenesis: "sha256:" + hex(log.genesis),
      state: "e2e",
      cloudCopyOptIn: false,
      signSecretKey: bytes(101),
      kemSecretKey: bytes(101),
      opened: "fresh",
      sqliteVersion: index.info.sqliteVersion,
    });
    runtime.bindLogTransport({
      endpoint: 1,
      collection,
      isCurrent: () => true,
    });
    m = metrics();
    let start = performance.now(),
      install;
    for (let round = 0; round < 2000; round++) {
      for (const call of runtime.takeLogCalls()) {
        const begin = performance.now(),
          [id, reply] = log.reply(call);
        m.fixtureMs += performance.now() - begin;
        if (!runtime.acceptLogReply(id, reply))
          throw Error("fixture reply refused");
      }
      runtime.tick();
      const status = runtime.observations().status;
      if (!install && status.confirmedThrough === log.snapshot) {
        install = { ...m, wallMs: performance.now() - start };
        m = metrics();
        start = performance.now();
      }
      if (status.confirmedThrough === log.head) {
        const replay = { ...m, wallMs: performance.now() - start };
        if (!install || status.incidents.length)
          throw Error("invalid run " + JSON.stringify(status));
        const rows = index.run({
          mode: "Autocommit",
          stmts: [
            {
              sql: "SELECT (SELECT count(*) FROM st_rec), (SELECT count(*) FROM st_qrecord), (SELECT ready FROM st_qstate), (SELECT ready FROM st_qraw_state)",
              params: [],
            },
          ],
        });
        if (
          rows[0].values.map((v) => String(v.value)).join(",") !==
          "10080,10080,1,1"
        )
          throw Error("incomplete index");
        if (!(await runtime.close())) throw Error("unclean close");
        return { install, replay };
      }
      if (round === 1999)
        throw Error("did not catch up " + JSON.stringify(status));
    }
  } finally {
    index.close();
    pool.pauseVfs();
  }
}
run().then(
  (value) => postMessage({ value }),
  (e) => postMessage({ error: String(e.stack ?? e) }),
);
