import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { CodeEditor } from "./CodeEditor";
import type { ExperimentalHostedMarkdownRoom } from "@mdbase-dev/connect-collaboration";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe("CodeMirror collaboration profile spike", () => {
  it("uses Y.Text as the sole document source and ignores controlled value replacement", async () => {
    const doc = new Y.Doc();
    const body = doc.getText("body");
    body.insert(0, "# Shared\n\nExact body\n");
    const undoManager = new Y.UndoManager(body);
    const room = {
      doc,
      body,
      undoManager,
      setAwareness: () => undefined
    } as unknown as ExperimentalHostedMarkdownRoom;
    const collaboration = {
      room,
      extension: [
        yCollab(body, null, { undoManager }),
        Prec.highest(keymap.of(yUndoManagerKeymap))
      ]
    };
    const rendered = render(createElement(CodeEditor, {
      value: "stale conventional body",
      label: "Collaborative body",
      language: "markdown",
      variant: "writer",
      collaboration
    }));

    const visible = () => [...document.querySelectorAll<HTMLElement>(".cm-line")]
      .map((line) => line.textContent ?? "").join("\n");
    await waitFor(() => expect(visible()).toBe("# Shared\n\nExact body\n"));

    rendered.rerender(createElement(CodeEditor, {
      value: "new stale conventional body",
      label: "Collaborative body",
      language: "markdown",
      variant: "writer",
      collaboration
    }));
    expect(body.toString()).toBe("# Shared\n\nExact body\n");
    expect(visible()).toBe("# Shared\n\nExact body\n");
  });

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
    doc.transact(() => body.insert(body.length, remote), "remote-provider");
    expect(view.state.doc.toString()).toBe(`${body.toString()}`);
    expect(new TextEncoder().encode(view.state.doc.toString()))
      .toEqual(new TextEncoder().encode(body.toString()));
  });
});
