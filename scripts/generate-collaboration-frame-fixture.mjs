import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeCollaborationFrame } from "../packages/protocol/dist/index.js";

const directory = resolve(import.meta.dirname, "../packages/protocol/test/fixtures");
await mkdir(directory, { recursive: true });
const frame = {
  kind: "update",
  metadata: {
    client_mutation_id: "018f0000-0000-7000-8000-000000000001",
    collaboration_epoch: 7,
    profile: "markdown-body-yjs-v13"
  },
  payload: new Uint8Array([0, 1, 2, 127, 128, 255])
};
const encoded = encodeCollaborationFrame(frame);
await writeFile(resolve(directory, "collaboration-frame-v1.bin"), encoded);
await writeFile(resolve(directory, "collaboration-frame-v1.json"), `${JSON.stringify({
  protocol_version: 1,
  frame: {
    ...frame,
    payload: [...frame.payload]
  },
  encoded_bytes: encoded.byteLength,
  encoded_sha256: createHash("sha256").update(encoded).digest("hex")
}, null, 2)}\n`);
