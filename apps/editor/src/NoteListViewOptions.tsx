import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { CheckIcon as Check, SlidersHorizontalIcon as SlidersHorizontal } from "./icons";
import { MenuPopover, useMenuTrigger } from "./ActionMenu";
import { defaultSortDirection, noteSortDirections, noteSortKey, noteSortOptions, type NoteSort, type NoteSortPreference, type SortField } from "./note-sort";

export function NoteListViewOptions({ sort, fields, scopeLabel, onSort, onClearScope }: {
  sort: NoteSort;
  fields: readonly SortField[];
  scopeLabel?: string;
  onSort: (sort: NoteSortPreference) => void;
  onClearScope: () => void;
}) {
  useLingui();
  const { open, close, trigger, triggerProps } = useMenuTrigger();

  const select = (action: () => void) => {
    action();
    close(true);
  };

  const activeKey = noteSortKey(sort);
  const options = noteSortOptions(fields);
  const sortOption = (option: { key: string; label: string }) => <button
    key={option.key}
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
    {open && <MenuPopover label={t`Note view options`} className="note-view-options-menu" triggerRef={trigger} onClose={close}>
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
        role="menuitemradio"
        aria-checked={sort.direction === option.direction}
        onClick={() => select(() => onSort({ key: activeKey, direction: option.direction }))}
      ><span className="view-option-check">{sort.direction === option.direction && <Check aria-hidden="true" />}</span><span>{option.label}</span></button>)}
      <div className="view-options-divider" role="separator" />
      <p className="view-options-heading"><Trans>Scope</Trans></p>
      {scopeLabel && <button
        role="menuitemradio"
        aria-checked="true"
        title={scopeLabel}
        onClick={() => select(() => undefined)}
      ><span className="view-option-check"><Check aria-hidden="true" /></span><span className="view-option-label">{scopeLabel}</span></button>}
      <button
        role="menuitemradio"
        aria-checked={!scopeLabel}
        onClick={() => select(onClearScope)}
      ><span className="view-option-check">{!scopeLabel && <Check aria-hidden="true" />}</span><span><Trans>All notes</Trans></span></button>
    </MenuPopover>}
  </div>;
}
