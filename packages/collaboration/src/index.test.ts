import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BODY_ROOT,
  CollaborationProfileError,
  createMarkdownBodyDocument,
  markdownBody,
  validateCollaborationBody
} from "./index.js";

const LIMIT = 1024 * 1024;

describe("Markdown body collaboration profile", () => {
  it("preserves exact UTF-8 body text without Unicode normalization", () => {
    const body = "# Café 👩🏽‍💻\n\ne\u0301 is decomposed\n";
    const doc = createMarkdownBodyDocument(body, LIMIT);
    expect(markdownBody(doc, LIMIT)).toBe(body);
    expect([...new TextEncoder().encode(markdownBody(doc, LIMIT))])
      .toEqual([...new TextEncoder().encode(body)]);

    const restored = new Y.Doc();
    restored.getText(BODY_ROOT);
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    expect(markdownBody(restored, LIMIT)).toBe(body);
  });

  it.each(["a\r\nb", "a\rb", "a\r\nb\nc", "a\0b", "a\ud800b"])(
    "rejects unsupported profile body %j",
    (body) => {
      expect(() => validateCollaborationBody(body, LIMIT)).toThrowError(
        expect.objectContaining<Partial<CollaborationProfileError>>({
          code: "collaboration_body_unsupported"
        })
      );
    }
  );

  it("rejects extra and wrong shared roots", () => {
    const extra = createMarkdownBodyDocument("safe\n", LIMIT);
    extra.getMap("metadata").set("hidden", true);
    expect(() => markdownBody(extra, LIMIT)).toThrow("collaboration_root_unsupported");
  });
});
