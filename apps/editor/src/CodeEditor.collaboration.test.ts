import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe("CodeMirror collaboration profile spike", () => {
  it("binds the complete exact body, including heading and Unicode, to Y.Text", () => {
    const original = "# Heading 👋\n\nCafé and e\u0301 stay distinct\n";
    const doc = new Y.Doc();
    const body = doc.getText("body");
    body.insert(0, original);
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: body.toString(),
        extensions: [yCollab(body, null)]
      })
    });

    expect(view.state.doc.toString()).toBe(original);
    const insertion = "Local 👩🏽‍💻 ";
    const insertAt = original.indexOf("Café");
    view.dispatch({ changes: { from: insertAt, insert: insertion } });
    expect(body.toString()).toBe(
      `${original.slice(0, insertAt)}${insertion}${original.slice(insertAt)}`
    );

    const remote = "Remote ✨\n";
    body.insert(body.length, remote, "remote-provider");
    expect(view.state.doc.toString()).toBe(`${body.toString()}`);
    expect(new TextEncoder().encode(view.state.doc.toString()))
      .toEqual(new TextEncoder().encode(body.toString()));
  });
});
