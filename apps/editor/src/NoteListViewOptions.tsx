import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { CheckIcon as Check, SlidersHorizontalIcon as SlidersHorizontal } from "./icons";
import { Menu, useMenuTrigger } from "@mdbase-dev/ui/menu";
import { defaultSortDirection, noteSortDirections, noteSortKey, noteSortOptions, type NoteSort, type NoteSortPreference, type SortField } from "./note-sort";
import { command, commandDefinitions } from "./editor-commands";

export function NoteListViewOptions({ sort, fields, scopeLabel, compact, onSort, onClearScope, onCompact }: {
  sort: NoteSort;
  fields: readonly SortField[];
  scopeLabel?: string;
  compact: boolean;
  onSort: (sort: NoteSortPreference) => void;
  onClearScope: () => void;
  onCompact?: (compact: boolean) => void;
}) {
  useLingui();
  const { id, open, close, trigger, triggerProps } = useMenuTrigger();

  const select = (action: () => void) => {
    action();
    close(true);
  };

  const activeKey = noteSortKey(sort);
  const options = noteSortOptions(fields);
  const sortOption = (option: { key: string; label: string }) => <button
    key={option.key}
    className="mdbase-menu-item"
    role="menuitemradio"
    aria-checked={activeKey === option.key}
    onClick={() => select(() => onSort({ key: option.key, direction: defaultSortDirection(option.key) }))}
  ><span className="view-option-check">{activeKey === option.key && <Check aria-hidden="true" />}</span><span className="view-option-label">{option.label}</span></button>;

  return <div className="note-view-options">
    <button
      {...triggerProps}
      className="icon-button note-view-options-trigger"
      aria-label={t`View options`}
      title={t`View options`}
    ><SlidersHorizontal aria-hidden="true" /></button>
    <Menu open={open} id={id} label={t`Note view options`} className="mdbase-menu note-view-options-menu" triggerRef={trigger} onClose={close}>
      <p className="view-options-heading"><Trans>Sort</Trans></p>
      {options.properties.map(sortOption)}
      {options.fields.length > 0 && <>
        <p className="view-options-heading"><Trans>Fields</Trans></p>
        <div className="view-options-fields">{options.fields.map(sortOption)}</div>
      </>}
      <div className="view-options-divider" role="separator" />
      <p className="view-options-heading"><Trans>Order</Trans></p>
      {noteSortDirections(sort).map((option) => <button
        key={option.direction}
        className="mdbase-menu-item"
        role="menuitemradio"
        aria-checked={sort.direction === option.direction}
        onClick={() => select(() => onSort({ key: activeKey, direction: option.direction }))}
      ><span className="view-option-check">{sort.direction === option.direction && <Check aria-hidden="true" />}</span><span>{option.label}</span></button>)}
      <div className="view-options-divider" role="separator" />
      <p className="view-options-heading"><Trans>Scope</Trans></p>
      {scopeLabel && <button
        className="mdbase-menu-item"
        role="menuitemradio"
        aria-checked="true"
        title={scopeLabel}
        onClick={() => select(() => undefined)}
      ><span className="view-option-check"><Check aria-hidden="true" /></span><span className="view-option-label">{scopeLabel}</span></button>}
      <button
        className="mdbase-menu-item"
        role="menuitemradio"
        aria-checked={!scopeLabel}
        onClick={() => select(command("clear-filter", onClearScope).run)}
      ><span className="view-option-check">{!scopeLabel && <Check aria-hidden="true" />}</span><span>{commandDefinitions["clear-filter"].label}</span></button>
      {onCompact && <>
        <div className="view-options-divider" role="separator" />
        <p className="view-options-heading"><Trans>Display</Trans></p>
        <button
          className="mdbase-menu-item"
          role="menuitemcheckbox"
          aria-checked={compact}
          onClick={() => select(() => onCompact(!compact))}
        ><span className="view-option-check">{compact && <Check aria-hidden="true" />}</span><span><Trans>Compact</Trans></span></button>
      </>}
    </Menu>
  </div>;
}
