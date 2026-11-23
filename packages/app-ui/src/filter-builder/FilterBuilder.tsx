import { useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";

import { AnchoredPopover } from "../AnchoredPopover.js";
import { Glyph } from "../glyphs.js";
import { useLocaleRevision } from "../i18n.js";
import { AddFilter } from "./AddFilter.js";
import { Bar, combinatorHint, openPart, type BarContext, type Tier } from "./context.js";
import { compileWhere, countActive, parseWhere } from "./filter-ast.js";
import { FilterNodeView, GroupCluster } from "./FilterPill.js";
import { filterLabels, type FilterLabels } from "./labels.js";
import { FilterMenu } from "./menu.js";
import { appendAll, findNode, reid, replaceNode } from "./tree.js";
import type { FilterCombinator, FilterContextVar, FilterFieldSpec, FilterGroup } from "./types.js";

export interface FilterBuilderProps {
  /** The `where` expression being edited. The builder is controlled: edits go through `onChange`. */
  query: string;
  fields: FilterFieldSpec[];
  /** `this.*` bindings offered as values. */
  contextVars?: FilterContextVar[] | undefined;
  /** Why the current query failed, shown under the bar. */
  error?: string | undefined;
  /** Fields the host owns: their rules stay editable but cannot be removed, and they are not offered for new rules. */
  lockedFields?: string[] | undefined;
  onChange: (nextQuery: string) => void;
  /**
   * A second tier applied with `query`, such as the `query.where` an
   * `mdbase.view` file shares across its views. Its filters sit on the bar
   * marked "Shared" when `onSharedChange` is given, and filters can move
   * between the tiers.
   */
  sharedQuery?: string | undefined;
  onSharedChange?: ((nextQuery: string) => void) | undefined;
  /** The bar's accessible name; defaults to `labels.filters`. */
  ariaLabel?: string | undefined;
  /** Open the list of fields as soon as the bar appears, when the bar was asked for in order to add a filter. */
  defaultOpen?: boolean | undefined;
  /** Text to show in place of the shared catalogue's, for what a host words its own way. */
  labels?: Partial<FilterLabels> | undefined;
}

/**
 * The edited tree, kept locally so drafts (rules without a value, empty
 * groups) and node ids survive while the compiled query is unchanged or the
 * host has not yet echoed an edit back. A query the builder did not emit is
 * re-parsed.
 */
function useFilterTree(query: string, onChange?: (next: string) => void) {
  const [state, setState] = useState(() => ({ seen: query, source: query, tree: parseWhere(query) }));
  let current = state;
  if (query !== state.seen) current = query === state.source ? { ...state, seen: query } : { seen: query, source: query, tree: parseWhere(query) };
  if (current !== state) setState(current);
  const update = (tree: FilterGroup) => {
    const where = compileWhere(tree);
    setState({ seen: current.seen, source: where, tree });
    if (where !== current.source) onChange?.(where);
  };
  return { tree: current.tree, update };
}

const rootName = (labels: FilterLabels, combinator: FilterCombinator) =>
  ({ all: labels.matchAll, any: labels.matchAny, none: labels.exclude })[combinator];
const ADD = "bar:add";

/**
 * A filter bar for the CEL `where` expression of an `mdbase.view`. Each filter is a pill
 * (`field | operator | value | ×`) whose parts are changed where they stand, custom CEL is an
 * `fx` pill, nested groups are clusters of pills, and `Filter` opens the list of fields to add
 * one from.
 */
export function FilterBuilder({ query, fields, contextVars = [], error, lockedFields = [], onChange, sharedQuery = "", onSharedChange, ariaLabel, defaultOpen = false, labels: labelOverrides }: FilterBuilderProps): JSX.Element {
  useLocaleRevision();
  const labels: FilterLabels = { ...filterLabels(), ...labelOverrides };
  const view = useFilterTree(query, onChange);
  const shared = useFilterTree(sharedQuery, onSharedChange);
  const tiered = onSharedChange !== undefined;
  const [openKey, setOpenKey] = useState<string | null>(defaultOpen ? ADD : null);
  const rootRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const lockedKey = lockedFields.join("\n");
  const locked = useMemo(() => new Set(lockedKey ? lockedKey.split("\n") : []), [lockedKey]);

  const trees: Record<Tier, FilterGroup> = { view: view.tree, shared: shared.tree };
  const updates: Record<Tier, (tree: FilterGroup) => void> = { view: view.update, shared: shared.update };
  const bar: BarContext = {
    labels, fields, contextVars, locked, tiered, trees, openKey, setOpenKey,
    edit: (tier, change) => updates[tier](change(trees[tier])),
    move: (from, id) => {
      const node = findNode(trees[from], id);
      if (!node) return;
      const to: Tier = from === "view" ? "shared" : "view";
      const moved = reid(node);
      updates[from](replaceNode(trees[from], id, null));
      updates[to](appendAll(trees[to], moved));
      pendingFocus.current = `[data-key="${to}:${moved.id}"]`;
    },
    focusAdd: () => { pendingFocus.current = ".mdbase-filter-add"; },
    focusNode: (tier, id) => { pendingFocus.current = `[data-key="${tier}:${id}"]`; },
  };

  useLayoutEffect(() => {
    const selector = pendingFocus.current;
    if (!selector) return;
    pendingFocus.current = null;
    const target = rootRef.current?.querySelector<HTMLElement>(selector);
    (target?.matches("button") ? target : target?.querySelector<HTMLElement>("button"))?.focus();
  });

  const sharedVisible = tiered && shared.tree.children.length > 0;
  const root = view.tree;
  // The bar's own "Match" chip speaks for the view's filters only when nothing else sits on the bar.
  const chip = !sharedVisible && (root.combinator !== "all" ? root.children.length > 0 : root.children.length > 1);
  const part = openPart(bar, "bar");
  const total = countActive(view.tree) + (tiered ? countActive(shared.tree) : 0);
  const closeAdd = (restore: boolean) => { if (restore) addRef.current?.focus(); setOpenKey(null); };

  const tier = (name: Tier, tree: FilterGroup, inline: boolean) =>
    inline
      ? tree.children.map(child => <FilterNodeView key={`${name}:${child.id}`} node={child} tier={name} depth={0} />)
      : <GroupCluster key={`${name}:${tree.id}`} node={tree} tier={name} depth={0} root />;

  return (
    <Bar.Provider value={bar}>
      <div className="mdbase-filter" role="group" aria-label={ariaLabel ?? labels.filters} ref={rootRef}>
        <div className="mdbase-filter-bar">
          {chip && (
            <span className="mdbase-filter-anchor">
              <button ref={chipRef} type="button" className="mdbase-filter-match" aria-haspopup="menu" aria-expanded={part === "combinator"} title={labels.howFiltersCombine}
                onClick={() => setOpenKey(part === "combinator" ? null : "bar:combinator")}>
                {rootName(labels, root.combinator)}<Glyph name="down" size={12} />
              </button>
              <FilterMenu open={part === "combinator"} anchor={chipRef} label={labels.match} onClose={() => setOpenKey(null)}
                items={(["all", "any", "none"] as const).map(combinator => ({
                  label: rootName(labels, combinator), hint: combinatorHint(labels, combinator), checked: root.combinator === combinator,
                  onSelect: () => { view.update({ ...root, combinator }); chipRef.current?.focus(); setOpenKey(null); },
                }))} />
            </span>
          )}
          {sharedVisible && tier("shared", shared.tree, shared.tree.combinator === "all")}
          {root.children.length > 0 && tier("view", root, root.combinator === "all" || chip)}
          <span className="mdbase-filter-anchor">
            <button ref={addRef} type="button" className="mdbase-filter-add" aria-label={labels.addFilter} aria-haspopup="dialog" aria-expanded={openKey === ADD}
              data-active={total > 0 || undefined} onClick={() => setOpenKey(openKey === ADD ? null : ADD)}>
              <Glyph name={total > 0 ? "plus" : "filter"} />{labels.filter}
            </button>
            {openKey === ADD && (
              <AnchoredPopover anchor={addRef} label={labels.addFilter} className="mdbase-filter-popover mdbase-filter-command" onClose={() => setOpenKey(null)}>
                <AddFilter tier="view" groupId={null} onClose={closeAdd} />
              </AnchoredPopover>
            )}
          </span>
        </div>
        {error && <p className="mdbase-filter-error" role="alert">{error}</p>}
      </div>
    </Bar.Provider>
  );
}
