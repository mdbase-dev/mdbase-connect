// npm exec -- vitest bench --run test/collection-10k.bench.mjs
import assert from "node:assert/strict";
import { bench } from "vitest";
import { LiveQuery } from "../src/client.js";
import { decode, encode } from "../src/cbor.js";
import { decodePlain } from "../src/codec.js";
import { queryResult } from "../src/wire.js";
import { appLocalConnector, attachAppLocalFacade } from "../src/app-host/local-facade.js";
import { AppLogPushChannel } from "../src/app-host/log-push.js";

const id = i => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const rows = Array.from({ length: 10000 }, (_, i) => ({
  id: id(i), path: `tasks/${i}.md`, revision: "sha256:" + "ab".repeat(32),
  types: ["task"], frontmatter: new Map([["title", `task ${i}`]]),
  state: { state: "confirmed", confirmedSeq: i + 1 }
}));
const pages = [];
for (let i = 0; i < rows.length; i += 100) {
  pages.push(queryResult.enc({ records: rows.slice(i, i + 100), complete: true, asOf: rows.length }));
}
const encoded = pages.map(encode);
bench("10k query rows, CBOR and public page decoding", () => {
  let count = 0;
  for (const bytes of encoded) count += decodePlain(queryResult, decode(bytes)).records.length;
  assert.equal(count, rows.length);
});

bench("10k rows, 100 page round trips on the SDK data port", async () => {
  const { port1, port2 } = new MessageChannel();
  const scope = { account: id(1), installation: id(2), collection: id(3), isCurrent: () => true };
  const echo = { send(frame) { echo.onframe(frame); }, close() {} };
  const owner = attachAppLocalFacade({ connect: () => echo }, port1, scope);
  const connector = appLocalConnector(port2, scope);
  try {
    const { port } = await connector.open([0]);
    let count = 0;
    for (const page of pages) {
      const reply = new Promise(resolve => { port.onframe = resolve; });
      port.send(page);
      count += (await reply).get(0).length;
    }
    assert.equal(count, rows.length);
  } finally { connector.close(); owner.close(); }
});

bench("10k additions, 100 ordered live diffs, four observers reading records", () => {
  const live = new LiveQuery(null, {}, undefined);
  let observed = 0;
  for (let i = 0; i < 4; i++) live.subscribe(state => { observed += state.records.length; });
  live._apply({ sub: 1, kind: "snapshot", added: [], complete: true, asOf: 0 });
  for (let i = 0; i < rows.length; i += 100) {
    live._apply({ sub: 1, kind: "diff", added: rows.slice(i, i + 100), complete: true, asOf: i + 100 });
  }
  assert.equal(observed, 4 * 100 * 101 * 50);
});

bench("10k reconnect nudges during token acquisition, subscribe at head 10000", async () => {
  let connections = 0, catches = 0, sends = 0;
  const { promise, resolve } = Promise.withResolvers();
  class Socket {
    constructor() { connections++; resolve(this); }
    send() { sends++; }
    close() {}
  }
  const source = { origin: "https://log.test", collection: id(3), deviceId: id(4),
    isCurrent: () => true, accessToken: async () => "fixture", nonce: async () => new Uint8Array(32),
    signHello: () => new Uint8Array(64) };
  const channel = new AppLogPushChannel(source, {
    push(frame) { assert.equal(decode(frame).get(2).get(1), rows.length); catches++; },
    live() {}, ended() {}
  }, { WebSocket: Socket });
  try {
    for (let i = 0; i < rows.length; i++) channel.nudge();
    const socket = await promise;
    socket.onopen();
    for (const [id, payload] of [[1, new Map()], [2, new Map([[0, rows.length], [1, new Uint8Array(32)]])]]) {
      socket.onmessage({ data: encode(new Map([[0, 1], [1, id], [2, payload]])).buffer });
    }
    assert.deepEqual([connections, sends, catches], [1, 2, 1]);
  } finally { channel.close(); }
});
