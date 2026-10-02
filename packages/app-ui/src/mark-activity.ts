import { useEffect, useRef, useSyncExternalStore } from "react";

import type { MdbaseMarkLoop, MdbaseMarkSignal, MdbaseMarkSignalKind } from "./brand.js";

/**
 * What the app's mark is showing for work happening anywhere in the page. The app
 * switcher reads it, so a save, a failure or an upload deep inside an app reaches
 * the mark without threading state through the tree.
 */
export type MdbaseMarkActivity = Readonly<{
  signal: MdbaseMarkSignal | null;
  /** Mean of every tracked operation, 0 to 1; null when nothing is tracked. */
  progress: number | null;
  /** The most recently held loop; null when nothing is busy. */
  busy: MdbaseMarkLoop | null;
}>;

export type MdbaseMarkProgress = Readonly<{
  update(fraction: number): void;
  /** Ends the operation and plays `saved`. */
  finish(): void;
  /** Ends the operation and plays `error`. */
  fail(): void;
  /** Ends the operation quietly. */
  cancel(): void;
}>;

/** Matches the signal animations in `motion.css`. */
const SIGNAL_MS: Record<MdbaseMarkSignalKind, number> = { saved: 900, error: 1500 };
/** Several notices often report the same save; one reaction is enough. */
const REPEAT_MS = 400;

const IDLE: MdbaseMarkActivity = { signal: null, progress: null, busy: null };

let snapshot = IDLE;
let signal: MdbaseMarkSignal | null = null;
let signalAt = 0;
let signalTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;
const tasks = new Map<number, number>();
const holds: { id: number; loop: MdbaseMarkLoop }[] = [];
const listeners = new Set<() => void>();

function publish(): void {
  const progress = tasks.size
    ? [...tasks.values()].reduce((sum, fraction) => sum + fraction, 0) / tasks.size
    : null;
  snapshot = { signal, progress, busy: holds.at(-1)?.loop ?? null };
  for (const listener of listeners) listener();
}

function clamp(fraction: number): number {
  return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
}

/** Plays a one-shot reaction on the mark. A fresh error is never covered by a save. */
export function signalMdbaseMark(kind: MdbaseMarkSignalKind): void {
  const now = Date.now();
  if (signal && now - signalAt < REPEAT_MS && (signal.kind === kind || signal.kind === "error")) return;
  signal = { kind, id: nextId++ };
  signalAt = now;
  clearTimeout(signalTimer);
  signalTimer = setTimeout(() => {
    signal = null;
    publish();
  }, SIGNAL_MS[kind]);
  publish();
}

/** Shows an operation's known progress on the mark until it finishes, fails or is cancelled. */
export function trackMdbaseMarkProgress(initial = 0): MdbaseMarkProgress {
  const id = nextId++;
  tasks.set(id, clamp(initial));
  publish();
  const end = (kind?: MdbaseMarkSignalKind): void => {
    if (!tasks.delete(id)) return;
    publish();
    if (kind) signalMdbaseMark(kind);
  };
  return {
    update(fraction) {
      if (!tasks.has(id)) return;
      tasks.set(id, clamp(fraction));
      publish();
    },
    finish: () => end("saved"),
    fail: () => end("error"),
    cancel: () => end()
  };
}

/** Loops the mark until the returned release is called. Releasing twice is harmless. */
export function holdMdbaseMarkBusy(loop: MdbaseMarkLoop): () => void {
  const id = nextId++;
  holds.push({ id, loop });
  publish();
  return () => {
    const index = holds.findIndex((hold) => hold.id === id);
    if (index < 0) return;
    holds.splice(index, 1);
    publish();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMdbaseMarkActivity(): MdbaseMarkActivity {
  return snapshot;
}

export function useMdbaseMarkActivity(): MdbaseMarkActivity {
  return useSyncExternalStore(subscribe, getMdbaseMarkActivity, () => IDLE);
}

/**
 * Shows `fraction` on the mark while it is a number. Becoming null or unmounting ends the
 * operation quietly; call `signalMdbaseMark` separately if the end deserves a reaction.
 */
export function useMdbaseMarkProgress(fraction: number | null | undefined): void {
  const handle = useRef<MdbaseMarkProgress | null>(null);
  const tracking = typeof fraction === "number";
  useEffect(() => {
    if (!tracking) return;
    const progress = trackMdbaseMarkProgress();
    handle.current = progress;
    return () => {
      progress.cancel();
      handle.current = null;
    };
  }, [tracking]);
  useEffect(() => {
    if (typeof fraction === "number") handle.current?.update(fraction);
  }, [fraction]);
}

/** Loops the mark while `loop` is set. */
export function useMdbaseMarkBusy(loop: MdbaseMarkLoop | null | undefined | false): void {
  useEffect(() => (loop ? holdMdbaseMarkBusy(loop) : undefined), [loop]);
}

/** For tests: forget every signal, operation and hold. */
export function resetMdbaseMarkActivity(): void {
  clearTimeout(signalTimer);
  signal = null;
  signalAt = 0;
  tasks.clear();
  holds.length = 0;
  publish();
}
