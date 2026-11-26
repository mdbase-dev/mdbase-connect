import { afterEach, describe, expect, it } from "vitest";
import { captureRequestedNote, takeRequestedNote } from "./requested-note";

function memoryStore(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}

afterEach(() => history.replaceState(null, "", "/"));

describe("a link that names a record", () => {
  it("takes the record out of the address and opens it once, in the collection the link named", () => {
    const store = memoryStore();
    history.replaceState(null, "", "/?server=https%3A%2F%2Fconnect.example&collection=c1#note=tasks%2Frenew%20passport.md");
    captureRequestedNote(location, store);
    expect(location.hash).toBe("");
    expect(location.search).toBe("?server=https%3A%2F%2Fconnect.example&collection=c1");
    expect(takeRequestedNote("c2", store)).toBeUndefined();
    expect(takeRequestedNote("c1", store)).toBe("tasks/renew passport.md");
    expect(takeRequestedNote("c1", store)).toBeUndefined();
  });

  it("leaves other fragments alone and ignores a record without a collection", () => {
    const store = memoryStore();
    history.replaceState(null, "", "/?surface=settings#your-person");
    captureRequestedNote(location, store);
    expect(location.hash).toBe("#your-person");
    history.replaceState(null, "", "/#note=tasks%2Fa.md");
    captureRequestedNote(location, store);
    expect(location.hash).toBe("");
    expect(store.length).toBe(0);
  });
});
