import "../../src/styles.css";
import "@mdbase-dev/ui/tokens.css";
import "@mdbase-dev/ui/controls.css";
import "@mdbase-dev/ui/screens.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "@mdbase-dev/i18n/react";
import { createMdbase, mdbaseError } from "@mdbase-dev/sdk";
import { MemoryReplica, createTestApp } from "@mdbase-dev/sdk/testing";
import { connect } from "@mdbase-dev/sdk/thin-client";
import { DirectEditor } from "../../direct/DirectEditor";
import { SdkEditorRoot } from "../../src/SdkEditorRoot";
import { editorLocaleRuntime } from "../../src/i18n/runtime";
import type { NoteVersion } from "../../src/model";
import manifest from "../../public/.well-known/mdbase-app.json";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario");
const root = createRoot(document.getElementById("root")!);
const life = new AbortController();
const allow = async () => true;

function render(content: React.ReactNode) {
  root.render(<LocaleProvider runtime={editorLocaleRuntime}>{content}</LocaleProvider>);
}

async function start() {
  if (scenario === "offline-replica") {
    // Keep the SDK test replica in the parent while the iframe reloads Editor.
    const fixture = await createTestApp({ collections: [{ name: "Offline notes",
      records: [{ path: "note.md", body: "Base text" }] }] });
    Object.assign(window, { offlineFixture: fixture });
    render(<iframe title="Editor" style={{ width: "100%", height: "90vh" }}
      src="?scenario=offline-editor" />);
    return;
  }
  if (scenario === "offline-editor") {
    const parent = window.parent as Window & { offlineFixture: Awaited<ReturnType<typeof createTestApp>> };
    render(<SdkEditorRoot sdk={parent.offlineFixture.mdbase} />);
    return;
  }
  if (scenario === "pairing") {
    await import("../../direct/style.css");
    render(<main><DirectEditor allowed={allow} signal={life.signal} /></main>);
    return;
  }
  if (scenario === "tabs") {
    const origin = location.origin;
    const sdk = createMdbase({ id: manifest.id, name: manifest.name, origin, environment: "production",
      manifest: { ...manifest, homepage: origin, redirect_uris: [origin + "/"] }
    }, { privateCollections: true, unsynced: true });
    render(<SdkEditorRoot sdk={sdk} />);
    return;
  }
  const waitingToOpen = scenario === "private-wait";
  const fixture = await createTestApp({ collections: [{ name: "Test notes", contracts: [] }],
    phase: waitingToOpen ? { problem: "device_not_serving" } : "ready" });
  const snapshot = fixture.mdbase.getSnapshot();
  const connection = snapshot.selectedCollectionId && fixture.mdbase.connection(snapshot.selectedCollectionId);
  if (!connection || snapshot.signIn?.state !== "paired" || !snapshot.signIn.accountId) {
    throw Error("Expected a paired fixture with a selected collection");
  }
  const account = snapshot.signIn.accountId;
  const device = snapshot.signIn.deviceId;
  const typesFolder = params.get("typesFolder");
  const replica = new MemoryReplica({ collection: connection.id, settings: typesFolder ? { types_folder: typesFolder } : {} });
  replica.seed({ path: "notes/review.md", frontmatter: { title: "A review", type: "book", rating: 3 }, types: ["book"], body: "A review on disk." });
  replica.seedType("book", { schema: { value: { type: "object", properties: {
    rating: { type: "integer", minimum: 1, maximum: 5 }
  } } } });
  const transport = replica.connector();
  let serving = true;
  const client = await connect({
    app: { name: "Editor regression fixture", version: "test" },
    reconnect: { minDelayMs: 50, maxDelayMs: 100 },
    connector: {
      description: transport.description,
      open: async (hello, signal) => {
        if (!serving) throw mdbaseError("unavailable", "Fixture device offline", "no_device_online");
        return transport.open(hello, signal);
      }
    }
  });
  fixture.controls.setConnections([{ ...connection, records: client, files: client.files, isCurrent: () => true }]);
  const now = Date.now();
  const common = { path: "notes/review.md", kind: "edited" as const, author: { account, device } };
  const versions: NoteVersion[] = [
    { ...common, time: now, seq: 20, source: "api", deviceKind: "app_runtime" },
    { ...common, time: now - 15 * 60_000, seq: 19, source: "api", deviceKind: "app_runtime", author: { account, device: crypto.randomUUID() } },
    { ...common, time: now - 30 * 60_000, seq: 18, source: "external", deviceKind: "cli" }
  ];
  client.history.list = async () => ({ versions, from: 1, fromTime: now - 90 * 60_000 });
  if (waitingToOpen || scenario === "private-reconnect") {
    const collections = snapshot.collections.map((entry) => ({ ...entry, kind: "private" as const, availability: { state: "available" as const } }));
    fixture.controls.publishSnapshot({ ...fixture.mdbase.getSnapshot(), collections });
    function Controls() {
      const [active, setActive] = useState(!waitingToOpen);
      return <button onClick={() => {
        setActive(!active);
        if (waitingToOpen) fixture.set("ready");
        else {
          serving = !active;
          if (!serving) replica.dropConnections();
        }
      }}>{active ? "Stop serving" : "Resume serving"}</button>;
    }
    render(<><Controls /><SdkEditorRoot sdk={fixture.mdbase} /></>);
    return;
  }
  render(<SdkEditorRoot sdk={fixture.mdbase} />);
}

void start();
