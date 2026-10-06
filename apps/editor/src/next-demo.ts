import { MemoryReplica } from "@mdbase-dev/sdk/testing";
import type { NextGatewaySource } from "./next-gateway";

/** Enough generated notes that the first live window (200) doesn't hold them all. */
const NEXT_DEMO_GENERATED = 320;

/**
 * `?backend=next-demo`: an in-memory replica speaking the real client protocol,
 * so the editor runs on the mdbase-next SDK without any server. Writes stay
 * pending for `confirmDelayMs`, which makes pending → confirmed visible.
 */
export function nextDemoSource(options: { confirmDelayMs?: number | null; generated?: number } = {}): NextGatewaySource & { replica: MemoryReplica } {
  const replica = new MemoryReplica({ confirmDelayMs: options.confirmDelayMs ?? 1_500 });
  seedNextDemo(replica, options.generated ?? NEXT_DEMO_GENERATED);
  return {
    replica,
    open: async () => ({ connector: replica.connector(), displayName: "mdbase-next demo" })
  };
}

function seedNextDemo(replica: MemoryReplica, generated: number): void {
  replica.seed({
    path: "Welcome.md",
    types: ["note"],
    frontmatter: { title: "Welcome to mdbase-next", tags: ["demo"] },
    body: [
      "This editor is running on `@mdbase-dev/sdk` against an in-memory replica.",
      "",
      "- The note list is a live query window of 200 notes, without bodies. Scroll to the end to widen it.",
      "- A note's body is read when you open it.",
      "- Edits are field-level intents. They show as pending until the replica confirms them.",
      ""
    ].join("\n")
  });
  replica.seed({
    path: "Projects/Replica port.md",
    types: ["project"],
    frontmatter: { title: "Replica port", status: "active", owner: "editor" },
    body: "Port the editor's data layer to the replica client API.\n"
  });
  replica.seed({
    path: "Projects/Search.md",
    types: ["project"],
    frontmatter: { title: "Full-text search", status: "blocked" },
    body: "Needs a replica-side text index; the editor no longer loads every body.\n"
  });
  for (let index = 1; index <= generated; index += 1) {
    const day = String(index).padStart(3, "0");
    replica.seed({
      path: `Log/Entry ${day}.md`,
      types: ["log"],
      frontmatter: { title: `Log entry ${day}`, sequence: index },
      body: `Entry ${day}.\n`
    });
  }
}
