import { useRef, useState, type JSX, type MouseEvent, type ReactNode } from "react";

import { Calendar } from "../DatePicker.js";
import { Glyph } from "../glyphs.js";
import { EXPRESSION_EXAMPLE, useBar } from "./context.js";
import { tryExpressionToRule } from "./filter-ast.js";
import { isNegated, MULTI, selection, valueKindOf, varsFor, withSelection, withValue } from "./operators.js";
import type { FilterContextVar, FilterFieldKind, FilterFieldSpec, FilterRule, FilterValue } from "./types.js";

/** Keeps focus where it is, so a click inside a popover does not blur (and commit) the field being typed in. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

function parseLiteral(text: string, kind: FilterFieldKind): FilterValue | undefined {
  const trimmed = text.trim();
  if (kind === "number") return trimmed && Number.isFinite(Number(trimmed)) ? Number(trimmed) : undefined;
  if (kind === "date") return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed : undefined;
  if (kind === "formula" && trimmed && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return text === "" ? undefined : text;
}

interface LiteralInputProps {
  kind: FilterFieldKind;
  initial?: FilterValue;
  placeholder: string;
  label: string;
  /** Commit when focus leaves the field (not on Escape). */
  commitOnBlur: boolean;
  onCommit: (value: FilterValue, viaEnter: boolean) => void;
  /** Names a button that takes the value, for someone who does not think to press Enter. */
  action?: string;
  /** Shown between the field and the button. */
  children?: ReactNode;
}

/**
 * A typed literal; Enter commits it, as does its button, and Escape leaves it. A date is picked
 * from a calendar instead, or typed above it.
 */
function LiteralInput({ kind, initial, placeholder, label, commitOnBlur, onCommit, action, children }: LiteralInputProps): JSX.Element {
  const { labels } = useBar();
  const [draft, setDraft] = useState(initial === undefined ? "" : String(initial));
  const cancelled = useRef(false);
  const value = parseLiteral(draft, kind);
  const commit = (viaEnter: boolean) => {
    if (value !== undefined && (viaEnter || value !== initial)) onCommit(value, viaEnter);
  };
  if (kind === "date") {
    return (
      <>
        <Calendar value={typeof initial === "string" ? initial.slice(0, 10) : null} labels={labels.date} onPick={picked => onCommit(picked, true)} />
        {children}
      </>
    );
  }
  return (
    <>
      <div className="mdbase-filter-input-row">
        <input className="mdbase-field" data-autofocus aria-label={label} spellCheck={false} autoComplete="off" value={draft}
          type="text" inputMode={kind === "number" ? "decimal" : undefined} placeholder={placeholder}
          onChange={event => setDraft(event.target.value)}
          onBlur={() => { if (commitOnBlur && !cancelled.current) commit(false); }}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); commit(true); }
            if (event.key === "Escape") cancelled.current = true;
          }} />
        {!action && <span className="mdbase-filter-enter"><Glyph name="enter" /></span>}
      </div>
      {children}
      {action && (
        <div className="mdbase-filter-foot">
          <span className="mdbase-filter-hint">{draft.trim() && value === undefined ? (kind === "number" ? labels.notANumber : "") : labels.enterHint}</span>
          <button type="button" className="mdbase-button is-primary" disabled={value === undefined} onMouseDown={keepFocus} onClick={() => commit(true)}>{action}</button>
        </div>
      )}
    </>
  );
}

export interface ValuePanelProps {
  rule: FilterRule;
  field: FilterFieldSpec;
  contextVars: FilterContextVar[];
  /** Commit a typed value when focus leaves it (editing a pill), rather than only on Enter (adding one). */
  commitOnBlur: boolean;
  onChange: (rule: FilterRule) => void;
  /** The value is chosen: close. */
  onDone: () => void;
  /** What the button that takes a typed value says: "Add filter" when adding one, "Done" when changing one. */
  action: string;
}

/**
 * Picks a rule's value: a checklist for enums and `in` rules (one value is
 * `eq`, several are `in`), True/False for booleans, otherwise a typed literal,
 * plus one-click `this.*` bindings.
 */
export function ValuePanel({ rule, field, contextVars, commitOnBlur, onChange, onDone, action }: ValuePanelProps): JSX.Element {
  const { labels } = useBar();
  const kind = valueKindOf(field.kind, rule.op);
  const vars = varsFor(contextVars, kind);
  const context = rule.valueKind === "context";
  const checklist = MULTI.has(rule.op) || (kind === "enum" && !context && (rule.op === "eq" || rule.op === "neq"));
  const chips = vars.length > 0 && !MULTI.has(rule.op) && (
    <div className="mdbase-filter-vars" role="group" aria-label={labels.contextValues}>
      {vars.map(item => (
        <button key={item.expr} type="button" className="mdbase-filter-var" aria-pressed={context && rule.value === item.expr} title={labels.compareWith(item.expr)}
          onMouseDown={keepFocus} onClick={() => { onChange(withValue(rule, item.expr, "context")); onDone(); }}>
          <code>{item.expr}</code>{item.preview !== undefined && <span> · {item.preview}</span>}
        </button>
      ))}
    </div>
  );

  if (checklist) {
    const selected = selection(rule);
    const options = [...(field.enumValues ?? []), ...selected.filter(value => !field.enumValues?.includes(value))];
    const toggle = (value: FilterValue) => {
      const next = selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value];
      onChange(withSelection(rule, options.filter(option => next.includes(option)), isNegated(rule)));
    };
    return (
      <div className="mdbase-filter-panel">
        <div className="mdbase-filter-checklist" role="group" aria-label={labels.values}>
          {options.map((option, index) => (
            <label key={JSON.stringify(option)} className="mdbase-filter-check">
              <input type="checkbox" className="mdbase-checkbox" data-autofocus={index === 0 || undefined} checked={selected.includes(option)} onChange={() => toggle(option)}
                onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); onDone(); } }} />
              <span title={String(option)}>{option === "" ? '""' : String(option)}</span>
            </label>
          ))}
          {!options.length && <p className="mdbase-filter-hint">{labels.noValues}</p>}
        </div>
        {field.kind !== "enum" && kind !== "date" && (
          <LiteralInput kind={kind} label={labels.addValue} placeholder={labels.addValuePlaceholder} commitOnBlur={false}
            onCommit={value => { if (!selected.includes(value)) onChange(withSelection(rule, [...selected, value], isNegated(rule))); }} />
        )}
        {chips}
        <div className="mdbase-filter-foot">
          <span className="mdbase-filter-hint">{selected.length > 1 ? labels.selected(selected.length) : labels.pickOneOrMore}</span>
          <button type="button" className="mdbase-button is-primary" onClick={onDone}>{labels.done}</button>
        </div>
      </div>
    );
  }

  if (kind === "boolean" && !context) {
    return (
      <div className="mdbase-filter-panel">
        <div className="mdbase-filter-choices" role="group" aria-label={labels.value}>
          {[true, false].map(option => (
            <button key={String(option)} type="button" className="mdbase-filter-choice" data-autofocus={rule.value === option || (option && rule.value === undefined) || undefined}
              aria-pressed={rule.value === option} onClick={() => { onChange(withValue(rule, option)); onDone(); }}>
              {option ? labels.true : labels.false}
            </button>
          ))}
        </div>
        {chips}
      </div>
    );
  }

  return (
    <div className="mdbase-filter-panel">
      <LiteralInput key={`${rule.op}:${String(context)}`} kind={kind} initial={context ? undefined : rule.value} label={labels.value} commitOnBlur={commitOnBlur} action={action}
        placeholder={rule.op === "year_eq" ? labels.yearPlaceholder : kind === "number" ? labels.numberPlaceholder : labels.valuePlaceholder}
        onCommit={(value, viaEnter) => { onChange(withValue(rule, value)); if (viaEnter) onDone(); }}>
        {chips}
      </LiteralInput>
    </div>
  );
}

export interface ExprEditorProps {
  expression: string;
  id: string;
  onApply: (expression: string) => void;
  /** Replaces the expression with the visual rule it spells. */
  onConvert: (rule: FilterRule) => void;
  /** Commit the text when focus leaves the editor (editing a pill), rather than only on Apply (adding one). */
  commitOnBlur: boolean;
}

/** A CEL editor: Enter applies, Shift+Enter breaks the line. */
export function ExprEditor({ expression, id, onApply, onConvert, commitOnBlur }: ExprEditorProps): JSX.Element {
  const { labels } = useBar();
  const [draft, setDraft] = useState(expression);
  const cancelled = useRef(false);
  const rule = tryExpressionToRule(draft, id);
  const apply = () => { if (draft.trim()) onApply(draft.trim()); };
  return (
    <div className="mdbase-filter-panel">
      <textarea className="mdbase-field mdbase-filter-code" data-autofocus aria-label={labels.celExpression} rows={2} spellCheck={false} autoComplete="off"
        value={draft} placeholder={EXPRESSION_EXAMPLE}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => { if (commitOnBlur && !cancelled.current && draft.trim() && draft.trim() !== expression.trim()) onApply(draft.trim()); }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); apply(); }
          if (event.key === "Escape") cancelled.current = true;
        }} />
      <div className="mdbase-filter-foot">
        {rule
          ? <button type="button" className="mdbase-button is-tertiary mdbase-filter-convert" onMouseDown={keepFocus} onClick={() => onConvert(rule)}><Glyph name="convert" />{labels.convertToPill}</button>
          : <span className="mdbase-filter-hint">{labels.celHint}</span>}
        <button type="button" className="mdbase-button is-primary" disabled={!draft.trim()} onMouseDown={keepFocus} onClick={apply}>{labels.apply}</button>
      </div>
    </div>
  );
}
