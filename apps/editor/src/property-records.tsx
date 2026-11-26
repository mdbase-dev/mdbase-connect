import { t } from "@lingui/core/macro";
import type { PropertyRecords } from "@mdbase-dev/ui/properties";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { JsonObject } from "./connect-types";
import { collectionDisplayField } from "./field-reference";
import { LinkIcon } from "./icons";
import type { PropertyLinks } from "./LinkPropertyEditor";
import { linkMatches } from "./links";
import { folder, typeDisplayName, typeNameInSentence } from "./note";
import { linkValue, resolvableLinkValue } from "./record-links";
import { TypeIcon } from "./TypeIcon";

const MATCH_LIMIT = 30;
const noSubscription = () => () => {};
const noVersion = () => 0;
const wholeWikilink = /^!?\[\[[^\]]+\]\]$/u;

/** The collection's records as the property list asks about them: found by title for a link
 * property (only those of the types its rule allows), named and opened from a link, and made
 * from what was typed. Links are read by asking the collection, and written as the property's
 * rule says. Nothing without `links`: every property is then plain data. */
export function usePropertyRecords(links: PropertyLinks | undefined, values: JsonObject): PropertyRecords | undefined {
  const targets = links?.targets;
  // The answers arrive after the question: a version change draws the links again.
  useSyncExternalStore(targets?.subscribe ?? noSubscription, targets?.getVersion ?? noVersion);
  const asked = useMemo(() => [...new Set(linkTexts(values, links?.properties))].join("\n"), [values, links?.properties]);
  useEffect(() => {
    const wanted = asked.split("\n").filter(Boolean);
    // A failed lookup leaves the links named as written; the panel reports collection errors elsewhere.
    if (targets && wanted.length) void targets.resolveAll(wanted).catch(() => undefined);
  }, [targets, asked]);

  // The record index is as large as the collection: it is built when the collection changes, not on every draw.
  const suggestions = links?.suggestions;
  const types = links?.types;
  const byPath = useMemo(() => new Map((suggestions ?? []).map((suggestion) => [suggestion.path, suggestion])), [suggestions]);
  const icons = useMemo(() => new Map((types ?? []).map((type) => [type.name.toLocaleLowerCase(), collectionDisplayField(type, "icon")])), [types]);
  if (!links) return undefined;
  const icon = (types: readonly string[] | undefined) =>
    <TypeIcon name={types?.map((type) => icons.get(type.toLocaleLowerCase())).find(Boolean)} fallback={<LinkIcon />} />;
  const { onOpen, onCreate } = links;
  const records: PropertyRecords = {
    describe(path) {
      const known = byPath.get(path);
      return known && { title: known.title, icon: icon(known.types) };
    },
    search(query, property) {
      const rule = property === undefined ? undefined : links.properties.get(property);
      const wanted = new Set(rule?.targetTypes.map((type) => type.toLocaleLowerCase()));
      // Only records of the property's types, and never the record itself.
      const candidates = links.suggestions.filter((suggestion) => suggestion.path !== links.currentPath
        && (!wanted.size || suggestion.types?.some((type) => wanted.has(type.toLocaleLowerCase()))));
      return linkMatches(candidates, query, undefined, MATCH_LIMIT, { currentPath: links.currentPath, recentPaths: links.recentPaths })
        .map(({ suggestion, label }) => ({
          path: suggestion.path,
          title: label,
          // One target type says nothing new on every row; the folder tells two "Ada"s apart.
          detail: rule?.targetTypes.length !== 1 && suggestion.types?.[0] ? typeDisplayName(suggestion.types[0]) : folder(suggestion.path),
          icon: icon(suggestion.types)
        }));
    },
    link: (path, title, property) => linkValue(path, title, links.properties.get(property)?.format ?? "wikilink"),
    // A link may lead to a file, which has no note to show.
    ...(onOpen ? { open: (path: string) => { if (byPath.has(path)) onOpen(path); } } : {}),
    ...(targets ? {
      resolve(link: string) {
        const raw = resolvableLinkValue(link);
        const target = raw ? targets.get(raw) : { kind: "invalid" as const };
        if (!target) return undefined;
        return target.kind === "note" || target.kind === "file" ? target.path : null;
      }
    } : {}),
    ...(onCreate ? {
      creates(property: string) {
        const types = links.properties.get(property)?.targetTypes ?? [];
        return types.length
          ? types.map((type) => { const typeLabel = typeNameInSentence(type); return { id: type, label: t`New ${typeLabel}` }; })
          : [{ id: "", label: t`New note` }];
      },
      create: (kind, title, creation) => onCreate(kind || undefined, title, {
        anchor: creation.anchor,
        link: (made) => creation.link(made.path, made.title),
        restoreFocus: creation.restoreFocus
      })
    } : {})
  };
  return records;
}

/** Every value the list shows as a link, as the collection can be asked about it: what a link
 * rule covers, and any whole wikilink wherever it is written. */
function linkTexts(values: JsonObject, rules: PropertyLinks["properties"] | undefined): string[] {
  const texts: string[] = [];
  const visit = (value: unknown, ruled: boolean) => {
    if (typeof value === "string") {
      if (ruled || wholeWikilink.test(value.trim())) {
        const raw = resolvableLinkValue(value);
        if (raw) texts.push(raw);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, ruled);
    } else if (value && typeof value === "object") {
      for (const inner of Object.values(value)) visit(inner, false);
    }
  };
  for (const [name, value] of Object.entries(values)) visit(value, Boolean(rules?.has(name)));
  return texts;
}
