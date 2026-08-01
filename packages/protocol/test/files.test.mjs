import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FILE_FRAME_PREFIX_BYTES,
  FileFrameError,
  RELAY_FILE_PREFIX_BYTES,
  RelayFileFrameError,
  decodeFileFrame,
  decodeRelayFileFrame,
  encodeRelayFileFrame,
  encodeFileFrame
} from "../dist/files.js";

const here = dirname(fileURLToPath(import.meta.url));
const goldenFrame = JSON.parse(readFileSync(resolve(here, "fixtures/file-frame-v1.json"), "utf8"));
const goldenRelay = JSON.parse(readFileSync(resolve(here, "fixtures/relay-file-v1.json"), "utf8"));

const header = Object.freeze({
  protocol_version: 1,
  protection: "transport_tls",
  grant_id: "01911111-1111-7111-8111-111111111111",
  authority_id: "01922222-2222-7222-8222-222222222222",
  collection_id: "01933333-3333-7333-8333-333333333333",
  transfer_id: "01944444-4444-7444-8444-444444444444",
  direction: "upload",
  chunk_size: 65536,
  chunk_index: 0,
  offset: 0,
  plaintext_length: 32,
  total_size: 32,
  scope_epoch: 7
});
const payload = Uint8Array.from({ length: 32 }, (_, index) => index);

function expectFrameError(code, action) {
  assert.throws(action, (error) => error instanceof FileFrameError && error.code === code);
}

function expectRelayError(code, action) {
  assert.throws(action, (error) => error instanceof RelayFileFrameError && error.code === code);
}

function rawFrame(headerSource, framePayload = payload) {
  const headerBytes = new TextEncoder().encode(headerSource);
  const output = new Uint8Array(FILE_FRAME_PREFIX_BYTES + headerBytes.length + framePayload.length);
  output.set([0x4d, 0x44, 0x42, 0x46, 1, 1, 0, 0], 0);
  const view = new DataView(output.buffer);
  view.setUint32(8, headerBytes.length, false);
  view.setUint32(12, framePayload.length, false);
  output.set(headerBytes, FILE_FRAME_PREFIX_BYTES);
  output.set(framePayload, FILE_FRAME_PREFIX_BYTES + headerBytes.length);
  return output;
}

test("file frames round-trip without sharing caller-owned memory", () => {
  const encoded = encodeFileFrame({ kind: "upload_chunk", header, payload });
  const padded = new Uint8Array(encoded.length + 9);
  padded.set(encoded, 4);
  const decoded = decodeFileFrame(padded.subarray(4, 4 + encoded.length));
  assert.deepEqual(decoded.header, header);
  assert.deepEqual(decoded.payload, payload);
  encoded.fill(255);
  assert.deepEqual(decoded.payload, payload);
});

test("file frame v1 encoding matches the shared Rust and TypeScript fixture", () => {
  const encoded = encodeFileFrame({ kind: goldenFrame.kind, header: goldenFrame.header, payload });
  assert.equal(Buffer.from(encoded).toString("base64"), goldenFrame.frame_base64);
  const decoded = decodeFileFrame(Buffer.from(goldenFrame.frame_base64, "base64"));
  assert.deepEqual(decoded.header, goldenFrame.header);
  assert.equal(Buffer.from(decoded.payload).toString("base64"), goldenFrame.payload_base64);
});

test("file frame decoder rejects malformed prefixes before reading content", () => {
  expectFrameError("invalid_length", () => decodeFileFrame(new Uint8Array(15)));
  const encoded = encodeFileFrame({ kind: "upload_chunk", header, payload });
  const badMagic = encoded.slice();
  badMagic[0] = 0;
  expectFrameError("invalid_magic", () => decodeFileFrame(badMagic));
  const badVersion = encoded.slice();
  badVersion[4] = 2;
  expectFrameError("unsupported_version", () => decodeFileFrame(badVersion));
  const badKind = encoded.slice();
  badKind[5] = 99;
  expectFrameError("invalid_kind", () => decodeFileFrame(badKind));
  const badFlags = encoded.slice();
  badFlags[7] = 1;
  expectFrameError("unsupported_flags", () => decodeFileFrame(badFlags));
});

test("file frame decoder enforces declared and configured lengths", () => {
  const encoded = encodeFileFrame({ kind: "upload_chunk", header, payload });
  expectFrameError("invalid_length", () => decodeFileFrame(encoded.subarray(0, -1)));
  const trailing = new Uint8Array(encoded.length + 1);
  trailing.set(encoded);
  expectFrameError("invalid_length", () => decodeFileFrame(trailing));

  const hugeHeader = encoded.slice();
  new DataView(hugeHeader.buffer).setUint32(8, 0xffffffff, false);
  expectFrameError("limit_exceeded", () => decodeFileFrame(hugeHeader));
  expectFrameError("limit_exceeded", () => decodeFileFrame(encoded, { maxPayloadBytes: 31 }));
});

test("file frame headers are canonical, closed, and semantically bound", () => {
  const canonical = JSON.stringify(header);
  expectFrameError("invalid_header", () => decodeFileFrame(rawFrame(` ${canonical}`)));
  expectFrameError("invalid_header", () => decodeFileFrame(rawFrame(canonical.replace(
    '"scope_epoch":7',
    '"scope_epoch":7,"scope_epoch":7'
  ))));
  expectFrameError("invalid_header", () => decodeFileFrame(rawFrame(canonical.replace(
    '"scope_epoch":7',
    '"scope_epoch":7,"future":true'
  ))));
  expectFrameError("invalid_header", () => encodeFileFrame({
    kind: "download_chunk",
    header,
    payload
  }));
  expectFrameError("invalid_header", () => encodeFileFrame({
    kind: "upload_chunk",
    header: { ...header, offset: 1 },
    payload
  }));
  expectFrameError("invalid_header", () => encodeFileFrame({
    kind: "upload_chunk",
    header: { ...header, total_size: 31 },
    payload
  }));
});

test("AEAD file frames account for their authentication tag", () => {
  const aeadHeader = {
    ...header,
    protection: "grant_aead_v1",
    key_id: "grant-key-3"
  };
  expectFrameError("invalid_length", () => encodeFileFrame({
    kind: "upload_chunk",
    header: aeadHeader,
    payload
  }));
  const protectedPayload = new Uint8Array(payload.length + 16);
  const decoded = decodeFileFrame(encodeFileFrame({
    kind: "upload_chunk",
    header: aeadHeader,
    payload: protectedPayload
  }));
  assert.equal(decoded.payload.length, 48);
});

test("relay file envelopes correlate opaque chunks without base64", () => {
  const relayHeader = {
    protocol_version: 1,
    type: "upload_chunk",
    request_id: "01955555-5555-7555-8555-555555555555",
    grant_id: header.grant_id,
    transfer_id: header.transfer_id,
    chunk_index: 0
  };
  const opaque = encodeFileFrame({ kind: "upload_chunk", header, payload });
  const encoded = encodeRelayFileFrame({
    kind: "upload_chunk",
    header: relayHeader,
    payload: opaque
  });
  const decoded = decodeRelayFileFrame(encoded);
  assert.deepEqual(decoded.header, relayHeader);
  assert.deepEqual(decoded.payload, opaque);

  const request = encodeRelayFileFrame({
    kind: "download_request",
    header: { ...relayHeader, type: "download_request" },
    payload: new Uint8Array()
  });
  assert.equal(decodeRelayFileFrame(request).payload.length, 0);
});

test("relay file v1 encoding matches the shared Rust and TypeScript fixture", () => {
  const payload = Buffer.from(goldenRelay.payload_base64, "base64");
  const encoded = encodeRelayFileFrame({
    kind: goldenRelay.kind,
    header: goldenRelay.header,
    payload
  });
  assert.equal(Buffer.from(encoded).toString("base64"), goldenRelay.frame_base64);
  assert.deepEqual(decodeRelayFileFrame(encoded).header, goldenRelay.header);
});

test("relay file envelopes reject ambiguity before forwarding bytes", () => {
  const relayHeader = {
    protocol_version: 1,
    type: "upload_acknowledged",
    request_id: "01955555-5555-7555-8555-555555555555",
    grant_id: header.grant_id,
    transfer_id: header.transfer_id,
    chunk_index: 0
  };
  const encoded = encodeRelayFileFrame({
    kind: "upload_acknowledged",
    header: relayHeader,
    payload: new Uint8Array()
  });
  expectRelayError("invalid_length", () => decodeRelayFileFrame(encoded.subarray(0, -1)));
  const badKind = encoded.slice();
  badKind[5] = 99;
  expectRelayError("invalid_kind", () => decodeRelayFileFrame(badKind));
  expectRelayError("invalid_header", () => encodeRelayFileFrame({
    kind: "rejected",
    header: relayHeader,
    payload: new Uint8Array()
  }));
  expectRelayError("invalid_length", () => encodeRelayFileFrame({
    kind: "upload_acknowledged",
    header: relayHeader,
    payload: new Uint8Array([1])
  }));

  const headerLength = new DataView(encoded.buffer).getUint32(8, false);
  const source = new TextDecoder().decode(
    encoded.subarray(RELAY_FILE_PREFIX_BYTES, RELAY_FILE_PREFIX_BYTES + headerLength)
  );
  const noncanonical = new TextEncoder().encode(` ${source}`);
  const raw = new Uint8Array(RELAY_FILE_PREFIX_BYTES + noncanonical.length);
  raw.set(encoded.subarray(0, RELAY_FILE_PREFIX_BYTES), 0);
  const view = new DataView(raw.buffer);
  view.setUint32(8, noncanonical.length, false);
  raw.set(noncanonical, RELAY_FILE_PREFIX_BYTES);
  expectRelayError("invalid_header", () => decodeRelayFileFrame(raw));
});
