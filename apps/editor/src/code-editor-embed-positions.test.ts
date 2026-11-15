import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { embedPositions } from "./code-editor-embed-positions";

describe("embed positions", () => {
  const embeds = embedPositions<{ from: number; to: number; target: string }>();
  const start = (doc: string) => EditorState.create({ doc, extensions: embeds.field });

  it("maps shown embeds through edits and ignores a parse of older text", () => {
    let state = start("Intro\n![[a.png]]");
    state = state.update({ effects: embeds.parsed.of({ source: "Intro\n![[a.png]]", references: [{ from: 6, to: 16, target: "a.png" }] }) }).state;
    state = state.update({ changes: { from: 5, insert: "!" } }).state;
    expect(state.field(embeds.field)).toEqual([{ from: 7, to: 17, target: "a.png" }]);
    // A parse that lags the text, as one does while someone types, would put the embed on the line above.
    state = state.update({ effects: embeds.parsed.of({ source: "Intro\n![[a.png]]", references: [{ from: 6, to: 16, target: "a.png" }] }) }).state;
    expect(state.field(embeds.field)).toEqual([{ from: 7, to: 17, target: "a.png" }]);
    state = state.update({ effects: embeds.parsed.of({ source: "Intro!\n![[a.png]]", references: [{ from: 7, to: 17, target: "b" }] }) }).state;
    expect(state.field(embeds.field)).toEqual([{ from: 7, to: 17, target: "b" }]);
  });

  it("takes a CRLF note's parse in the editor's one-character line breaks", () => {
    const state = start("a\r\nb\r\n![[c.png]]");
    const next = state.update({ effects: embeds.parsed.of({ source: "a\r\nb\r\n![[c.png]]", references: [{ from: 6, to: 16, target: "c.png" }] }) }).state;
    expect(next.field(embeds.field)).toEqual([{ from: 4, to: 14, target: "c.png" }]);
  });
});
