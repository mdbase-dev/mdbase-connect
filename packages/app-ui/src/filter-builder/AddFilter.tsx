import { Fragment, useId, useLayoutEffect, useRef, useState, type JSX, type MouseEvent, type ReactNode } from "react";

import { Glyph } from "../glyphs.js";
import { Segmented } from "../Segmented.js";
import { Select } from "../Select.js";
import { isComplete } from "./filter-ast.js";
import { fieldOf, FX, KIND_ICONS, useBar, type Tier } from "./context.js";
import { ExprEditor, ValuePanel } from "./editors.js";
import { changeOperator, defaultOperator, labelOf, operatorMenu, UNARY } from "./operators.js";
import { findNode, newId, replaceNode, upsertChild } from "./tree.js";
import type { FilterFieldSpec, FilterNode, FilterOperator, FilterRule } from "./types.js";

export interface AddFilterProps {
  tier: Tier;
  /** The group new filters join; null for the root of the chosen scope. */
  groupId: string | null;
  onClose: (restoreFocus: boolean) => void;
}

type Step = { step: "pick" } | { step: "rule"; rule: FilterRule; inserted: boolean } | { step: "expr"; id: string };
type Option = { id: string; label: string; icon: ReactNode; hint?: string; pick: () => void };

const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * What `Filter` opens: a list of fields to search, then (in place) the value for the field
 * picked. A checked value applies at once; a typed one on Enter or its button.
 */
export function AddFilter({ tier, groupId, onClose }: AddFilterProps): JSX.Element {
  const bar = useBar();
  const { labels } = bar;
  const ids = useId();
  const [scope, setScope] = useState<Tier>(tier);
  const [state, setState] = useState<Step>({ step: "pick" });
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const target = groupId ? tier : scope;
  const step = useRef<HTMLDivElement>(null);
  // Each step puts the keyboard where the next thing is typed or chosen: after a field is
  // picked, in its value; after the comparison changes, in the value again.
  const stage = state.step === "rule" ? `rule:${state.rule.field}:${state.rule.op}` : state.step;
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      // The popover places the focus when it opens.
      first.current = false;
      return;
    }
    step.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [stage]);

  const put = (node: FilterNode) => bar.edit(target, tree => upsertChild(tree, groupId ?? tree.id, node));
  const drop = (id: string) => bar.edit(target, tree => replaceNode(tree, id, null));
  const apply = (rule: FilterRule, inserted: boolean) => {
    const complete = isComplete(rule);
    if (complete) put(rule);
    else if (inserted) drop(rule.id);
    setState({ step: "rule", rule, inserted: complete });
  };

  if (state.step === "rule") {
    const { rule, inserted } = state;
    const field = fieldOf(bar.fields, rule);
    const pickOp = (op: FilterOperator) => {
      const next = changeOperator(rule, field, op);
      apply(next, inserted);
      if (UNARY.has(op)) onClose(true);
    };
    return (
      <div className="mdbase-filter-step" ref={step}>
        <div className="mdbase-filter-step-head">
          <button type="button" className="mdbase-filter-icon-button" aria-label={labels.back} onClick={() => { if (inserted) drop(rule.id); setState({ step: "pick" }); }}><Glyph name="left" /></button>
          <span className="mdbase-filter-step-field" title={labelOf(field)}>{KIND_ICONS[field.kind]}<span>{labelOf(field)}</span></span>
          <Select className="is-compact mdbase-filter-operator" aria-label={labels.operator} value={rule.op}
            options={operatorMenu(labels, field.kind, rule).map(item => ({ value: item.op, label: item.label }))}
            onChange={op => pickOp(op as FilterOperator)} />
        </div>
        {!UNARY.has(rule.op) && (
          <ValuePanel rule={rule} field={field} contextVars={bar.contextVars} commitOnBlur={false} action={labels.addFilter}
            onChange={next => apply(next, inserted)} onDone={() => onClose(true)} />
        )}
      </div>
    );
  }

  if (state.step === "expr") {
    const { id } = state;
    return (
      <div className="mdbase-filter-step" ref={step}>
        <div className="mdbase-filter-step-head">
          <button type="button" className="mdbase-filter-icon-button" aria-label={labels.back} onClick={() => setState({ step: "pick" })}><Glyph name="left" /></button>
          <span className="mdbase-filter-step-field">{FX}<span>{labels.customExpression}</span></span>
        </div>
        <ExprEditor expression="" id={id} commitOnBlur={false}
          onApply={expression => { put({ kind: "expr", id, expression }); onClose(true); }}
          onConvert={rule => { put(rule); onClose(true); }} />
      </div>
    );
  }

  const needle = search.trim().toLowerCase();
  const fields = bar.fields.filter(field => !bar.locked.has(field.key)
    && (!needle || labelOf(field).toLowerCase().includes(needle) || field.key.toLowerCase().includes(needle)));
  const startRule = (field: FilterFieldSpec) => setState({ step: "rule", inserted: false, rule: { kind: "rule", id: newId(), field: field.key, op: defaultOperator(field.kind) } });
  const parent = groupId ? findNode(bar.trees[target], groupId) : null;
  const options: Option[] = [
    ...fields.map(field => ({ id: `${ids}f-${field.key}`, label: labelOf(field), icon: KIND_ICONS[field.kind], pick: () => startRule(field) })),
    { id: `${ids}expr`, label: labels.customExpression, icon: FX, hint: "CEL", pick: () => setState({ step: "expr", id: newId() }) },
    {
      id: `${ids}group`, label: labels.filterGroup, icon: <Glyph name="group" />, hint: labels.filterGroupHint,
      pick: () => {
        const group: FilterNode = { kind: "group", id: newId(), combinator: parent?.kind === "group" && parent.combinator === "any" ? "all" : "any", children: [] };
        put(group);
        bar.setOpenKey(`${target}:${group.id}:add`);
      },
    },
  ];
  const current = Math.min(active, options.length - 1);
  // The list always ends with the expression and group rows, so it is never empty.
  const option = options[current]!;

  return (
    <div className="mdbase-filter-step" ref={step}>
      <div className="mdbase-filter-search">
        <Glyph name="search" />
        <input data-autofocus role="combobox" aria-label={labels.filterByField} aria-expanded aria-controls={`${ids}list`} aria-autocomplete="list"
          aria-activedescendant={option.id} placeholder={labels.filterByPlaceholder} spellCheck={false} autoComplete="off" value={search}
          onChange={event => { setSearch(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
            }
            if (event.key === "Enter") { event.preventDefault(); option.pick(); }
          }} />
      </div>
      <div className="mdbase-filter-options" role="listbox" id={`${ids}list`} aria-label={labels.fields}>
        {options.map((option, index) => (
          <Fragment key={option.id}>
            {index === fields.length && (
              <>
                {!fields.length && <p className="mdbase-filter-hint mdbase-filter-empty">{labels.noMatchingFields}</p>}
                <div className="mdbase-menu-divider" role="separator" />
              </>
            )}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- keys reach options through the search field. */}
            <div id={option.id} role="option" aria-selected={index === current} className="mdbase-filter-option"
              onMouseDown={keepFocus} onMouseMove={() => setActive(index)} onClick={option.pick}>
              {option.icon}<span className="mdbase-filter-option-label">{option.label}</span>{option.hint && <span className="mdbase-filter-hint">{option.hint}</span>}
            </div>
          </Fragment>
        ))}
      </div>
      {!groupId && bar.tiered && (
        <div className="mdbase-filter-scope">
          <span>{labels.scope}</span>
          <Segmented aria-label={labels.scope} value={scope} options={[{ value: "view", label: labels.thisView }, { value: "shared", label: labels.shared }]}
            onChange={next => { setScope(next); step.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true }); }} />
        </div>
      )}
    </div>
  );
}
