import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { boundedAwarenessSelections, CodeEditor } from "./CodeEditor";
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
    const onChange = vi.fn();
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
      collaboration,
      onChange
    }));

    const visible = () => [...document.querySelectorAll<HTMLElement>(".cm-line")]
      .map((line) => line.textContent ?? "").join("\n");
    await waitFor(() => expect(visible()).toBe("# Shared\n\nExact body\n"));

    rendered.rerender(createElement(CodeEditor, {
      value: "new stale conventional body",
      label: "Collaborative body",
      language: "markdown",
      variant: "writer",
      collaboration,
      onChange
    }));
    body.insert(body.length, "Remote update\n");
    await waitFor(() => expect(visible()).toBe("# Shared\n\nExact body\nRemote update\n"));
    expect(onChange).not.toHaveBeenCalled();
    expect(body.toString()).toBe("# Shared\n\nExact body\nRemote update\n");
  });

  it("does not publish conventional draft callbacks while a room binding is pending", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const rendered = render(createElement(CodeEditor, {
      value: "Pending",
      label: "Pending collaborative body",
      collaborationExpected: false,
      onChange
    }));
    rendered.rerender(createElement(CodeEditor, {
      value: "Pending",
      label: "Pending collaborative body",
      collaborationExpected: true,
      onChange
    }));

    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    await user.click(content!);
    await user.keyboard("{End} update");
    await waitFor(() => expect(content).toHaveTextContent("Pending update"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reconfigures a pending editor onto a room and detaches it on terminal failure", async () => {
    const doc = new Y.Doc();
    const body = doc.getText("body");
    body.insert(0, "# Exact room body\n\nShared.\n");
    const undoManager = new Y.UndoManager(body);
    const room = { doc, body, undoManager, setAwareness: vi.fn() } as unknown as ExperimentalHostedMarkdownRoom;
    const collaboration = {
      room,
      extension: [
        yCollab(body, null, { undoManager }),
        Prec.highest(keymap.of(yUndoManagerKeymap))
      ]
    };
    const rendered = render(createElement(CodeEditor, {
      value: "Cached conventional body",
      label: "Dynamic collaborative body",
      collaborationExpected: true,
      readOnly: true
    }));
    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    rendered.rerender(createElement(CodeEditor, {
      value: "Cached conventional body",
      label: "Dynamic collaborative body",
      collaborationExpected: true,
      collaboration
    }));
    await waitFor(() => expect([...document.querySelectorAll<HTMLElement>(".cm-line")]
      .map((line) => line.textContent ?? "").join("\n")).toBe("# Exact room body\n\nShared.\n"));
    expect(document.querySelector(".cm-content")).toBe(content);

    rendered.rerender(createElement(CodeEditor, {
      value: "Cached conventional body",
      label: "Dynamic collaborative body",
      collaborationExpected: true,
      readOnly: true
    }));
    const detached = content!.textContent;
    body.insert(body.length, "Late terminal update");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".cm-content")).toBe(content);
    expect(content!.textContent).toBe(detached);
  });

  it("renders and clears bounded sanitized remote presence", async () => {
    const doc = new Y.Doc();
    const body = doc.getText("body");
    body.insert(0, "Shared presence");
    const undoManager = new Y.UndoManager(body);
    const room = { doc, body, undoManager, setAwareness: vi.fn() } as unknown as ExperimentalHostedMarkdownRoom;
    const extension = [yCollab(body, null, { undoManager })];
    const snapshot = {
      state: "connected" as const,
      body: body.toString(),
      mode: "read_write" as const,
      epoch: 1,
      pendingUpdates: 0,
      participants: [{
        name: "Participant 2",
        color: "violet" as const,
        status: "active" as const,
        selections: [{ anchor: 2, head: 7 }]
      }]
    };
    const rendered = render(createElement(CodeEditor, {
      value: body.toString(),
      label: "Presence body",
      collaborationExpected: true,
      collaboration: { room, extension, snapshot }
    }));

    await waitFor(() => expect(document.querySelector(".cm-remote-presence-label"))
      .toHaveTextContent("Participant 2"));
    expect(document.querySelector(".cm-remote-presence-selection"))
      .toHaveClass("cm-remote-presence-violet");
    expect(document.querySelector(".cm-remote-presence-caret"))
      .toHaveClass("cm-remote-presence-violet");

    rendered.rerender(createElement(CodeEditor, {
      value: body.toString(),
      label: "Presence body",
      collaborationExpected: true,
      collaboration: { room, extension, snapshot: { ...snapshot, participants: [] } }
    }));
    await waitFor(() => expect(document.querySelector(".cm-remote-presence-label")).toBeNull());
  });

  it("bounds local multi-selection awareness to the protocol limit", () => {
    const ranges = Array.from({ length: 9 }, (_, index) => ({ anchor: index, head: index + 1 }));
    expect(boundedAwarenessSelections(ranges)).toEqual(ranges.slice(0, 4));
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
