// Complete inventory DATA only. A digest, including one computed by this helper,
// is never source/fence/admission authority: the CP must independently reread it.
import { createHash } from "node:crypto";
import { migrationUuid } from "../../hosted-provider-replies.js";
import { archiveBindingSchema, millisecondTime } from "./migration-archive-profile.js";
import { migrationMembershipDigest, RolloutRefused, type ArchiveBinding } from "./migration-rollout.js";

export interface PrearchiveCapture {
  schema: "mdbase-migration-capture/1";
  binding: ArchiveBinding;
  frozen_at: string | null;
  observed_at: string;
  members: readonly {
    view: { account_id: string; cohort: string | null; hosted_collections: readonly string[]; terminal_excluded: boolean };
    terminal_excluded_at: string | null;
    export_collections: readonly string[];
  }[];
}

const refuse = (): never => { throw new RolloutRefused("migration_prearchive_inventory_changed", "No complete original pre-archive inventory."); };
function require(condition: boolean): asserts condition { if (!condition) refuse(); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  require(encoded !== undefined);
  // Python ensure_ascii also escapes DEL; astral characters are UTF-16 pairs.
  return encoded.replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function prearchiveInventory(capture: PrearchiveCapture) {
  require(capture.schema === "mdbase-migration-capture/1" && archiveBindingSchema.safeParse(capture.binding).success);
  require(capture.members.length > 0 && capture.members.length <= 850);
  require(Buffer.byteLength(JSON.stringify(capture), "utf8") <= 1024 * 1024);
  require(millisecondTime.safeParse(capture.observed_at).success);
  require(capture.frozen_at === null || millisecondTime.safeParse(capture.frozen_at).success);
  const accounts = new Set<string>(), collections = new Set<string>();
  const selected: { account_id: string; collection_id: string }[] = [];
  let previousAccount = "";
  const members = capture.members.map(member => {
    const { view } = member, account = view.account_id;
    require(migrationUuid.safeParse(account).success && account > previousAccount && !accounts.has(account));
    require(view.cohort === capture.binding.batch_id && typeof view.terminal_excluded === "boolean");
    require(view.terminal_excluded === (member.terminal_excluded_at !== null));
    require(member.terminal_excluded_at === null || millisecondTime.safeParse(member.terminal_excluded_at).success);
    accounts.add(account); previousAccount = account;
    let previousCollection = "";
    for (const collection of view.hosted_collections) {
      require(migrationUuid.safeParse(collection).success && collection > previousCollection && !collections.has(collection));
      collections.add(collection); previousCollection = collection;
      require(collections.size <= 1000);
    }
    const expected = view.terminal_excluded ? [] : [...view.hosted_collections];
    require(member.export_collections.length === expected.length && expected.every((id, index) => member.export_collections[index] === id));
    for (const collection_id of expected) selected.push({ account_id: account, collection_id });
    return { account_id: account, hosted_collections: [...view.hosted_collections],
      terminal_excluded_at: member.terminal_excluded_at, export_collections: expected };
  });
  const membership = members.map(member => [member.account_id, member.hosted_collections] as const);
  require(migrationMembershipDigest(membership) === capture.binding.membership_digest);
  const bytes = Buffer.from(canonical({ binding: capture.binding, members }), "ascii");
  const inventory_sha256 = createHash("sha256").update("mdbase-prearchive-inventory/v1\n").update(bytes).digest("hex");
  return { inventory_sha256, bytes, selected };
}
