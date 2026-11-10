// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commentAnchors, showCommentAnchors, type CommentAnchor } from "./comment-anchors.js";

const anchor = (id: string, exact: string): CommentAnchor => ({ id, target: { quote: { exact } } });

function editor(doc: string, margin: boolean, onAnchor = vi.fn()) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [commentAnchors(onAnchor, undefined, { margin })] }) });
  return { view, onAnchor };
}

const markers = (view: EditorView) => [...view.dom.querySelectorAll<HTMLElement>(".cm-comment-marker")];

describe("comment margin marks", () => {
  it("marks each commented line once, counting its threads", () => {
    const { view } = editor("one two\nthree\nfour", true);
    showCommentAnchors(view, [anchor("a", "one"), anchor("b", "two"), anchor("c", "four")], "c");
    const found = markers(view);
    expect(found.map((el) => el.textContent)).toEqual(["2", ""]);
    expect(found.map((el) => el.classList.contains("is-active"))).toEqual([false, true]);
  });

  it("opens the line's first thread on a click", () => {
    const { view, onAnchor } = editor("one two\nthree", true);
    showCommentAnchors(view, [anchor("a", "one"), anchor("b", "two")], null);
    markers(view)[0]?.click();
    expect(onAnchor).toHaveBeenCalledWith("a");
  });

  it("follows an edit above the comment", () => {
    const { view } = editor("one\ntwo", true);
    showCommentAnchors(view, [anchor("a", "two")], null);
    view.dispatch({ changes: { from: 0, insert: "zero\n" } });
    showCommentAnchors(view, [anchor("a", "two")], "a");
    expect(markers(view).map((el) => el.classList.contains("is-active"))).toEqual([true]);
  });

  it("has no margin unless asked", () => {
    const { view } = editor("one", false);
    showCommentAnchors(view, [anchor("a", "one")], null);
    expect(view.dom.querySelector(".cm-comment-gutter")).toBeNull();
  });
});
