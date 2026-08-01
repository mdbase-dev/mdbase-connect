import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { DirectoryMirror } from "./directory-mirror.js";
import type { SyncTransport } from "./sync-types.js";
import type { DirectoryMirrorOptions } from "./mirror-state.js";

export class WritableDirectoryMirror<Frontmatter extends JsonObject = JsonObject>
  extends DirectoryMirror<Frontmatter> {
  constructor(
    replicaId: string,
    transport: SyncTransport<Frontmatter>,
    options: DirectoryMirrorOptions
  ) {
    super(replicaId, transport, options, "read_write");
  }
}
