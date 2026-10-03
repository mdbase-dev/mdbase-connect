import { useEffect, useRef, useState, type ReactNode } from "react";
import { FOLDER_PATH_MIME, readNoteDragPaths, validFolderPath } from "./folder-change";
import { NOTE_PATHS_MIME } from "./note-list-view";

export interface RailDropActions {
  onMoveNotes?: (paths: string[], folder: string) => void;
  onMoveFolder?: (from: string, parent: string) => void;
}

export function RailDropTarget({ folder, onMoveNotes, onMoveFolder, onExpand, onRename, children }: RailDropActions & {
  folder: string;
  onExpand?: () => void;
  onRename?: () => void;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => { clearTimeout(expandTimer.current); expandTimer.current = undefined; setHover(false); };
  useEffect(() => () => clearTimeout(expandTimer.current), []);
  const accepts = (types: readonly string[]) => (onMoveNotes && types.includes(NOTE_PATHS_MIME)) || (onMoveFolder && types.includes(FOLDER_PATH_MIME));
  return <div className={`rail-drop-target${hover ? " drop-ready" : ""}`}
    onKeyDown={(event) => { if (event.key === "F2" && onRename) { event.preventDefault(); onRename(); } }}
    onDragOver={(event) => {
      if (!accepts([...event.dataTransfer.types])) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
      setHover(true);
      if (onExpand && !expandTimer.current) expandTimer.current = setTimeout(onExpand, 600);
    }}
    onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) clear(); }}
    onDrop={(event) => {
      if (!accepts([...event.dataTransfer.types])) return;
      event.preventDefault(); event.stopPropagation(); clear();
      const from = event.dataTransfer.getData(FOLDER_PATH_MIME);
      if (from && validFolderPath(from)) { if (from !== folder && !folder.startsWith(`${from}/`)) onMoveFolder?.(from, folder); return; }
      const paths = readNoteDragPaths(event.dataTransfer.getData(NOTE_PATHS_MIME));
      if (paths.length) onMoveNotes?.(paths, folder);
    }}
    onDragEnd={clear}
  >{children}{hover && <span className="rail-drop-hint" aria-hidden="true">Move here</span>}</div>;
}
