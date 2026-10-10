import { relative, sep, basename } from "node:path";
export function validateEnvelope(status, fixture) {
  if (status.environment !== "lab" || status.identity !== "verified"
    || status.connect_origin !== "https://connect-lab.mdbase.dev" || status.daemon?.running !== true) throw new Error("lab_preflight");
  if (fixture.environment !== "lab" || fixture.labOwnsFixture !== true || fixture.labOwnsProfile !== true
    || !fixture.label?.startsWith("[test]") || fixture.collectionRegistered !== true || fixture.nativeCollectionReady !== true
    || !/^[0-9a-f-]{36}$/.test(fixture.collection) || typeof fixture.stateDir !== "string" || !fixture.stateDir) throw new Error("fixture_scope");
}
export function validatePhysicalRoot(parent, root, base) {
  const rel = relative(parent, root);
  if (basename(parent) !== "obsidian-ui-fixtures" || !rel.startsWith("[test]") || rel.startsWith(`..${sep}`)
    || rel.startsWith(sep) || rel.split(sep).length !== 2 || basename(root) !== "collection") throw new Error("fixture_root");
  if (base !== root) throw new Error("wrong_vault");
}
