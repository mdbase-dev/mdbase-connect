/** A search as typed. Words and "quoted phrases" are matched as text; a
 * phrase still being typed (no closing quote yet) runs to the end. `#tag`,
 * `tag:name` and `type:name` are filters, matched as the list's tag and type
 * filters match. */
export interface SearchQuery {
  /** Words and phrases, as typed (a phrase's inner spaces collapsed). */
  words: string[];
  /** The words that were quoted, matched only as written. */
  phrases: Set<string>;
  tags: string[];
  types: string[];
}

export function parseSearchQuery(query: string): SearchQuery {
  const parsed: SearchQuery = { words: [], phrases: new Set(), tags: [], types: [] };
  for (const [, quoted, word] of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    if (quoted !== undefined) {
      const phrase = quoted.trim().replace(/\s+/g, " ");
      if (phrase) {
        parsed.words.push(phrase);
        parsed.phrases.add(phrase);
      }
      continue;
    }
    // A bare `#`, `tag:` or `type:` is a filter not yet written: it matches everything.
    const filter = /^(?:(type):|(?:tag:)?#+|tag:)(.*)$/i.exec(word);
    if (!filter) parsed.words.push(word);
    else if (filter[2]) (filter[1] ? parsed.types : parsed.tags).push(filter[2]);
  }
  return parsed;
}
