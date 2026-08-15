import { syntaxTree } from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { resolveFileReference } from "./file-reference-resolution";
import { resolveLinkSuggestionMatches, type LinkSuggestion } from "./links";
import { markdownReferences } from "./markdown-references";
import { markdownFragment } from "./markdown-fragments";
import type { CollectionFile, NoteSummary } from "./model";

export function referenceDiagnostics(
  suggestions: () => LinkSuggestion[],
  files: () => CollectionFile[],
  notes: () => NoteSummary[],
  currentPath: () => string | undefined
): Extension {
  return linter((view) => diagnosticsForReferences(
    view,
    suggestions(),
    files(),
    notes(),
    currentPath()
  ), { delay: 500 });
}

export function diagnosticsForReferences(
  view: EditorView,
  suggestions: LinkSuggestion[],
  files: CollectionFile[],
  notes: NoteSummary[],
  sourcePath?: string
): readonly Diagnostic[] {
  const source = view.state.doc.toString();
  return markdownReferences(source, syntaxTree(view.state)).flatMap((reference): Diagnostic[] => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference.target)) return [];
    if (!reference.target && reference.anchor) {
      return markdownFragment(source, reference.anchor) === undefined
        ? [diagnostic(reference.from, reference.to, `This note has no “${reference.anchor}” section or block.`)]
        : [];
    }
    const noteMatches = resolveLinkSuggestionMatches(reference.target, suggestions, sourcePath, reference.format);
    if (noteMatches.length > 1) {
      return [diagnostic(reference.from, reference.to, `${noteMatches.length} notes match “${reference.target}”. Use a path to disambiguate it.`)];
    }
    const note = noteMatches[0];
    const file = resolveFileReference(reference.target, reference.format, files, sourcePath);
    if (!note && !file) {
      return [diagnostic(reference.from, reference.to, `No note or file matches “${reference.target}”.`)];
    }
    if (note && reference.anchor) {
      const body = note.path === sourcePath
        ? source
        : notes.find((candidate) => candidate.path === note.path)?.body;
      if (body !== undefined && markdownFragment(body, reference.anchor) === undefined) {
        return [diagnostic(reference.from, reference.to, `“${note.title}” has no “${reference.anchor}” section or block.`)];
      }
    }
    return [];
  });
}

function diagnostic(from: number, to: number, message: string): Diagnostic {
  return { from, to, severity: "warning", message, source: "mdbase" };
}
