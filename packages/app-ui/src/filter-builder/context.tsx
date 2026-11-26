import { createContext, useContext, type ReactNode } from "react";

import { Glyph } from "../glyphs.js";
import type { FilterLabels } from "./labels.js";
import { inferField, labelOf, MULTI, operatorLabel, UNARY } from "./operators.js";
import type { FilterCombinator, FilterContextVar, FilterFieldKind, FilterFieldSpec, FilterGroup, FilterRule, FilterValue } from "./types.js";

// The mark of an expression and an expression to start from: CEL, the same in every language.
const fx = "fx";
export const EXPRESSION_EXAMPLE = "amount * 1.1 > 500";
export const FX = <span className="mdbase-filter-fx" aria-hidden="true">{fx}</span>;

/** `shared` is the `query.where` every view of a file applies; `view` is this view's own `where`. */
export type Tier = "shared" | "view";

/** What every pill reads from the bar it sits on. */
export interface BarContext {
  labels: FilterLabels;
  fields: FilterFieldSpec[];
  contextVars: FilterContextVar[];
  /** Fields the host owns: their rules stay editable but cannot be removed or rewritten, and are not offered for new rules. */
  locked: ReadonlySet<string>;
  /** Whether the shared tier exists, so filters can move between tiers. */
  tiered: boolean;
  trees: Record<Tier, FilterGroup>;
  edit: (tier: Tier, change: (tree: FilterGroup) => FilterGroup) => void;
  /** Moves a top-level node to the other tier. */
  move: (from: Tier, id: string) => void;
  /** The one open popover, as `tier:nodeId:part`. */
  openKey: string | null;
  setOpenKey: (key: string | null) => void;
  /** Returns focus to the bar's add button, after the focused pill went away. */
  focusAdd: () => void;
  /** Focuses the pill for node `id` once it renders (after it was rebuilt under the same id). */
  focusNode: (tier: Tier, id: string) => void;
}

export const Bar = createContext<BarContext | null>(null);

export function useBar(): BarContext {
  const bar = useContext(Bar);
  if (!bar) throw new Error("Filter pills must render inside a FilterBuilder");
  return bar;
}

/** The part of `key`'s node whose popover is open, if any. */
export function openPart(bar: BarContext, key: string): string | null {
  return bar.openKey?.startsWith(`${key}:`) ? bar.openKey.slice(key.length + 1) : null;
}

export const KIND_ICONS: Record<FilterFieldKind, ReactNode> = {
  string: <Glyph name="text" />, number: <Glyph name="number" />, date: <Glyph name="date" />,
  boolean: <Glyph name="boolean" />, enum: <Glyph name="choice" />, formula: <Glyph name="formula" />,
};

export const fieldOf = (fields: FilterFieldSpec[], rule: FilterRule) => fields.find(field => field.key === rule.field) ?? inferField(rule);

const show = (value: FilterValue) => (value === "" ? '""' : String(value));

/** The value segment's text: `Software, Travel` for two values, `3 selected` beyond that. */
export function valueText(labels: FilterLabels, rule: FilterRule): string | null {
  if (UNARY.has(rule.op)) return null;
  if (MULTI.has(rule.op)) {
    const values = rule.values ?? [];
    return values.length > 2 ? labels.selected(values.length) : values.length ? values.map(show).join(", ") : "…";
  }
  return rule.value === undefined ? "…" : show(rule.value);
}

/** A one-line reading of a rule, naming every value. */
export function describeRule(labels: FilterLabels, rule: FilterRule, fields: FilterFieldSpec[]): string {
  const field = fieldOf(fields, rule);
  const head = `${labelOf(field)} ${operatorLabel(labels, field.kind, rule.op)}`;
  if (UNARY.has(rule.op)) return head;
  const value = MULTI.has(rule.op) ? (rule.values ?? []).map(show).join(", ") || "…" : valueText(labels, rule);
  return `${head} ${value}`;
}

/** What each combinator keeps, as a menu hint. */
export const combinatorHint = (labels: FilterLabels, combinator: FilterCombinator) =>
  ({ all: labels.everyFilter, any: labels.atLeastOne, none: labels.noFilter })[combinator];
