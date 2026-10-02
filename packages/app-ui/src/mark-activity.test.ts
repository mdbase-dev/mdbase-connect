import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getMdbaseMarkActivity,
  holdMdbaseMarkBusy,
  resetMdbaseMarkActivity,
  signalMdbaseMark,
  trackMdbaseMarkProgress
} from "./mark-activity.js";

beforeEach(() => {
  vi.useFakeTimers();
  resetMdbaseMarkActivity();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mark activity", () => {
  it("plays a signal, then clears it", () => {
    signalMdbaseMark("saved");
    expect(getMdbaseMarkActivity().signal?.kind).toBe("saved");

    vi.advanceTimersByTime(900);
    expect(getMdbaseMarkActivity().signal).toBeNull();
  });

  it("reacts once when several notices report the same save", () => {
    signalMdbaseMark("saved");
    const first = getMdbaseMarkActivity().signal;
    signalMdbaseMark("saved");
    expect(getMdbaseMarkActivity().signal).toBe(first);

    vi.advanceTimersByTime(400);
    signalMdbaseMark("saved");
    expect(getMdbaseMarkActivity().signal?.id).not.toBe(first?.id);
  });

  it("never covers a fresh error with a save", () => {
    signalMdbaseMark("error");
    signalMdbaseMark("saved");
    expect(getMdbaseMarkActivity().signal?.kind).toBe("error");

    signalMdbaseMark("saved");
    vi.advanceTimersByTime(400);
    signalMdbaseMark("saved");
    expect(getMdbaseMarkActivity().signal?.kind).toBe("saved");
  });

  it("lets an error interrupt a save", () => {
    signalMdbaseMark("saved");
    signalMdbaseMark("error");
    expect(getMdbaseMarkActivity().signal?.kind).toBe("error");
  });

  it("averages tracked progress and signals how each operation ended", () => {
    const upload = trackMdbaseMarkProgress();
    const index = trackMdbaseMarkProgress(0.5);
    upload.update(0.25);
    expect(getMdbaseMarkActivity().progress).toBe(0.375);

    upload.update(7);
    expect(getMdbaseMarkActivity().progress).toBe(0.75);

    upload.finish();
    expect(getMdbaseMarkActivity()).toMatchObject({ progress: 0.5, signal: { kind: "saved" } });

    index.fail();
    index.update(0.9);
    expect(getMdbaseMarkActivity()).toMatchObject({ progress: null, signal: { kind: "error" } });
  });

  it("ends quietly when cancelled", () => {
    trackMdbaseMarkProgress(0.4).cancel();
    expect(getMdbaseMarkActivity()).toMatchObject({ progress: null, signal: null });
  });

  it("shows the most recent held loop until each is released", () => {
    const sync = holdMdbaseMarkBusy("stream");
    const save = holdMdbaseMarkBusy("bounce");
    expect(getMdbaseMarkActivity().busy).toBe("bounce");

    save();
    save();
    expect(getMdbaseMarkActivity().busy).toBe("stream");

    sync();
    expect(getMdbaseMarkActivity().busy).toBeNull();
  });
});
