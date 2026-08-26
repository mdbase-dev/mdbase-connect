import * as Y from "yjs";

export const MARKDOWN_BODY_YJS_V13_PROFILE = "markdown-body-yjs-v13" as const;
export const COLLABORATION_PROFILE_VERSION = 1 as const;
export const BODY_ROOT = "body" as const;

export class CollaborationProfileError extends Error {
  readonly code: "collaboration_body_unsupported" | "collaboration_body_too_large";

  constructor(code: CollaborationProfileError["code"]) {
    super(code);
    this.name = "CollaborationProfileError";
    this.code = code;
  }
}

/** Validate the exact authority-visible Markdown body supported by profile v1. */
export function validateCollaborationBody(body: string, maxBodyBytes: number): void {
  if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
    throw new CollaborationProfileError("collaboration_body_too_large");
  }
  if (body.includes("\r") || body.includes("\0") || hasUnpairedSurrogate(body)) {
    throw new CollaborationProfileError("collaboration_body_unsupported");
  }
}

export function createMarkdownBodyDocument(body: string, maxBodyBytes: number): Y.Doc {
  validateCollaborationBody(body, maxBodyBytes);
  const doc = new Y.Doc();
  const text = doc.getText(BODY_ROOT);
  if (body) text.insert(0, body);
  return doc;
}

export function markdownBody(doc: Y.Doc, maxBodyBytes: number): string {
  const roots = [...doc.share.entries()];
  if (roots.length !== 1 || roots[0]?.[0] !== BODY_ROOT || !(roots[0][1] instanceof Y.Text)) {
    throw new Error("collaboration_root_unsupported");
  }
  const body = roots[0][1].toString();
  validateCollaborationBody(body, maxBodyBytes);
  return body;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export { Y };
