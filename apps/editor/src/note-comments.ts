// The collection's comment records, read and written through the types that
// implement mdbase.comment. The contract's own reading (threads, anchors,
// fields) is shared in @mdbase-dev/ui/comments; this maps it onto the
// collection's field names and the Editor's index.
import type { CollectionContractImplementationDescriptor, CollectionDescription, JsonObject, PeopleDirectory } from "@mdbase-dev/connect";
import { COMMENT_CONTRACT, commentFromRecord, personKey, recordLink, type CommentFields, type CommentPeople, type CommentRecord } from "@mdbase-dev/ui/comments";
import { readFieldReference, writeFieldReference } from "./field-reference";
import type { NoteSummary } from "./model";

export function commentImplementations(description: CollectionDescription | undefined): CollectionContractImplementationDescriptor[] {
  return description?.contracts.find((contract) => contract.id === COMMENT_CONTRACT.id && contract.version === COMMENT_CONTRACT.version)?.implementations ?? [];
}

/** A contract field's place in a record of this type, however the mapping names it. */
function reference(implementation: CollectionContractImplementationDescriptor, field: string): string | undefined {
  return implementation.fields[field] ?? implementation.fields[`/${field}`];
}

/** A record's frontmatter under the contract's names; unmapped fields are not the contract's. */
export function contractFields(frontmatter: JsonObject, implementation: CollectionContractImplementationDescriptor): CommentFields {
  const fields: CommentFields = {};
  for (const canonical of Object.keys(implementation.fields)) {
    const name = canonical.replace(/^\//, "");
    if (name.includes("/")) continue;
    const value = readFieldReference(frontmatter, implementation.fields[canonical]);
    if (value !== undefined) fields[name] = value;
  }
  return fields;
}

/** Contract fields under the type's own names, as frontmatter to create or patch with. */
export function localFields(fields: CommentFields, implementation: CollectionContractImplementationDescriptor, base: JsonObject = {}): JsonObject {
  let frontmatter: JsonObject = {};
  for (const [name, value] of Object.entries(fields)) {
    const target = reference(implementation, name) ?? name;
    // A patch replaces whole top-level keys, so a nested mapping starts from what is stored.
    const top = target.startsWith("/") ? target.slice(1).split("/")[0]! : target.split(".")[0]!;
    if (!(top in frontmatter) && top in base) frontmatter = { ...frontmatter, [top]: structuredClone(base[top]!) };
    frontmatter = writeFieldReference(frontmatter, target, value);
  }
  return frontmatter;
}

/** The type a note is a comment through, when it is one. */
export function commentImplementationOf(note: Pick<NoteSummary, "types">, implementations: readonly CollectionContractImplementationDescriptor[]) {
  return implementations.find((implementation) => note.types.includes(implementation.typeName));
}

/**
 * Every comment in the collection, from the index. A body the index has not
 * read yet comes from `bodies`; until then the comment shows without text.
 */
export function collectionComments(
  notes: readonly NoteSummary[],
  implementations: readonly CollectionContractImplementationDescriptor[],
  bodies: ReadonlyMap<string, string>,
): CommentRecord[] {
  if (!implementations.length) return [];
  const comments: CommentRecord[] = [];
  for (const note of notes) {
    const implementation = commentImplementationOf(note, implementations);
    if (!implementation) continue;
    const comment = commentFromRecord(note.path, contractFields(note.effectiveFrontmatter, implementation), note.body ?? bodies.get(note.path) ?? "");
    if (comment) comments.push(comment);
  }
  return comments;
}

/** Person names for author links, and how the signed-in account resolves. */
export function commentPeople({ me, people }: Pick<PeopleDirectory, "me" | "people">): CommentPeople {
  const names = new Map(people.map((person) => [personKey(person.path), person.name]));
  switch (me.status) {
    case "linked":
      return { names, me: { link: recordLink(me.person.path), name: me.person.name }, signing: { kind: "linked" } };
    case "unlinked":
      return { names, signing: { kind: "unlinked" } };
    // Never pick one of several claimants, or trust an invalid one.
    case "ambiguous":
    case "invalid":
      return { names, signing: { kind: "conflict", paths: me.paths } };
  }
}

/**
 * An offset in the editor's text (always `\n` line breaks) as an offset in
 * the stored body, which may keep `\r\n`.
 */
export function storedOffset(body: string, editorOffset: number): number {
  if (!body.includes("\r\n")) return editorOffset;
  let stored = 0;
  for (let seen = 0; seen < editorOffset && stored < body.length; seen++) stored += body.startsWith("\r\n", stored) ? 2 : 1;
  return stored;
}
