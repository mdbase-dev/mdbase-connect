import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AWARENESS_COLORS,
  CollaborationFrameError,
  COLLABORATION_MESSAGE_KIND,
  awarenessHelloAdvertisement,
  encodeAwarenessSnapshotMetadata,
  encodeClientAwarenessMetadata,
  encodeCollaborationFrame,
  decodeCollaborationFrame,
  isValidAwarenessDisplayName,
  MAX_AWARENESS_NAME_SCALARS,
  MAX_AWARENESS_PARTICIPANTS,
  MAX_AWARENESS_SELECTIONS,
  parseAwarenessSnapshotMetadata,
  parseClientAwarenessMetadata
} from "../dist/index.js";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/collaboration-awareness-v1.json", import.meta.url),
  "utf8"
));

function decodeHex(hex) {
  return Uint8Array.from(hex.match(/.{2}/gs).map((byte) => parseInt(byte, 16)));
}

function awarenessFrame(metadata, payload = new Uint8Array()) {
  return {
    kind: "awareness",
    metadata,
    payload
  };
}

test("awareness v1 matches the shared Rust and TypeScript fixtures", () => {
  for (const [name, expect] of [
    ["client_update", parseClientAwarenessMetadata],
    ["server_snapshot", parseAwarenessSnapshotMetadata]
  ]) {
    const caseFixture = fixture[name];
    const bytes = decodeHex(caseFixture.frame_hex);
    assert.equal(bytes.byteLength, caseFixture.encoded_bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      caseFixture.frame_sha256
    );
    const frame = decodeCollaborationFrame(bytes);
    assert.equal(frame.kind, "awareness");
    assert.deepEqual(
      [...frame.payload],
      []
    );
    // Semantic parity with the fixture metadata.
    if (name === "client_update") {
      assert.deepEqual(
        caseFixture.metadata,
        { status: "active", selections: [{ anchor: 3, head: 9 }] }
      );
    } else {
      assert.deepEqual(caseFixture.metadata.participants.length, 2);
    }
    // Byte-exact re-encode through the TypeScript encoder.
    const rebuilt = name === "client_update"
      ? encodeClientAwarenessMetadata(
        caseFixture.metadata.status === "active"
          ? { status: "active", selections: caseFixture.metadata.selections }
          : { status: "idle", selections: [] }
      )
      : encodeAwarenessSnapshotMetadata({ participants: caseFixture.metadata.participants });
    const encoded = encodeCollaborationFrame(awarenessFrame(rebuilt));
    assert.deepEqual([...encoded], [...bytes], `${name} re-encode diverged`);
  }
});

test("client updates reject identity, text, path, and deep fields", () => {
  for (const smuggled of [
    "name", "color", "user_id", "replica_id", "session_id", "account_id",
    "grant_id", "path", "text", "email", "timestamp", "record_id"
  ]) {
    const metadata = { status: "active", selections: [], [smuggled]: "smuggled" };
    assert.throws(
      () => parseClientAwarenessMetadata(metadata, new Uint8Array(), 4096),
      (error) => error.name === "AwarenessMetadataError"
        && error.code === "awareness_shape_invalid",
      `${smuggled} was accepted`
    );
  }
  assert.throws(
    () => parseClientAwarenessMetadata(
      { status: "active", selections: [{ anchor: 0, head: 1, extra: {} }] },
      new Uint8Array(),
      4096
    ),
    (error) => error.code === "awareness_shape_invalid"
  );
});

test("client updates reject shape, enum, number, and payload violations", () => {
  for (const metadata of [
    { status: "away", selections: [] },
    { status: "active", selections: {} },
    { status: "active", selections: [{ anchor: "0", head: 1 }] },
    { status: "active", selections: [{ anchor: 0.5, head: 1 }] },
    { status: "active", selections: [[{ anchor: 0, head: 1 }]] },
    { status: "active" },
    { selections: [] },
    {},
    null
  ]) {
    assert.throws(
      () => parseClientAwarenessMetadata(metadata ?? {}, new Uint8Array(), 4096),
      (error) => error.code === "awareness_shape_invalid"
    );
  }
  // Non-empty payloads always reject.
  assert.throws(
    () => parseClientAwarenessMetadata(
      { status: "active", selections: [] },
      new Uint8Array([1]),
      4096
    ),
    (error) => error.code === "awareness_payload_not_empty"
  );
  // Out-of-range positions.
  assert.throws(
    () => parseClientAwarenessMetadata(
      { status: "active", selections: [{ anchor: 0, head: 4097 }] },
      new Uint8Array(),
      4096
    ),
    (error) => error.code === "awareness_position_out_of_range"
  );
});

test("client updates bound duplicate and excess selections", () => {
  assert.throws(
    () => parseClientAwarenessMetadata(
      {
        status: "active",
        selections: [{ anchor: 4, head: 8 }, { anchor: 4, head: 8 }]
      },
      new Uint8Array(),
      1024
    ),
    (error) => error.code === "awareness_duplicate_selection"
  );
  const excess = [];
  for (let index = 0; index <= MAX_AWARENESS_SELECTIONS; index += 1) {
    excess.push({ anchor: index * 2, head: index * 2 + 1 });
  }
  assert.throws(
    () => parseClientAwarenessMetadata(
      { status: "active", selections: excess },
      new Uint8Array(),
      1024
    ),
    (error) => error.code === "awareness_too_many_selections"
  );
});

test("snapshots allow duplicate names and colors but bound counts and names", () => {
  const duplicated = {
    participants: [
      { name: "Ada", color: "teal", status: "active", selections: [{ anchor: 0, head: 4 }] },
      { name: "Ada", color: "teal", status: "idle", selections: [] }
    ]
  };
  assert.deepEqual(
    parseAwarenessSnapshotMetadata(
      encodeAwarenessSnapshotMetadata(duplicated),
      4096
    ),
    duplicated
  );

  const excess = [];
  for (let index = 0; index <= MAX_AWARENESS_PARTICIPANTS; index += 1) {
    excess.push({
      name: `P${index}`, color: "blue", status: "active", selections: []
    });
  }
  assert.throws(
    () => encodeAwarenessSnapshotMetadata({ participants: excess }),
    (error) => error.code === "awareness_too_many_participants"
  );
  for (const name of ["", " padded", "padded ", "a\u0007", "a\u202Eb", "a\u2066b", "e\u0301"]) {
    assert.equal(isValidAwarenessDisplayName(name), false, `${name} accepted`);
  }
  assert.equal(
    isValidAwarenessDisplayName("x".repeat(MAX_AWARENESS_NAME_SCALARS + 1)),
    false
  );
  assert.throws(
    () => encodeAwarenessSnapshotMetadata({
      participants: [
        { name: "a\u202Eb", color: "slate", status: "active", selections: [] }
      ]
    }),
    (error) => error.code === "awareness_name_invalid"
  );
  assert.throws(
    () => parseAwarenessSnapshotMetadata(
      {
        participants: [
          {
            name: "Ada",
            color: "crimson",
            status: "active",
            selections: []
          }
        ]
      },
      1024
    ),
    (error) => error.code === "awareness_shape_invalid"
  );
  assert.throws(
    () => parseAwarenessSnapshotMetadata(
      {
        participants: [
          { name: "Ada", color: "slate", status: "active", selections: [{ anchor: 1 << 30, head: 0 }] }
        ]
      },
      1024
    ),
    (error) => error.code === "awareness_position_out_of_range"
  );
});

test("the maximal snapshot stays below the frame metadata limit", () => {
  const longestName = "\u4e3b".repeat(MAX_AWARENESS_NAME_SCALARS);
  assert.equal(Buffer.byteLength(longestName), MAX_AWARENESS_NAME_SCALARS * 3);
  const selections = [
    { anchor: 2147483647, head: 4294967294 },
    { anchor: 0, head: 1 },
    { anchor: 2, head: 3 },
    { anchor: 4, head: 5 }
  ];
  const participants = [];
  for (let index = 0; index < MAX_AWARENESS_PARTICIPANTS; index += 1) {
    participants.push({
      name: longestName,
      color: "violet",
      status: "active",
      selections
    });
  }
  const metadata = encodeAwarenessSnapshotMetadata({ participants });
  const encoded = encodeCollaborationFrame(awarenessFrame(metadata));
  const view = new DataView(encoded.buffer);
  const metadataLength = view.getUint32(8, false);
  assert.ok(metadataLength < 16 * 1024);
  assert.equal(decodeCollaborationFrame(encoded).kind, "awareness");
});

test("the Hello advertisement is exact and provider-instance scoped", () => {
  assert.deepEqual(awarenessHelloAdvertisement(), {
    version: 1,
    scope: "provider_instance",
    max_participants: 16,
    max_selections: 4,
    max_updates_per_second: 8,
    ttl_seconds: 30
  });
  assert.equal(COLLABORATION_MESSAGE_KIND.awareness, 7);
  assert.equal(AWARENESS_COLORS.length, 8);
});
