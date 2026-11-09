// Comment anchors in a CodeMirror editor: commented passages are highlighted,
// and a suggestion shows as a tracked change (the text it replaces struck
// through, its replacement inline after it). Anchors follow edits between
// updates. Style them with `@mdbase-dev/ui/comments.css`.
import { plural, t } from "@lingui/core/macro";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, WidgetType, type DecorationSet } from "@codemirror/view";

import { editorTarget, locate, type CommentTarget } from "./comments.js";
import "./i18n.js";

export interface CommentAnchor {
  /** The thread's first comment's path. */
  readonly id: string;
  /** Located in the editor's own text when shown; a detached anchor is not shown. */
  readonly target: CommentTarget;
  /** A suggestion's replacement text. */
  readonly replacement?: string;
}

/** What a hover over an anchor shows of its thread. */
export interface CommentAnchorCard {
  readonly kind: "comment" | "suggestion";
  readonly author: string;
  readonly when: string;
  readonly text: string;
  readonly replies: number;
}

const setAnchors = StateEffect.define<{ anchors: readonly CommentAnchor[]; active: string | null }>();

class Insertion extends WidgetType {
  constructor(
    readonly id: string,
    readonly text: string,
    readonly active: boolean,
  ) {
    super();
  }

  override eq(other: Insertion): boolean {
    return other.id === this.id && other.text === this.text && other.active === this.active;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    // An empty insertion is a comment on a point between two characters.
    span.className = `${this.text ? "cm-suggest-insert" : "cm-comment-point"}${this.active ? " is-active" : ""}`;
    span.dataset["comment"] = this.id;
    span.textContent = this.text;
    span.title = this.text ? t({ message: "Suggested insertion" }) : t({ message: "Comment" });
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function decorations(text: string, anchors: readonly CommentAnchor[], active: string | null): DecorationSet {
  const ranges = [];
  for (const a of anchors) {
    const at = locate(text, editorTarget(a.target));
    if (!at) continue;
    const { from, to } = at;
    const isActive = a.id === active;
    const suggestion = a.replacement !== undefined;
    if (to > from) {
      const className = `${suggestion ? "cm-suggest-delete" : "cm-comment"}${isActive ? " is-active" : ""}`;
      // A suggestion that only replaces is still a deletion followed by an insertion.
      ranges.push(Decoration.mark({ class: className, attributes: { "data-comment": a.id } }).range(from, to));
    }
    if (suggestion && a.replacement) ranges.push(Decoration.widget({ widget: new Insertion(a.id, a.replacement, isActive), side: 1 }).range(to));
    else if (!suggestion && to === from) ranges.push(Decoration.widget({ widget: new Insertion(a.id, "", isActive), side: 1 }).range(to));
  }
  return Decoration.set(ranges, true);
}

const anchorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setAnchors)) return decorations(tr.state.doc.toString(), e.value.anchors, e.value.active);
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const anchorId = (element: EventTarget | null) =>
  element instanceof Element ? element.closest<HTMLElement>("[data-comment]")?.dataset["comment"] : undefined;

/**
 * Anchors, a click on one (its thread's id), and a card on hover saying who
 * said what. Call `showCommentAnchors` whenever the threads change.
 */
export function commentAnchors(onAnchor: (id: string) => void, card?: (id: string) => CommentAnchorCard | null): Extension {
  const hover = hoverTooltip((view, pos) => {
    if (!card) return null;
    let hit: { id: string; from: number; to: number } | null = null;
    view.state.field(anchorField).between(pos, pos, (from, to, value) => {
      const spec = value.spec as { attributes?: Record<string, string>; widget?: Insertion };
      const id = spec.attributes?.["data-comment"] ?? spec.widget?.id;
      if (id && !hit) hit = { id, from, to };
    });
    if (!hit) return null;
    const { id, from, to } = hit as { id: string; from: number; to: number };
    const info = card(id);
    if (!info) return null;
    return {
      pos: from,
      end: to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-comment-tip";
        const who = document.createElement("div");
        who.className = "cm-comment-who";
        who.textContent = `${info.author} · ${info.when}`;
        const body = document.createElement("div");
        body.className = "cm-comment-said";
        const said = info.text || (info.kind === "suggestion" ? t({ message: "Suggested edit" }) : "");
        body.textContent = said.length > 240 ? `${said.slice(0, 239)}…` : said;
        dom.append(who, body);
        if (info.replies) {
          const replies = document.createElement("div");
          replies.className = "cm-comment-who";
          replies.textContent = plural(info.replies, { one: "# reply", other: "# replies" });
          dom.append(replies);
        }
        return { dom };
      },
    };
  }, { hoverTime: 250 });
  return [
    anchorField,
    hover,
    EditorView.domEventHandlers({
      click(event) {
        const id = anchorId(event.target);
        if (id) onAnchor(id);
        return false;
      },
    }),
  ];
}

export function showCommentAnchors(view: EditorView, anchors: readonly CommentAnchor[], active: string | null): void {
  view.dispatch({ effects: setAnchors.of({ anchors, active }) });
}

/** Where the anchor of thread `id` is in the editor's text now, or null when it is not shown. */
export function commentAnchorRange(view: EditorView, id: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  const cursor = view.state.field(anchorField).iter();
  while (cursor.value && !found) {
    const spec = cursor.value.spec as { attributes?: Record<string, string>; widget?: Insertion };
    if ((spec.attributes?.["data-comment"] ?? spec.widget?.id) === id) found = { from: cursor.from, to: cursor.to };
    cursor.next();
  }
  return found;
}
