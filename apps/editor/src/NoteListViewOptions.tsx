import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { CheckIcon as Check, SlidersHorizontalIcon as SlidersHorizontal } from "./icons";
import { Menu, useMenuTrigger } from "@mdbase-dev/ui/menu";
import { noteSortOptions, type NoteSort } from "./note-list-view";
import { command, commandDefinitions } from "./editor-commands";

export function NoteListViewOptions({ sort, scopeLabel, onSort, onClearScope }: {
  sort: NoteSort;
  scopeLabel?: string;
  onSort: (sort: NoteSort) => void;
  onClearScope: () => void;
}) {
  useLingui();
  const { id, open, close, trigger, triggerProps } = useMenuTrigger();

  const select = (action: () => void) => {
    action();
    close(true);
  };

  return <div className="note-view-options">
    <button
      {...triggerProps}
      className="icon-button note-view-options-trigger"
      aria-label={t`View options`}
      title={t`View options`}
    ><SlidersHorizontal aria-hidden="true" /></button>
    <Menu open={open} id={id} label={t`Note view options`} className="mdbase-menu note-view-options-menu" triggerRef={trigger} onClose={close}>
      <p className="view-options-heading"><Trans>Sort</Trans></p>
      {noteSortOptions.map((option) => <button
        key={option.value}
        className="mdbase-menu-item"
        role="menuitemradio"
        aria-checked={sort === option.value}
        onClick={() => select(command(`sort-${option.value}`, () => onSort(option.value)).run)}
      ><span className="view-option-check">{sort === option.value && <Check aria-hidden="true" />}</span><span>{option.label}</span></button>)}
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
    </Menu>
  </div>;
}
