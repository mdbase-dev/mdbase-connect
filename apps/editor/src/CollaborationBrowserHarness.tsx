import { EditorState } from "@codemirror/state";
import { keymap, EditorView } from "@codemirror/view";
import { validateCollaborationBody } from "@mdbase-dev/connect-collaboration";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

const INITIAL_BODY = "# Heading 👋\n\nCafé and e\u0301 stay distinct\n\nConcurrent edits live here.\n";

type Peer = "a" | "b";
type Packet = { from: Peer; update: Uint8Array };

export function CollaborationBrowserHarness() {
  const [online, setOnline] = useState(true);
  const onlineRef = useRef(true);
  const [admission, setAdmission] = useState("ready");
  const views = useRef<{ a?: EditorView; b?: EditorView }>({});
  const docs = useRef({ a: new Y.Doc(), b: new Y.Doc() });
  const packets = useRef<Packet[]>([]);
  const undoManagers = useRef<{ a?: Y.UndoManager; b?: Y.UndoManager }>({});

  useEffect(() => {
    const { a, b } = docs.current;
    const aText = a.getText("body");
    aText.insert(0, INITIAL_BODY);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "transport");

    const send = (from: Peer, update: Uint8Array, origin: unknown) => {
      if (origin === "transport") return;
      packets.current.push({ from, update: update.slice() });
    };
    a.on("update", (update, origin) => send("a", update, origin));
    b.on("update", (update, origin) => send("b", update, origin));

    const api = {
      initialBody: INITIAL_BODY,
      edit(peer: Peer, from: number, to: number, insert: string) {
        views.current[peer]?.dispatch({ changes: { from, to, insert }, userEvent: "input" });
      },
      remoteInsert(peer: Peer, index: number, text: string) {
        const target = docs.current[peer];
        target.transact(() => target.getText("body").insert(index, text), "remote-provider");
      },
      queuedPackets: () => packets.current.length,
      setOnline(value: boolean) {
        onlineRef.current = value;
        setOnline(value);
      },
      deliver(options: { reverse?: boolean; duplicate?: boolean } = {}) {
        if (!onlineRef.current) return false;
        const pending = options.reverse ? [...packets.current].reverse() : [...packets.current];
        packets.current = [];
        for (const packet of options.duplicate ? [...pending, ...pending] : pending) {
          const target = packet.from === "a" ? b : a;
          Y.applyUpdate(target, packet.update, "transport");
        }
        return true;
      },
      reconnectFromStateVectors() {
        const aToB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
        const bToA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
        Y.applyUpdate(b, aToB, "transport");
        Y.applyUpdate(a, bToA, "transport");
        packets.current = [];
      },
      admit(value: string) {
        try {
          validateCollaborationBody(value, 2 * 1024 * 1024);
          setAdmission("accepted");
          return true;
        } catch {
          setAdmission("rejected");
          return false;
        }
      },
      text(peer: Peer) {
        return docs.current[peer].getText("body").toString();
      },
      editorText(peer: Peer) {
        return views.current[peer]?.state.doc.toString() ?? "";
      },
      stopUndoCapturing(peer: Peer) {
        undoManagers.current[peer]?.stopCapturing();
      },
      undoDepth(peer: Peer) {
        return undoManagers.current[peer]?.undoStack.length ?? 0;
      }
    };
    Object.assign(window, { __collaborationHarness: api });

    return () => {
      delete (window as Window & { __collaborationHarness?: unknown }).__collaborationHarness;
      a.destroy();
      b.destroy();
    };
  }, []);

  return <main aria-label="Browser collaboration harness" style={{ padding: 24, fontFamily: "sans-serif" }}>
    <h1>Browser adapter smoke-test harness</h1>
    <p data-testid="scope-note">In-page transport only; no provider authorization, persistence, or WebSockets.</p>
    <p data-testid="connection-state" aria-live="polite">{online ? "connected" : "disconnected"}</p>
    <p data-testid="admission-state" aria-live="polite">profile admission: {admission}</p>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
      <HarnessEditor label="Editor A" peer="a" doc={docs.current.a} views={views} undoManagers={undoManagers} />
      <HarnessEditor label="Editor B" peer="b" doc={docs.current.b} views={views} undoManagers={undoManagers} />
    </div>
  </main>;
}

function HarnessEditor({ label, peer, doc, views, undoManagers }: { label: string; peer: Peer; doc: Y.Doc; views: MutableRefObject<{ a?: EditorView; b?: EditorView }>; undoManagers: MutableRefObject<{ a?: Y.UndoManager; b?: Y.UndoManager }> }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const text = doc.getText("body");
    const undoManager = new Y.UndoManager(text);
    undoManagers.current[peer] = undoManager;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true" }),
          keymap.of(yUndoManagerKeymap),
          yCollab(text, null, { undoManager })
        ]
      })
    });
    views.current[peer] = view;
    return () => { view.destroy(); delete views.current[peer]; };
  }, [doc, peer, undoManagers, views]);
  return <section aria-label={label}>
    <h2>{label}</h2>
    <div ref={host} className="code-editor" />
  </section>;
}

declare global {
  interface Window {
    __collaborationHarness?: {
      initialBody: string;
      edit: (peer: Peer, from: number, to: number, insert: string) => void;
      remoteInsert: (peer: Peer, index: number, text: string) => void;
      queuedPackets: () => number;
      setOnline: (value: boolean) => void;
      deliver: (options?: { reverse?: boolean; duplicate?: boolean }) => boolean;
      reconnectFromStateVectors: () => void;
      admit: (value: string) => boolean;
      text: (peer: Peer) => string;
      editorText: (peer: Peer) => string;
      stopUndoCapturing: (peer: Peer) => void;
      undoDepth: (peer: Peer) => number;
    };
  }
}
