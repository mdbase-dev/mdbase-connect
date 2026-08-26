import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CollaborationFrameError,
  decodeCollaborationFrame,
  encodeCollaborationFrame,
  MAX_COLLABORATION_PAYLOAD_BYTES
} from "../dist/index.js";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/collaboration-frame-v1.json", import.meta.url),
  "utf8"
));
const fixtureBytes = new Uint8Array(readFileSync(
  new URL("./fixtures/collaboration-frame-v1.bin", import.meta.url)
));

test("collaboration frame v1 matches the shared Rust and TypeScript fixture", () => {
  assert.equal(fixtureBytes.byteLength, fixture.encoded_bytes);
  assert.equal(
    createHash("sha256").update(fixtureBytes).digest("hex"),
    fixture.encoded_sha256
  );
  const decoded = decodeCollaborationFrame(fixtureBytes);
  assert.deepEqual(decoded, {
    ...fixture.frame,
    payload: new Uint8Array(fixture.frame.payload)
  });
  assert.deepEqual(encodeCollaborationFrame(decoded), fixtureBytes);
});

test("collaboration frames reject truncation, flags, versions, and limits", () => {
  assert.throws(
    () => decodeCollaborationFrame(fixtureBytes.subarray(0, fixtureBytes.length - 1)),
    (error) => error instanceof CollaborationFrameError
      && error.code === "collaboration_frame_invalid"
  );
  for (const [offset, value, code] of [
    [7, 1, "collaboration_frame_invalid"],
    [5, 2, "collaboration_protocol_unsupported"]
  ]) {
    const changed = fixtureBytes.slice();
    changed[offset] = value;
    assert.throws(
      () => decodeCollaborationFrame(changed),
      (error) => error instanceof CollaborationFrameError && error.code === code
    );
  }
  assert.throws(
    () => encodeCollaborationFrame({
      kind: "update",
      metadata: {},
      payload: new Uint8Array(MAX_COLLABORATION_PAYLOAD_BYTES + 1)
    }),
    (error) => error instanceof CollaborationFrameError
      && error.code === "collaboration_frame_too_large"
  );
});
