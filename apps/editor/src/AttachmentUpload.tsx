import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { MdbaseFileProgress } from "@mdbase-dev/connect";
import type { ActionMenuItem } from "./ActionMenu";
import { gatewayError } from "./gateway";
import { FilePlusIcon as FilePlus } from "./icons";
import type { FileInventoryController } from "./file-inventory-controller";
import type { CollectionFile, CollectionGateway } from "./model";
import type { NoteSession } from "./note-session";

interface AttachmentUploadState {
  name: string;
  progress?: MdbaseFileProgress;
}

export interface AttachmentUploadController {
  input: React.RefObject<HTMLInputElement | null>;
  upload?: AttachmentUploadState;
  insertion?: { id: number; text: string; block: true };
  attach(files: readonly File[]): Promise<void>;
}

export function useAttachmentUpload(input: {
  gateway: CollectionGateway;
  inventory: FileInventoryController;
  inventoryFiles: readonly CollectionFile[];
  activeSession: () => NoteSession | undefined;
  setNotice: Dispatch<SetStateAction<string | undefined>>;
}): AttachmentUploadController {
  const fileInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const [upload, setUpload] = useState<AttachmentUploadState>();
  const [insertion, setInsertion] = useState<{ id: number; text: string; block: true }>();

  async function attach(files: readonly File[]) {
    const session = input.activeSession();
    if (!session || files.length === 0) return;
    const occupiedPaths = new Set(input.inventoryFiles.map((file) => normalizedFilePath(file.path)));
    const references: string[] = [];
    input.setNotice(undefined);

    for (const source of files) {
      const path = availableAttachmentPath(session.document.path, source.name, occupiedPaths);
      occupiedPaths.add(normalizedFilePath(path));
      setUpload({ name: source.name });
      try {
        const uploaded = await input.gateway.uploadFile(path, source, {
          onProgress: (progress) => setUpload({ name: source.name, progress })
        });
        input.inventory.upsert(uploaded);
        references.push(attachmentReference(uploaded));
      } catch (error) {
        input.setNotice(`Couldn’t attach “${source.name}”. ${gatewayError(error)}`);
        setUpload(undefined);
        return;
      }
    }

    setUpload(undefined);
    if (input.activeSession() !== session || session.deleted) {
      input.setNotice(`${files.length === 1 ? "The file was" : "The files were"} uploaded, but the note changed before its link could be inserted.`);
      return;
    }
    setInsertion({ id: ++sequence.current, text: references.join("\n"), block: true });
    input.setNotice(`${files.length === 1 ? `Uploaded “${files[0]?.name ?? "attachment"}”` : `Uploaded ${files.length.toLocaleString()} files`}. The collection file is committed; the note link is saving separately.`);
  }

  return { input: fileInput, upload, insertion, attach };
}

export function attachmentMenuItem(
  controller: AttachmentUploadController,
  canAttach: boolean,
  requestAccess: () => void
): ActionMenuItem {
  return canAttach ? {
    label: controller.upload ? "Attaching file…" : "Attach file…",
    icon: <FilePlus aria-hidden="true" />,
    disabled: Boolean(controller.upload),
    onSelect: () => controller.input.current?.click()
  } : {
    label: "Request attachment access",
    icon: <FilePlus aria-hidden="true" />,
    onSelect: requestAccess
  };
}

export function AttachmentTransfer({ controller }: { controller: AttachmentUploadController }) {
  return <>
    <input
      ref={controller.input}
      className="attachment-input"
      type="file"
      multiple
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        void controller.attach(files);
      }}
    />
    {controller.upload && <div className="notice attachment-progress" role="status" aria-live="polite">
      <FilePlus aria-hidden="true" />
      <span>{attachmentProgressLabel(controller.upload)}</span>
      {controller.upload.progress && <progress
        max={Math.max(controller.upload.progress.totalBytes, 1)}
        value={controller.upload.progress.transferredBytes}
        aria-label={`Attachment progress for ${controller.upload.name}`}
      />}
    </div>}
  </>;
}

function availableAttachmentPath(notePath: string, sourceName: string, occupied: ReadonlySet<string>): string {
  const folderIndex = notePath.lastIndexOf("/");
  const noteFolder = folderIndex >= 0 ? notePath.slice(0, folderIndex) : "";
  const attachmentFolder = noteFolder ? `${noteFolder}/Attachments` : "Attachments";
  const safeName = safeAttachmentName(sourceName);
  const extensionIndex = safeName.lastIndexOf(".");
  const hasExtension = extensionIndex > 0;
  const stem = hasExtension ? safeName.slice(0, extensionIndex) : safeName;
  const extension = hasExtension ? safeName.slice(extensionIndex) : "";
  let candidate = `${attachmentFolder}/${safeName}`;
  let copy = 2;
  while (occupied.has(normalizedFilePath(candidate))) candidate = `${attachmentFolder}/${stem} (${copy++})${extension}`;
  return candidate;
}

function safeAttachmentName(name: string): string {
  const cleaned = name.normalize("NFC")
    .replace(/[\\/\u0000-\u001f\u007f<>[\]]+/gu, "-")
    .replace(/^\.+|\s+$/gu, "").trim();
  return cleaned || "attachment";
}

function normalizedFilePath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}

function attachmentReference(file: CollectionFile): string {
  const label = file.path.slice(file.path.lastIndexOf("/") + 1).replace(/[\]\\]/gu, "-");
  const mediaType = file.mediaType?.toLocaleLowerCase() ?? "";
  if (mediaType.startsWith("image/")) return `![${label}](<${file.path}>)`;
  if (mediaType === "application/pdf" || mediaType.startsWith("audio/") || mediaType.startsWith("video/")) return `![[${file.path}]]`;
  return `[${label}](<${file.path}>)`;
}

function attachmentProgressLabel(upload: AttachmentUploadState): string {
  if (!upload.progress) return `Preparing “${upload.name}”…`;
  const phase = upload.progress.phase === "hashing" ? "Checking" : upload.progress.phase === "uploading" ? "Uploading" : "Reading";
  const total = upload.progress.totalBytes;
  return total <= 0 ? `${phase} “${upload.name}”…`
    : `${phase} “${upload.name}” · ${Math.min(100, Math.round(upload.progress.transferredBytes / total * 100))}%`;
}
