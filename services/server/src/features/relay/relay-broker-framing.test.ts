import { describe, expect, it } from "vitest";
import {
  BROKER_LOGICAL_MESSAGE_LIMIT_BYTES,
  BrokerFrameAssembler,
  BrokerFrameError,
  encodeBrokerFrames,
  inspectBrokerFrame
} from "./relay-broker-framing.js";

describe("relay broker framing", () => {
  it("round-trips a multi-megabyte response below a small broker payload ceiling", () => {
    const value = new Uint8Array(5 * 1_024 * 1_024 + 37);
    for (let index = 0; index < value.length; index += 1) value[index] = index % 251;
    const frames = encodeBrokerFrames(value, 2, 128 * 1_024);
    expect(frames.length).toBeGreaterThan(40);
    expect(frames.every((frame) => frame.byteLength < 128 * 1_024)).toBe(true);

    const assembler = new BrokerFrameAssembler();
    let result: Uint8Array | null = null;
    for (const frame of [...frames].reverse()) {
      result = assembler.accept(frame, 2) ?? result;
    }
    expect(result?.byteLength).toBe(value.byteLength);
    expect(Buffer.compare(Buffer.from(result!), Buffer.from(value))).toBe(0);
  });

  it("represents an empty message with one valid frame", () => {
    const frames = encodeBrokerFrames(new Uint8Array(), 1, 64 * 1_024);
    expect(frames).toHaveLength(1);
    expect(new BrokerFrameAssembler().accept(frames[0]!, 1)).toEqual(new Uint8Array());
  });

  it("rejects duplicate, mismatched, malformed, and oversized sequences", () => {
    const frames = encodeBrokerFrames(new Uint8Array(200_000), 1, 64 * 1_024);
    const assembler = new BrokerFrameAssembler();
    expect(assembler.accept(frames[0]!, 1)).toBeNull();
    expect(() => assembler.accept(frames[0]!, 1)).toThrowError(BrokerFrameError);
    expect(() => new BrokerFrameAssembler().accept(frames[1]!, 2))
      .toThrowError(BrokerFrameError);
    expect(() => inspectBrokerFrame(Uint8Array.of(1, 2, 3)))
      .toThrowError(BrokerFrameError);
    expect(() => encodeBrokerFrames(
      new Uint8Array(BROKER_LOGICAL_MESSAGE_LIMIT_BYTES + 1),
      1,
      64 * 1_024
    )).toThrowError(BrokerFrameError);
  });
});
