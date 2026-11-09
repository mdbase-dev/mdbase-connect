import { t } from "@lingui/core/macro";
import { syntaxTree } from "@codemirror/language";
import { linter, type Action, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { internalLink, type LinkTargets } from "./collection-links";
import type { LinkSuggestion } from "./links";
import { markdownReferences, type MarkdownReference } from "./markdown-references";
import { markdownFragment } from "./markdown-fragments";
import type { NoteSummary } from "./model";
import { basename } from "./note";

/** Marks a link whose target matches no note or file. */
export const MISSING_REFERENCE_CLASS = "cm-reference-missing";

/** The most notes offered as replacements for one link. */
const LINK_FIXES = 3;

/** Checks every link against the collection's own resolution. Titles and
 * aliases are not link keys; a link written as one is offered a path instead. */
export function referenceDiagnostics(
  linkTargets: () => LinkTargets | undefined,
  suggestions: () => LinkSuggestion[],
  notes: () => NoteSummary[]
): Extension {
  return linter((view) => diagnosticsForReferences(view, linkTargets(), suggestions(), notes()), { delay: 500 });
}

export async function diagnosticsForReferences(
  view: EditorView,
  targets: LinkTargets | undefined,
  suggestions: LinkSuggestion[],
  notes: NoteSummary[]
): Promise<readonly Diagnostic[]> {
  if (!targets) return [];
  const source = view.state.doc.toString();
  const references = markdownReferences(source, syntaxTree(view.state))
    .filter((reference) => internalLink(reference.target));
  const raw = (reference: MarkdownReference) => source.slice(reference.from, reference.to);
  try {
    await targets.resolveAll(references.filter((reference) => reference.target).map(raw));
  } catch {
    // Unchecked rather than wrong; the next edit or collection change asks again.
    return [];
  }
  const byPath = new Map(suggestions.map((suggestion) => [suggestion.path, suggestion]));
  const fix = (reference: MarkdownReference, path: string): Action => {
    const title = byPath.get(path)?.title ?? basename(path);
    return {
      name: t`Link to ${title}`,
      apply(view, from, to) {
        view.dispatch({ changes: { from, to, insert: pathLink(reference, path) }, userEvent: "input" });
      }
    };
  };
  return references.flatMap((reference): Diagnostic[] => {
    if (!reference.target) {
      return reference.anchor && markdownFragment(source, reference.anchor) === undefined
        ? [diagnostic(reference.from, reference.to, t`This note has no “${reference.anchor}” section or block.`)]
        : [];
    }
    const target = targets.get(raw(reference));
    switch (target?.kind) {
      case "ambiguous": {
        const noteMatches = target.candidates;
        return [{
          ...diagnostic(reference.from, reference.to, t`${noteMatches.length} notes match “${reference.target}”. Use a path to disambiguate it.`),
          actions: reference.format === "wikilink" ? noteMatches.slice(0, LINK_FIXES).map((path) => fix(reference, path)) : []
        }];
      }
      case "missing":
      case "invalid":
        return [{
          ...diagnostic(reference.from, reference.to, t`No note or file matches “${reference.target}”.`),
          markClass: MISSING_REFERENCE_CLASS,
          actions: namedBy(reference, suggestions).map((path) => fix(reference, path))
        }];
      case "note": {
        if (!reference.anchor) return [];
        const note = { title: byPath.get(target.path)?.title ?? basename(target.path) };
        const body = target.path === targets.from
          ? source
          : notes.find((candidate) => candidate.path === target.path)?.body;
        return body !== undefined && markdownFragment(body, reference.anchor) === undefined
          ? [diagnostic(reference.from, reference.to, t`“${note.title}” has no “${reference.anchor}” section or block.`)]
          : [];
      }
      default:
        return [];
    }
  });
}

/** Notes whose title or alias is what a plain wikilink spells: what the writer
 * probably meant, offered as a fix rather than resolved silently. */
function namedBy(reference: MarkdownReference, suggestions: LinkSuggestion[]): string[] {
  if (reference.format !== "wikilink" || reference.target.includes("/")) return [];
  const name = reference.target.toLocaleLowerCase();
  return suggestions
    .filter((suggestion) => suggestion.title.toLocaleLowerCase() === name
      || suggestion.aliases?.some((alias) => alias.toLocaleLowerCase() === name))
    .slice(0, LINK_FIXES)
    .map((suggestion) => suggestion.path);
}

/** The same link written as a collection path, keeping what it displayed. */
function pathLink(reference: MarkdownReference, path: string): string {
  const target = `${path.replace(/\.md$/i, "")}${reference.anchor ? `#${reference.anchor}` : ""}`;
  const label = reference.kind === "embed" ? reference.label : reference.label ?? reference.target;
  const shown = label && basename(path).localeCompare(label, undefined, { sensitivity: "accent" }) !== 0
    ? `|${label}`
    : "";
  return `${reference.kind === "embed" ? "!" : ""}[[${target}${shown}]]`;
}

function diagnostic(from: number, to: number, message: string): Diagnostic {
  return { from, to, severity: "warning", message, source: "mdbase" };
}
