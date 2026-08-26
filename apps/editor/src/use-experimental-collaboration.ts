import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExperimentalHostedMarkdownRoom,
  ExperimentalHostedMarkdownRoomSnapshot
} from "@mdbase-dev/connect-collaboration";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { CollectionGateway, NoteDocument } from "./model";
import { editableNote } from "./note";
import type { Draft, NoteSession, SaveState } from "./note-session";

const MAX_COLLABORATIVE_BODY_BYTES = 2_097_152;

export interface ExperimentalEditorCollaboration {
  readonly room: ExperimentalHostedMarkdownRoom;
  readonly extension: Extension;
  readonly snapshot: ExperimentalHostedMarkdownRoomSnapshot;
}

interface ExperimentalCollaborationState {
  readonly path?: string;
  readonly expected: boolean;
  readonly opening: boolean;
  readonly snapshot?: ExperimentalHostedMarkdownRoomSnapshot;
  readonly binding?: ExperimentalEditorCollaboration;
  readonly problem?: string;
}

interface ExperimentalCollaborationOptions {
  gateway: CollectionGateway;
  path?: string;
  access?: "read_only" | "read_write";
  onBody(body: string): void;
}

const disabledState: ExperimentalCollaborationState = {
  expected: false,
  opening: false
};

export function useEditorCollaboration(options: {
  gateway: CollectionGateway;
  path?: string;
  access?: "read_only" | "read_write";
  session?: NoteSession;
  types: CollectionTypeDescriptor[];
  setDocument(document: NoteDocument): void;
  setDraft(draft: Draft): void;
  setSaveState(state: SaveState): void;
  touchSession(session: NoteSession): void;
  restrictControls(): void;
}) {
  const { session, path, types, setDocument, setDraft, setSaveState,
    touchSession, restrictControls } = options;
  const adoptDocument = useCallback((target: NoteSession, document: NoteDocument) => {
    const draft = editableNote(document, types);
    target.document = document;
    target.draft = draft;
    target.persistedDraft = structuredClone(draft);
    target.saveState = "saved";
    target.error = undefined;
    if (target === session) {
      setDocument(document);
      setDraft(draft);
      setSaveState("saved");
    }
    touchSession(target);
  }, [session, setDocument, setDraft, setSaveState, touchSession, types]);
  const applyBody = useCallback((body: string) => {
    if (!session || session.deleted || session.document.path !== path) return;
    const document = { ...session.document, body };
    const draft = editableNote(document, types);
    if (session.document.body === body
        && session.draft.title === draft.title
        && session.draft.body === draft.body) return;
    adoptDocument(session, document);
  }, [adoptDocument, path, session, types]);
  const collaboration = useExperimentalCollaboration({
    gateway: options.gateway,
    path,
    access: options.access,
    onBody: applyBody
  });
  const authorizedWritable = !collaboration.expected || (
    collaboration.binding?.snapshot.state === "connected"
    && collaboration.binding.snapshot.mode === "read_write"
  );
  const writable = authorizedWritable
    && (!collaboration.expected || !session?.activity);
  useEffect(() => {
    if (!authorizedWritable) restrictControls();
  }, [authorizedWritable, restrictControls]);
  const flushAndRefresh = useCallback(async (target: NoteSession, requireWritable = false) => {
    if (!collaboration.expected || target !== session) return;
    if (requireWritable) collaboration.assertWritable();
    await collaboration.flush();
    if (requireWritable) collaboration.assertWritable();
    const pathBeforeRead = target.document.path;
    const latest = await options.gateway.read(pathBeforeRead);
    if (target.deleted || target !== session || target.document.path !== pathBeforeRead) {
      throw new Error("collaboration_session_changed");
    }
    if (requireWritable) collaboration.assertWritable();
    adoptDocument(target, latest);
  }, [adoptDocument, collaboration, options.gateway, session]);
  return {
    ...collaboration,
    authorizedWritable,
    writable,
    indicator: liveCollaborationIndicator(collaboration),
    flushAndRefresh
  };
}

export function liveCollaborationIndicator(
  collaboration: ReturnType<typeof useExperimentalCollaboration>
): { state: SaveState; detail: string } | undefined {
  if (!collaboration.expected) return undefined;
  const snapshot = collaboration.snapshot;
  if (collaboration.problem || snapshot?.state === "unavailable" || snapshot?.state === "closed") {
    return { state: "conflict", detail: "Live editing unavailable" };
  }
  if (!snapshot || collaboration.opening || !collaboration.binding
      || snapshot.state === "connecting" || snapshot.state === "synchronizing") {
    return { state: "saving", detail: "Connecting live editing" };
  }
  if (snapshot.state === "reconnecting") {
    return snapshot.pendingUpdates > 0
      ? { state: "waiting", detail: "Offline · live changes pending" }
      : { state: "saving", detail: "Reconnecting live editing" };
  }
  if (snapshot.pendingUpdates > 0) return { state: "saving", detail: "Saving live changes" };
  if (snapshot.mode === "read_only") return { state: "saved", detail: "Live · Read only" };
  return { state: "saved", detail: "Live" };
}

export function useExperimentalCollaboration({
  gateway,
  path,
  access,
  onBody
}: ExperimentalCollaborationOptions): ExperimentalCollaborationState & {
  flush(): Promise<void>;
  assertWritable(): void;
  pendingUpdates: number;
} {
  const [state, setState] = useState<ExperimentalCollaborationState>(disabledState);
  const expected = __MDBASE_EDITOR_EXPERIMENTAL_HOSTED_COLLABORATION__
    && Boolean(path && access);
  const roomRef = useRef<ExperimentalHostedMarkdownRoom | undefined>(undefined);
  const onBodyRef = useRef(onBody);
  onBodyRef.current = onBody;

  useEffect(() => {
    if (!expected || !path || !access) {
      roomRef.current = undefined;
      setState(disabledState);
      return;
    }

    let disposed = false;
    let room: ExperimentalHostedMarkdownRoom | undefined;
    let unsubscribe: (() => void) | undefined;
    let bindingStarted = false;
    let synchronized = false;
    const controller = new AbortController();
    setState({ path, expected: true, opening: true });

    const publish = (snapshot: ExperimentalHostedMarkdownRoomSnapshot) => {
      queueMicrotask(() => {
        if (disposed) return;
        if (snapshot.state === "connected") synchronized = true;
        if (synchronized && (snapshot.state === "connected" || snapshot.state === "reconnecting")) {
          onBodyRef.current(snapshot.body);
        }
        const terminal = snapshot.state === "unavailable" || snapshot.state === "closed";
        setState((current) => ({
          path,
          expected: true,
          opening: false,
          snapshot,
          ...(current.binding && !terminal ? { binding: { ...current.binding, snapshot } } : {}),
          ...(snapshot.problem ? { problem: snapshot.problem.message } : {})
        }));
        if (snapshot.state !== "connected" || bindingStarted || !room) return;
        bindingStarted = true;
        void import("y-codemirror.next").then(({ yCollab, yUndoManagerKeymap }) => {
          const activeRoom = room;
          if (disposed || !activeRoom
              || (activeRoom.snapshot.state !== "connected" && activeRoom.snapshot.state !== "reconnecting")) return;
          const extension: Extension = [
            yCollab(activeRoom.body, null, { undoManager: activeRoom.undoManager }),
            Prec.highest(keymap.of(yUndoManagerKeymap))
          ];
          setState((current) => ({
            ...current,
            binding: { room: activeRoom, extension, snapshot: current.snapshot ?? snapshot }
          }));
        }).catch(() => {
          if (!disposed) setState((current) => ({
            ...current,
            problem: "The collaborative editor could not be loaded."
          }));
        });
      });
    };

    void gateway.openExperimentalCollaboration({
      path,
      maxBodyBytes: MAX_COLLABORATIVE_BODY_BYTES,
      signal: controller.signal
    }).then((opened) => {
      if (disposed) {
        opened?.destroy();
        return;
      }
      if (!opened) {
        setState({
          path,
          expected: true,
          opening: false,
          problem: "Hosted collaboration is unavailable for this connection."
        });
        return;
      }
      room = opened;
      roomRef.current = opened;
      publish(opened.snapshot);
      unsubscribe = opened.subscribe(publish);
    }).catch((error: unknown) => {
      if (disposed || controller.signal.aborted) return;
      setState({
        path,
        expected: true,
        opening: false,
        problem: error instanceof Error
          ? error.message
          : "Hosted collaboration could not be opened."
      });
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      if (roomRef.current === room) roomRef.current = undefined;
      if (!room) {
        controller.abort();
        return;
      }
      const closingRoom = room;
      const destroy = () => closingRoom.destroy();
      if (closingRoom.snapshot.pendingUpdates === 0) destroy();
      else void closingRoom.flush().then(destroy, destroy);
    };
  }, [access, expected, gateway, path]);

  const flush = useCallback(async () => {
    const room = roomRef.current;
    if (!room || room.snapshot.pendingUpdates === 0) return;
    await room.flush();
  }, []);
  const assertWritable = useCallback(() => {
    const snapshot = roomRef.current?.snapshot;
    if (!snapshot || snapshot.state !== "connected" || snapshot.mode !== "read_write") {
      throw new Error("collaboration_not_writable");
    }
  }, []);

  const current = state.path === path
    ? state
    : { path, expected, opening: expected };
  return {
    ...current,
    expected,
    flush,
    assertWritable,
    pendingUpdates: current.snapshot?.pendingUpdates ?? 0
  };
}
