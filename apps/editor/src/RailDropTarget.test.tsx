import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLDER_PATH_MIME } from "./folder-change";
import { NOTE_PATHS_MIME } from "./note-list-view";
import { RailDropTarget } from "./RailDropTarget";

function transfer(type: string, value: string) {
  return { types: [type], getData: (key: string) => key === type ? value : "", dropEffect: "none" };
}

afterEach(() => vi.useRealTimers());
describe("rail drop targets", () => {
  it("accepts notes at a folder and at the collection root", () => {
    const move = vi.fn();
    const { rerender } = render(<RailDropTarget folder="Journal" onMoveNotes={move}><button>Target</button></RailDropTarget>);
    const target = screen.getByRole("button").parentElement!;
    const dataTransfer = transfer(NOTE_PATHS_MIME, '["Notes/a.md"]');
    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveClass("drop-ready");
    expect(dataTransfer.dropEffect).toBe("move");
    fireEvent.drop(target, { dataTransfer });
    expect(move).toHaveBeenLastCalledWith(["Notes/a.md"], "Journal");
    expect(target).not.toHaveClass("drop-ready");
    rerender(<RailDropTarget folder="" onMoveNotes={move}><button>Target</button></RailDropTarget>);
    fireEvent.drop(target, { dataTransfer });
    expect(move).toHaveBeenLastCalledWith(["Notes/a.md"], "");
  });
  it("expands after 600ms, cancels on leave and unmount", () => {
    vi.useFakeTimers();
    const expand = vi.fn();
    const { unmount } = render(<RailDropTarget folder="Journal" onMoveNotes={vi.fn()} onExpand={expand}><button>Target</button></RailDropTarget>);
    const target = screen.getByRole("button").parentElement!;
    const dataTransfer = transfer(NOTE_PATHS_MIME, '["Notes/a.md"]');
    fireEvent.dragOver(target, { dataTransfer });
    act(() => vi.advanceTimersByTime(599)); expect(expand).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1)); expect(expand).toHaveBeenCalledTimes(1);
    fireEvent.dragLeave(target);
    expect(target).not.toHaveClass("drop-ready");
    fireEvent.dragOver(target, { dataTransfer });
    unmount(); act(() => vi.advanceTimersByTime(600));
    expect(expand).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed payloads and recursive folder moves", () => {
    const moveNotes = vi.fn(), moveFolder = vi.fn();
    render(<RailDropTarget folder="Journal/Child" onMoveNotes={moveNotes} onMoveFolder={moveFolder}><button>Target</button></RailDropTarget>);
    const target = screen.getByRole("button").parentElement!;
    fireEvent.drop(target, { dataTransfer: transfer(NOTE_PATHS_MIME, '{}') });
    fireEvent.drop(target, { dataTransfer: transfer(FOLDER_PATH_MIME, 'Journal') });
    expect(moveNotes).not.toHaveBeenCalled(); expect(moveFolder).not.toHaveBeenCalled();
    fireEvent.drop(target, { dataTransfer: transfer(FOLDER_PATH_MIME, 'Notes') });
    expect(moveFolder).toHaveBeenCalledWith('Notes', 'Journal/Child');
  });
});
