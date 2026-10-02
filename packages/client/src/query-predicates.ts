export interface LinksToOptions {
  /** The field is a link list instead of a scalar link. Uses CEL exists(). */
  multiple?: boolean;
}

/**
 * A CEL predicate comparing an authority-resolved link with an exact collection
 * path. `field` is a literal top-level effective-frontmatter key, not an expression.
 * Missing/null fields and unresolved links do not match. Resolution (including
 * configured IDs, relative paths and duplicate names) belongs to the authority.
 */
export function linksTo(field: string, path: string, options: LinksToOptions = {}): string {
  const key = JSON.stringify(field);
  const value = `record[${key}]`;
  const target = JSON.stringify(path);
  const matches = (link: string) => `${link} != null && ${link}.asFile() != null && ${link}.asFile().file.path == ${target}`;
  return `${key} in record && ${options.multiple
    ? `${value} != null && ${value}.exists(link, ${matches("link")})`
    : matches(value)}`;
}
