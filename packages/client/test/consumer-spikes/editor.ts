import {
  type JsonObject,
  type MdbaseConnection
} from "../../api-candidate/index.js";

interface NoteFrontmatter extends JsonObject {
  title?: string;
  type?: string;
}

export async function editorSpike(connection: MdbaseConnection<NoteFrontmatter>): Promise<void> {
  await connection.describe({ timeoutMs: 8_000 });
  await connection.query({ types: ["note"] }, { timeoutMs: 8_000 });
  await connection.queryAll({ types: ["note"] }, { timeoutMs: null });
  await connection.read({ path: "Notes/one.md" }, { timeoutMs: 8_000 });
  await connection.create({ path: "Notes/two.md", frontmatter: { title: "Two" }, body: "" });
  await connection.update({ path: "Notes/two.md", patch: { title: "Changed" }, body: "" });
  const preview = await connection.preflightRename({ from: "Notes/two.md", to: "Notes/three.md" });
  if (preview.ok) await connection.rename({ from: "Notes/two.md", to: "Notes/three.md" });
  await connection.preflightDelete({ path: "Notes/three.md" });
  await connection.delete({ path: "Notes/three.md" });
  await connection.readType({ name: "note" });
  await connection.createType({ path: "types/note.yaml", document: "name: note\n" });
  await connection.updateType({ name: "note", document: "name: note\n", if_revision: "sha256:old" });
  await connection.assessTypePack({
    provision: {
      manifest: { kind: "mdbase.type-pack", id: "notes", name: "Notes", version: "1.0.0", resources: [] },
      resources: [],
      provides: []
    },
    installed_by: "dev.mdbase.editor"
  });
  await connection.listViews();
  await connection.createViewSource({ name: "all", document: "name: all\n" });
  const opened = await connection.watch({ pollIntervalMs: 1_500 }, { timeoutMs: 10_000 });
  if (opened.ok) {
    opened.value.subscribe(() => undefined);
    opened.value.close();
  }
}
