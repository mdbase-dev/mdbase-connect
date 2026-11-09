import { StateEffect, StateField, type EditorState } from "@codemirror/state";

/** Embeds as parsed from one version of a note body. */
export interface ParsedEmbeds<T> {
  source: string;
  references: readonly T[];
}

interface Positioned { from: number; to: number }

/**
 * Embed positions owned by the editor. A parse runs after the text it read, so while someone types
 * it is a keystroke or more behind, and its positions would put embeds on the wrong lines. Embeds
 * already shown are mapped through each edit; a parse replaces them only when it read the editor's
 * current text. One field per kind of embed, made once, so reconfiguring the presentation keeps it.
 */
export function embedPositions<T extends Positioned>() {
  const parsed = StateEffect.define<ParsedEmbeds<T>>();
  const field = StateField.define<readonly T[]>({
    create: () => [],
    update(references, transaction) {
      for (const effect of transaction.effects) {
        const current = effect.is(parsed) ? currentReferences(effect.value, transaction.state) : null;
        if (current) return current;
      }
      if (!transaction.docChanged) return references;
      return references.flatMap((reference) => {
        const from = transaction.changes.mapPos(reference.from, 1);
        const to = transaction.changes.mapPos(reference.to, -1);
        return to > from ? [{ ...reference, from, to }] : [];
      });
    }
  });
  return { parsed, field };
}

/** A parse's references in the editor's positions, or null when it read other text. */
function currentReferences<T extends Positioned>({ source, references }: ParsedEmbeds<T>, state: EditorState): readonly T[] | null {
  const text = state.doc.toString();
  if (!source.includes("\r")) return source === text ? references : null;
  // The editor holds a CRLF note with one-character line breaks.
  if (source.replace(/\r\n/g, "\n") !== text) return null;
  const breaks = [...source.matchAll(/\r\n/g)].map((match) => match.index);
  const shift = (position: number) => position - breaks.filter((index) => index < position).length;
  return references.map((reference) => ({ ...reference, from: shift(reference.from), to: shift(reference.to) }));
}
