// SDK delegation/receipt grammar tests with synthetic fixtures, not native CRUD qualification.
import {describe, expect, it, vi} from "vitest";
import {createViewSource, updateViewSource, readViewSourceRecord, revisionOf, Write, type RecordView} from "../src/index.js";
const ID = "11111111-1111-1111-1111-111111111111", MID = "22222222-2222-2222-2222-222222222222";
const DOC = "# Original café\r\nviews:\r\n  - type: opaqueHost\r\n    filters: note.open\r\n    options: {custom: preserve}\r\n";
function record(): RecordView {
  return {id: ID, path: "Views/saved.custom", revision: revisionOf(DOC), document: DOC,
    frontmatter: new Map(), types: ["manifest-view"], state: {state: "pending", confirmedSeq: 3}};
}
function pending() {return new Write({mutation: MID, state: "pending", records: [record()]});}
describe("shared source helpers use genuine SDK writes and exact caller identities", () => {
  it("uses the actual pending document revision/path/base without an implicit read", async () => {
    const seen = record(), write = pending(), promise = Promise.resolve(write), replaceDocument = vi.fn(() => promise);
    const next = DOC.replace("note.open", "note.open && note.ready"), signal = new AbortController().signal;
    expect(updateViewSource({replaceDocument}, seen, next, {mutationId: MID, signal})).toBe(promise);
    expect(await promise).toBe(write);
    expect(replaceDocument).toHaveBeenCalledExactlyOnceWith(seen, next, {mutationId: MID, signal, include: {document: true}, ifRevision: seen.revision});
    expect(seen.document).toBe(DOC); expect(seen.state.state).toBe("pending");
  });
  it("rejects missing identity/full-document/hash witnesses before any write", () => {
    const create = vi.fn(async () => Object.assign(pending(), {recordId:ID})), replaceDocument = vi.fn(async () => pending());
    for (const input of [{id: "", path: "source", document: DOC}, {id: ID, path: "", document: DOC}]) {
      expect(() => createViewSource({create}, input, {mutationId: MID})).toThrow();
    }
    expect(() => createViewSource({create}, {id: ID, path: "source", document: DOC}, {mutationId: ""})).toThrow();
    for (const seen of [{...record(), document: undefined}, {...record(), document: `${DOC}changed`}, {...record(), revision: "not-a-hash"}, {...record(), path: ""}]) {
      expect(() => updateViewSource({replaceDocument}, seen, DOC, {mutationId: MID})).toThrow();
    }
    expect(create).not.toHaveBeenCalled(); expect(replaceDocument).not.toHaveBeenCalled();
  });
  it("does not promote missing state, held or unresolved sources to replaceable records", () => {
    const replaceDocument = vi.fn(async () => pending());
    for (const state of [undefined, {...record().state, confirmedSeq: -1}, {...record().state, unresolved: 1}, {...record().state, hold: {id: ID}}]) {
      expect(() => updateViewSource({replaceDocument}, {...record(), state} as RecordView, DOC, {mutationId: MID})).toThrow();
    }
    expect(replaceDocument).not.toHaveBeenCalled();
  });
  it("refuses a complete readback with a different UUID instead of rebinding the selection", async () => {
    const get = vi.fn(async () => ({...record(), id: MID}));
    await expect(readViewSourceRecord({get}, ID)).rejects.toMatchObject({code: "invalid_request"});
    expect(get).toHaveBeenCalledTimes(1);
  });
});
