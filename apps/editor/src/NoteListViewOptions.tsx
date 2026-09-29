import { CheckIcon as Check, SlidersHorizontalIcon as SlidersHorizontal } from "./icons";
import { MenuPopover, useMenuTrigger } from "./ActionMenu";
import { noteSortOptions, type NoteSort } from "./note-list-view";

export function NoteListViewOptions({ sort, scopeLabel, onSort, onClearScope }: {
  sort: NoteSort;
  scopeLabel?: string;
  onSort: (sort: NoteSort) => void;
  onClearScope: () => void;
}) {
  const { open, close, trigger, triggerProps } = useMenuTrigger();

  const select = (action: () => void) => {
    action();
    close(true);
  };

  return <div className="note-view-options">
    <button
      {...triggerProps}
      className="icon-button note-view-options-trigger"
      aria-label="View options"
      title="View options"
    ><SlidersHorizontal aria-hidden="true" /></button>
    {open && <MenuPopover label="Note view options" className="note-view-options-menu" triggerRef={trigger} onClose={close}>
      <p className="view-options-heading">Sort</p>
      {noteSortOptions.map((option) => <button
        key={option.value}
        role="menuitemradio"
        aria-checked={sort === option.value}
        onClick={() => select(() => onSort(option.value))}
      ><span className="view-option-check">{sort === option.value && <Check aria-hidden="true" />}</span><span>{option.label}</span></button>)}
      <div className="view-options-divider" role="separator" />
      <p className="view-options-heading">Scope</p>
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
      ><span className="view-option-check">{!scopeLabel && <Check aria-hidden="true" />}</span><span>All notes</span></button>
    </MenuPopover>}
  </div>;
}
