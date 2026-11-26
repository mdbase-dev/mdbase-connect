import { useRef, type JSX, type MouseEvent, type RefObject } from "react";

import { AnchoredPopover } from "../AnchoredPopover.js";
import { Glyph } from "../glyphs.js";
import { AddFilter } from "./AddFilter.js";
import { combinatorHint, describeRule, fieldOf, FX, KIND_ICONS, openPart, useBar, valueText, type BarContext, type Tier } from "./context.js";
import { ExprEditor, ValuePanel } from "./editors.js";
import { isComplete, ruleToExpression, tryExpressionToRule } from "./filter-ast.js";
import { changeOperator, labelOf, operatorLabel, operatorMenu } from "./operators.js";
import { FilterMenu, type FilterMenuItem } from "./menu.js";
import { newId, replaceNode } from "./tree.js";
import type { FilterExpr, FilterGroup, FilterNode, FilterRule } from "./types.js";

interface NodeProps<T extends FilterNode> {
  node: T;
  tier: Tier;
  /** 0 for filters directly on the bar. */
  depth: number;
}

function SharedTag(): JSX.Element {
  const { labels } = useBar();
  return <span className="mdbase-filter-shared" title={labels.sharedHint}>{labels.shared}</span>;
}

/** Edits shared by every pill: replace, remove, and the options menu (field click or right-click). */
function actions(bar: BarContext, tier: Tier, node: FilterNode, depth: number) {
  const { labels } = bar;
  const key = `${tier}:${node.id}`;
  const name = (text: string) => (tier === "shared" ? labels.sharedName(text) : text);
  const replace = (next: FilterNode | null) => bar.edit(tier, tree => replaceNode(tree, node.id, next));
  const remove = () => { replace(null); bar.setOpenKey(null); bar.focusAdd(); };
  const locked = node.kind === "rule" && bar.locked.has(node.field);
  const menu: FilterMenuItem[] = [];
  if (node.kind === "rule" && !locked) {
    menu.push({ label: labels.editAsExpression, icon: FX, onSelect: () => { replace({ kind: "expr", id: node.id, expression: ruleToExpression(node) }); bar.setOpenKey(`${key}:expr`); } });
  }
  if (node.kind === "expr") {
    const rule = tryExpressionToRule(node.expression, node.id);
    if (rule) menu.push({ label: labels.convertToPill, icon: <Glyph name="convert" />, onSelect: () => { replace(rule); bar.setOpenKey(null); bar.focusNode(tier, node.id); } });
  }
  if (node.kind !== "group" && !locked) {
    menu.push({
      label: labels.wrapInOrGroup, icon: <Glyph name="group" />,
      onSelect: () => {
        const group: FilterGroup = { kind: "group", id: newId(), combinator: "any", children: [node] };
        replace(group);
        bar.setOpenKey(`${tier}:${group.id}:add`);
      },
    });
  }
  if (bar.tiered && depth === 0 && !locked) {
    menu.push({ label: tier === "view" ? labels.moveToShared : labels.moveToView, hint: tier === "view" ? labels.moveToSharedHint : undefined, icon: <Glyph name="swap" />, onSelect: () => { bar.setOpenKey(null); bar.move(tier, node.id); } });
  }
  if (!locked) menu.push(...(menu.length ? ["separator" as const] : []), { label: node.kind === "group" ? labels.removeGroup : labels.remove, icon: <Glyph name="remove" />, danger: true, onSelect: remove });
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.length) bar.setOpenKey(`${key}:menu`);
  };
  return { key, name, replace, remove, locked, menu, openMenu };
}

function OptionsMenu({ open, anchor, items, onClose }: { open: boolean; anchor: RefObject<HTMLElement | null>; items: FilterMenuItem[]; onClose: () => void }): JSX.Element {
  const { labels } = useBar();
  return <FilterMenu open={open} anchor={anchor} label={labels.filterOptions} items={items} onClose={onClose} />;
}

export function RulePill({ node: rule, tier, depth }: NodeProps<FilterRule>): JSX.Element {
  const bar = useBar();
  const { labels } = bar;
  const { key, name, replace, remove, locked, menu, openMenu } = actions(bar, tier, rule, depth);
  const part = openPart(bar, key);
  const fieldRef = useRef<HTMLButtonElement>(null);
  const opRef = useRef<HTMLButtonElement>(null);
  const valueRef = useRef<HTMLButtonElement>(null);
  const field = fieldOf(bar.fields, rule);
  const text = valueText(labels, rule);
  const complete = isComplete(rule);
  const toggle = (name: string) => bar.setOpenKey(part === name ? null : `${key}:${name}`);
  const close = () => bar.setOpenKey(null);
  const after = (ref: RefObject<HTMLElement | null>) => { ref.current?.focus(); close(); };
  const context = rule.valueKind === "context" ? bar.contextVars.find(item => item.expr === rule.value) : undefined;

  return (
    <div className="mdbase-filter-pill" role="group" aria-label={name(describeRule(labels, rule, bar.fields))}
      data-key={key} data-shared={tier === "shared" || undefined} data-draft={!complete || undefined} onContextMenu={openMenu}>
      {tier === "shared" && <SharedTag />}
      <span className="mdbase-filter-anchor">
        {locked ? (
          <span className="mdbase-filter-seg mdbase-filter-seg-field" data-locked title={labels.lockedField(labelOf(field))}>{KIND_ICONS[field.kind]}<span className="mdbase-filter-seg-text">{labelOf(field)}</span></span>
        ) : (
          <button ref={fieldRef} type="button" className="mdbase-filter-seg mdbase-filter-seg-field" aria-haspopup="menu" aria-expanded={part === "menu"} title={labels.filterOptions}
            onClick={() => toggle("menu")}>
            {KIND_ICONS[field.kind]}<span className="mdbase-filter-seg-text">{labelOf(field)}</span>
          </button>
        )}
        <OptionsMenu open={part === "menu"} anchor={fieldRef} items={menu} onClose={close} />
      </span>
      <span className="mdbase-filter-anchor">
        <button ref={opRef} type="button" className="mdbase-filter-seg mdbase-filter-seg-op" aria-haspopup="menu" aria-expanded={part === "op"} title={labels.changeOperator} onClick={() => toggle("op")}>
          {operatorLabel(labels, field.kind, rule.op)}
        </button>
        <FilterMenu open={part === "op"} anchor={opRef} label={labels.operator} onClose={close}
          items={operatorMenu(labels, field.kind, rule).map(item => ({
            label: item.label, checked: item.op === rule.op,
            onSelect: () => {
              const next = changeOperator(rule, field, item.op);
              replace(next);
              if (isComplete(next)) after(opRef);
              else bar.setOpenKey(`${key}:value`);
            },
          }))} />
      </span>
      {text !== null && (
        <span className="mdbase-filter-anchor">
          <button ref={valueRef} type="button" className="mdbase-filter-seg mdbase-filter-seg-value" aria-haspopup="dialog" aria-expanded={part === "value"}
            aria-label={complete ? undefined : labels.chooseValue} data-context={context || rule.valueKind === "context" ? true : undefined}
            title={context ? `${context.expr}${context.preview !== undefined ? ` · ${context.preview}` : ""}` : describeRule(labels, rule, bar.fields)} onClick={() => toggle("value")}>
            <span className="mdbase-filter-seg-text">{text}</span>
          </button>
          {part === "value" && (
            <AnchoredPopover anchor={valueRef} label={labels.editValue} className="mdbase-filter-popover mdbase-filter-value-popover" onClose={close}>
              <ValuePanel rule={rule} field={field} contextVars={bar.contextVars} commitOnBlur action={labels.done} onChange={replace} onDone={() => after(valueRef)} />
            </AnchoredPopover>
          )}
        </span>
      )}
      {!locked && <button type="button" className="mdbase-filter-seg mdbase-filter-seg-remove" aria-label={labels.removeFilter} title={labels.removeFilter} onClick={remove}><Glyph name="close" size={12} /></button>}
    </div>
  );
}

export function ExprPill({ node, tier, depth }: NodeProps<FilterExpr>): JSX.Element {
  const bar = useBar();
  const { labels } = bar;
  const { key, name, replace, remove, menu, openMenu } = actions(bar, tier, node, depth);
  const part = openPart(bar, key);
  const codeRef = useRef<HTMLButtonElement>(null);
  const close = () => bar.setOpenKey(null);
  const expression = node.expression.trim();
  return (
    <div className="mdbase-filter-pill is-expression" role="group" aria-label={name(labels.expressionName(expression))}
      data-key={key} data-shared={tier === "shared" || undefined} data-draft={!expression || undefined} onContextMenu={openMenu}>
      {tier === "shared" && <SharedTag />}
      <span className="mdbase-filter-anchor">
        <button ref={codeRef} type="button" className="mdbase-filter-seg mdbase-filter-seg-code" aria-haspopup="dialog" aria-expanded={part === "expr"} title={expression || labels.editExpression}
          onClick={() => bar.setOpenKey(part === "expr" ? null : `${key}:expr`)}>
          {FX}<code>{expression || labels.expression}</code>
        </button>
        {part === "expr" && (
          <AnchoredPopover anchor={codeRef} label={labels.editExpression} className="mdbase-filter-popover mdbase-filter-expression-popover" onClose={close}>
            <ExprEditor expression={node.expression} id={node.id} commitOnBlur
              onApply={text => { replace({ ...node, expression: text }); codeRef.current?.focus(); close(); }}
              onConvert={rule => { replace(rule); close(); bar.focusNode(tier, node.id); }} />
          </AnchoredPopover>
        )}
        <OptionsMenu open={part === "menu"} anchor={codeRef} items={menu} onClose={close} />
      </span>
      <button type="button" className="mdbase-filter-seg mdbase-filter-seg-remove" aria-label={labels.removeFilter} title={labels.removeFilter} onClick={remove}><Glyph name="close" size={12} /></button>
    </div>
  );
}

/** A nested group on the bar: a shaded cluster with its combinator, its own pills, and `+`. */
export function GroupCluster({ node: group, tier, depth, root = false }: NodeProps<FilterGroup> & { root?: boolean }): JSX.Element {
  const bar = useBar();
  const { labels } = bar;
  const { key, name: tiered, replace, remove, menu, openMenu } = actions(bar, tier, group, root ? 1 : depth);
  const part = openPart(bar, key);
  const chipRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const close = () => bar.setOpenKey(null);
  const name = labels[group.combinator];
  return (
    <div className="mdbase-filter-group" role="group" aria-label={tiered(labels.group(name))} data-key={key} data-depth={depth}
      data-shared={tier === "shared" || undefined} onContextMenu={openMenu}>
      {tier === "shared" && <SharedTag />}
      <span className="mdbase-filter-anchor">
        <button ref={chipRef} type="button" className="mdbase-filter-group-chip" aria-haspopup="menu" aria-expanded={part === "combinator"} title={labels.howTheseCombine}
          onClick={() => bar.setOpenKey(part === "combinator" ? null : `${key}:combinator`)}>
          {name}<Glyph name="down" size={11} />
        </button>
        <FilterMenu open={part === "combinator"} anchor={chipRef} label={labels.match} onClose={close}
          items={(["any", "all", "none"] as const).map(combinator => ({
            label: labels[combinator], hint: combinatorHint(labels, combinator), checked: group.combinator === combinator,
            onSelect: () => { replace({ ...group, combinator }); chipRef.current?.focus(); close(); },
          }))} />
        <OptionsMenu open={part === "menu"} anchor={chipRef} items={menu} onClose={close} />
      </span>
      {group.children.map(child => <FilterNodeView key={child.id} node={child} tier={tier} depth={depth + 1} />)}
      <span className="mdbase-filter-anchor">
        <button ref={addRef} type="button" className="mdbase-filter-group-button" aria-label={labels.addFilterToGroup} title={labels.addFilterToGroupHint} aria-haspopup="dialog" aria-expanded={part === "add"}
          onClick={() => bar.setOpenKey(part === "add" ? null : `${key}:add`)}><Glyph name="plus" size={12} /></button>
        {part === "add" && (
          <AnchoredPopover anchor={addRef} label={labels.addFilter} className="mdbase-filter-popover mdbase-filter-command" onClose={close}>
            <AddFilter tier={tier} groupId={group.id} onClose={restore => { if (restore) addRef.current?.focus(); close(); }} />
          </AnchoredPopover>
        )}
      </span>
      <button type="button" className="mdbase-filter-group-button" aria-label={labels.removeGroup} title={labels.removeGroup} onClick={remove}><Glyph name="close" size={12} /></button>
    </div>
  );
}

export function FilterNodeView({ node, tier, depth }: NodeProps<FilterNode>): JSX.Element {
  if (node.kind === "rule") return <RulePill node={node} tier={tier} depth={depth} />;
  if (node.kind === "expr") return <ExprPill node={node} tier={tier} depth={depth} />;
  return <GroupCluster node={node} tier={tier} depth={depth} />;
}
