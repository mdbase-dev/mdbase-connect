import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { QuickCreate } from "@mdbase-dev/ui/quick-create";
import { collectionDisplayField } from "./field-reference";
import { PlusIcon } from "./icons";
import type { PropertyLinks, RecordLinking } from "./LinkPropertyEditor";
import { changedNewNote, newNoteBlocker, newNoteForm, type NewNote } from "./new-note";
import { typeNameInSentence } from "./note";
import { recordLinkProperties } from "./record-links";
import { StructuredPropertiesEditor } from "./StructuredPropertiesEditor";
import { TypeIcon } from "./TypeIcon";

/**
 * The topmost open modal `<dialog>`, if one is showing. A modal dialog makes everything outside
 * its subtree inert—even a top-layer popover—so a quick-create form opened from the narrow
 * properties overlay must mount inside that dialog. Remove once Editor updates past
 * `@mdbase-dev/ui` 0.1.35, where `QuickCreate` portals itself.
 */
function activeModalDialog(): HTMLDialogElement | null {
  if (typeof document === "undefined") return null;
  try {
    const modal = document.querySelectorAll<HTMLDialogElement>("dialog:modal");
    if (modal.length) return modal[modal.length - 1]!;
  } catch {
    // Fall through when :modal is unsupported.
  }
  const open = document.querySelectorAll<HTMLDialogElement>('dialog[open][aria-modal="true"]');
  return open.length ? open[open.length - 1]! : null;
}

/**
 * The short form for a record made while linking to it, when its type asks
 * for more than a name: the name, then only what the type requires, in the
 * shared quick-create popover beside the place the link is being written.
 */
export function QuickCreateRecord({ note: started, types, linking, anchor, onCreate, onClose }: {
  note: NewNote;
  types: CollectionTypeDescriptor[];
  /** For required properties that are links themselves. */
  linking?: RecordLinking;
  /** Where the link is being written; nothing once that place has gone. */
  anchor: () => DOMRect | undefined;
  onCreate: (note: NewNote) => void;
  /** `refocus` is false when a press elsewhere has already moved the focus. */
  onClose: (refocus: boolean) => void;
}) {
  useLingui();
  const [note, setNote] = useState(started);
  const form = useMemo(() => newNoteForm(note.type, types), [note.type, types, i18n.locale]);
  const links = useMemo<PropertyLinks | undefined>(() => linking && { ...linking, properties: recordLinkProperties(note.type ? [note.type] : [], types) }, [linking, note.type, types]);
  const typeLabel = typeNameInSentence(note.type ?? "");
  const popover = <QuickCreate
    className="quick-create"
    title={t`New ${typeLabel}`}
    icon={<TypeIcon name={collectionDisplayField(form.type, "icon")} fallback={<PlusIcon aria-hidden="true" />} />}
    name={note.title}
    nameLabel={form.titleLabel ?? t`Name`}
    onNameChange={(title) => setNote((current) => changedNewNote(current, { title }))}
    anchor={anchor}
    submitLabel={t`Create and link`}
    blocker={newNoteBlocker(note, form)}
    onSubmit={() => onCreate(note)}
    onClose={onClose}
  >
    <StructuredPropertiesEditor value={note.properties} contract={{ properties: form.properties, required: form.required }}
      propertyNames={form.required} links={links} initializeRequired allowAdd={false} allowCustom={false} emptyMessage=""
      onChange={(properties) => setNote((current) => changedNewNote(current, { properties }))}
      onValidityChange={(propertiesValid) => setNote((current) => changedNewNote(current, { propertiesValid }))} />
  </QuickCreate>;
  const host = activeModalDialog();
  return host ? createPortal(popover, host) : popover;
}
