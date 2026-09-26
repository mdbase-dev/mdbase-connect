// Mirrors an mdbase.dev SDK documentation example; keep it compiling.
import {
  MdbaseBrowserSelection,
  MdbaseConnect,
  type JsonObject
} from "../../../api-candidate/index.js";

export interface Workout extends JsonObject {
  title: string;
  completed?: boolean;
}

const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(location.hostname);

export const mdbase = new MdbaseConnect<Workout>({
  serverUrl: loopback ? "http://127.0.0.1:8787" : "https://connect.mdbase.dev",
  manifest: new URL("/.well-known/mdbase-app.json", location.origin).href,
  redirectUri: new URL("/auth/mdbase/callback", location.origin).href
});

// One session owns collection selection, authorization and a reactive snapshot.
export const session = mdbase.application({
  selection: new MdbaseBrowserSelection()
});
