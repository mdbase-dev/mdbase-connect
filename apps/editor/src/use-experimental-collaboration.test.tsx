import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type {
  ExperimentalHostedMarkdownRoom,
  ExperimentalHostedMarkdownRoomListener,
  ExperimentalHostedMarkdownRoomSnapshot
} from "@mdbase-dev/connect-collaboration";
import type { CollectionGateway } from "./model";
import {
  useExperimentalCollaboration,
  type ExperimentalEditorCollaboration
} from "./use-experimental-collaboration";

const collaborationTests = __MDBASE_EDITOR_EXPERIMENTAL_HOSTED_COLLABORATION__
  ? describe
  : describe.skip;

collaborationTests("experimental Editor collaboration lifecycle", () => {
  it("waits for durable synchronization before publishing or binding the exact body", async () => {
    const room = new FakeRoom();
    const onBody = vi.fn();
    let latest: ProbeState | undefined;
    render(<Probe gateway={gatewayReturning(room)} path="Notes/live.md" onBody={onBody} onState={(state) => { latest = state; }} />);

    await waitFor(() => expect(latest?.opening).toBe(false));
    expect(onBody).not.toHaveBeenCalled();
    expect(latest?.binding).toBeUndefined();

    act(() => room.emit({
      state: "connected",
      body: "# Exact heading\n\nBody 👋\n",
      mode: "read_write",
      epoch: 7,
      pendingUpdates: 0,
      participants: []
    }));

    await waitFor(() => expect(latest?.binding?.room).toBe(room));
    expect(onBody).toHaveBeenLastCalledWith("# Exact heading\n\nBody 👋\n");

    act(() => room.emit({
      state: "unavailable",
      body: "# Rejected local mutation",
      mode: "read_write",
      epoch: 7,
      pendingUpdates: 0,
      participants: [],
      problem: { code: "collaboration_document_too_large", message: "Rejected" }
    }));
    expect(onBody).not.toHaveBeenCalledWith("# Rejected local mutation");
    await waitFor(() => expect(latest?.binding).toBeUndefined());
  });

  it("defers React projection updates outside the room listener stack", async () => {
    const room = new FakeRoom();
    let emitting = false;
    const onBody = vi.fn(() => expect(emitting).toBe(false));
    render(<Probe gateway={gatewayReturning(room)} path="Notes/live.md" onBody={onBody} onState={() => undefined} />);
    await waitFor(() => expect(room.subscribe).toHaveBeenCalled());

    await act(async () => {
      emitting = true;
      room.emit({
        state: "connected",
        body: "# Deferred\n",
        mode: "read_write",
        epoch: 1,
        pendingUpdates: 0,
        participants: []
      });
      emitting = false;
      await Promise.resolve();
    });

    expect(onBody).toHaveBeenCalledWith("# Deferred\n");
  });

  it("aborts and destroys a stale room that resolves after navigation", async () => {
    let resolveRoom!: (room: ExperimentalHostedMarkdownRoom | null) => void;
    const pendingRoom = new Promise<ExperimentalHostedMarkdownRoom | null>((resolve) => {
      resolveRoom = resolve;
    });
    const open = vi.fn((options: Parameters<CollectionGateway["openExperimentalCollaboration"]>[0]) =>
      options.path === "Notes/a.md" ? pendingRoom : Promise.resolve(null));
    const gateway = { openExperimentalCollaboration: open } as unknown as CollectionGateway;
    const room = new FakeRoom();
    const view = render(<Probe gateway={gateway} path="Notes/a.md" onBody={() => undefined} onState={() => undefined} />);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));

    view.rerender(<Probe gateway={gateway} path="Notes/b.md" onBody={() => undefined} onState={() => undefined} />);
    resolveRoom(room);

    await waitFor(() => expect(room.destroy).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0]![0].signal?.aborted).toBe(true);
  });

  it("flushes pending updates before destroying a released room", async () => {
    const room = new FakeRoom({
      state: "connected",
      body: "# Pending\n",
      mode: "read_write",
      epoch: 2,
      pendingUpdates: 1,
      participants: []
    });
    const view = render(<Probe gateway={gatewayReturning(room)} path="Notes/live.md" onBody={() => undefined} onState={() => undefined} />);
    await waitFor(() => expect(room.subscribe).toHaveBeenCalled());

    view.unmount();

    await waitFor(() => expect(room.flush).toHaveBeenCalledTimes(1));
    expect(room.destroy).toHaveBeenCalledTimes(1);
  });
});

interface ProbeState {
  opening: boolean;
  binding?: ExperimentalEditorCollaboration;
}

function Probe({ gateway, path, onBody, onState }: {
  gateway: CollectionGateway;
  path: string;
  onBody(body: string): void;
  onState(state: ProbeState): void;
}) {
  const state = useExperimentalCollaboration({
    gateway,
    path,
    access: "read_write",
    onBody
  });
  useEffect(() => onState(state), [onState, state]);
  return null;
}

function gatewayReturning(room: ExperimentalHostedMarkdownRoom): CollectionGateway {
  return {
    openExperimentalCollaboration: vi.fn(async () => room)
  } as unknown as CollectionGateway;
}

class FakeRoom implements ExperimentalHostedMarkdownRoom {
  readonly doc = new Y.Doc();
  readonly body = this.doc.getText("body");
  readonly undoManager = new Y.UndoManager(this.body);
  private listeners = new Set<ExperimentalHostedMarkdownRoomListener>();
  private current: ExperimentalHostedMarkdownRoomSnapshot;

  readonly subscribe = vi.fn((listener: ExperimentalHostedMarkdownRoomListener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  });
  readonly setAwareness = vi.fn();
  readonly flush = vi.fn(async () => undefined);
  readonly close = vi.fn();
  readonly destroy = vi.fn(() => {
    this.undoManager.destroy();
    this.doc.destroy();
  });

  constructor(snapshot: ExperimentalHostedMarkdownRoomSnapshot = {
    state: "connecting",
    body: "",
    pendingUpdates: 0,
    participants: []
  }) {
    this.current = snapshot;
    if (snapshot.body) this.body.insert(0, snapshot.body);
  }

  get snapshot(): ExperimentalHostedMarkdownRoomSnapshot {
    return this.current;
  }

  emit(snapshot: ExperimentalHostedMarkdownRoomSnapshot): void {
    const body = this.body.toString();
    if (body !== snapshot.body) {
      this.doc.transact(() => {
        if (this.body.length) this.body.delete(0, this.body.length);
        if (snapshot.body) this.body.insert(0, snapshot.body);
      }, "test-remote");
    }
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
