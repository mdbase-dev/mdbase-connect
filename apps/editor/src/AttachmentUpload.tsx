import { useRef, useState } from "react";
import { MdbaseConnectError, type MdbaseFileProgress } from "@mdbase-dev/connect";
import { trackMdbaseMarkProgress } from "@mdbase-dev/ui/mark-activity";
import type { ActionMenuItem } from "./ActionMenu";
import { FilePlusIcon as FilePlus } from "./icons";
import type { FileInventoryController } from "./file-inventory-controller";
import type { CollectionFile, CollectionGateway } from "./model";
import type { NoteSession } from "./note-session";
import { StaleCollectionOperationError, type CollectionMutationScope } from "./collection-mutation-scope";

export type AttachmentUploader = (file: File) => Promise<string>;

export interface AttachmentUploadFailure {
  message: string;
  retryable: boolean;
}

/** Translate transfer failures, never exposing provider/transport diagnostics in the note. */
export function attachmentUploadFailure(name: string, error: unknown): AttachmentUploadFailure {
  const sdk = error instanceof MdbaseConnectError ? error : undefined;
  const failure = error instanceof Error || error instanceof DOMException ? error : undefined;
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  const diagnostic = [failure?.message ?? "", cause?.message ?? ""].join(" ");
  const status = sdk?.status ?? Number(diagnostic.match(/\bHTTP\s+(\d{3})\b/iu)?.[1]);
  const permanent = (message: string) => ({ message, retryable: false });
  if (status === 413 || /too large|per-file limit|exceed.*(?:size|limit)|size.*exceed/iu.test(diagnostic)) {
    // Current upload errors don't expose a typed byte limit. Use a limit only
    // when the service actually reports it; never assume a collection's quota.
    const amount = "(\\d+(?:\\.\\d+)?\\s*(?:bytes|[KMGT]i?B))";
    const limit = diagnostic.match(new RegExp(`${amount}\\s+(?:(?:file|upload|size)\\s+)?limit`, "iu"))?.[1]
      ?? diagnostic.match(new RegExp(`(?:limit|maximum file size)\\s*(?:of|is|:|=)?\\s*${amount}`, "iu"))?.[1];
    return permanent(limit ? `${name} is larger than the ${limit.trim()} limit.` : `${name} is too large to upload.`);
  }
  if (status === 415 || /(?:unsupported|invalid) (?:media|file|content) type|file type.*not supported/iu.test(diagnostic)) {
    return permanent(`${name} is a file type that can’t be uploaded.`);
  }
  if (sdk?.problem.category === "authorization" || status === 401 || status === 403
      || /permission|not authorized|access denied|forbidden/iu.test(diagnostic)) {
    return permanent(`You don’t have permission to upload ${name}.`);
  }
  // An uncertain mutation outcome must be resolved, not uploaded again.
  if (sdk?.outcomeUnknown) return permanent(`Couldn’t confirm whether ${name} was uploaded. Check the collection’s files before uploading again.`);
  const timedOut = sdk?.code === "timeout" || failure?.name === "TimeoutError"
    || /timed? out|timeout/iu.test(diagnostic);
  const network = /failed to fetch|network(?:error| request| connection| error)|connection (?:lost|reset)/iu.test(diagnostic);
  const retryable = timedOut || network || status === 408 || status === 429 || status >= 500 && status < 600 || Boolean(sdk?.retryable);
  if (timedOut) return { message: `Uploading ${name} took too long. Try again.`, retryable };
  if (network) return { message: `Couldn’t upload ${name}. Check your connection and try again.`, retryable };
  return { message: retryable ? `Couldn’t upload ${name} right now. Try again shortly.` : `Couldn’t upload ${name}.`, retryable };
}

interface AttachmentUploadState {
  name: string;
  progress?: MdbaseFileProgress;
}

export interface AttachmentUploadController {
  input: React.RefObject<HTMLInputElement | null>;
  upload?: AttachmentUploadState;
  insertion?: { id: number; text: string; block: true };
  disabled: boolean;
  attach(files: readonly File[]): Promise<void>;
  uploadReference: AttachmentUploader;
  reset(): void;
}

export function useAttachmentUpload(input: {
  gateway: CollectionGateway;
  inventory: FileInventoryController;
  activeSession: () => NoteSession | undefined;
  scope: CollectionMutationScope;
  setNotice: (message?: string, tone?: "info" | "success" | "error") => void
}): AttachmentUploadController {
  const fileInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  // Reserve across concurrent gestures, not just within one multi-file selection.
  const reservedPaths = useRef(new Set<string>());
  const [upload, setUpload] = useState<AttachmentUploadState>();
  const [insertion, setInsertion] = useState<{ id: number; text: string; block: true }>();

  function attach(files: readonly File[]): Promise<void> {
    if (input.scope.isFrozen) return Promise.resolve();
    const token = input.scope.token();
    return input.scope.register(token, performAttach(files, token));
  }

  async function performAttach(files: readonly File[], token: ReturnType<CollectionMutationScope["token"]>) {
    const session = input.activeSession();
    if (!session || files.length === 0) return;
    const occupiedPaths = reservedPaths.current;
    const references: string[] = [];
    input.setNotice(undefined);
    // The notice that follows plays the mark's saved or error reaction, so the progress ends quietly.
    const markProgress = trackMdbaseMarkProgress();
    try {
      await attachEach(files, session, occupiedPaths, references, token, markProgress.update);
    } finally {
      markProgress.cancel();
    }
  }

  async function attachEach(
    files: readonly File[],
    session: NoteSession,
    occupiedPaths: Set<string>,
    references: string[],
    token: ReturnType<CollectionMutationScope["token"]>,
    reportProgress: (fraction: number) => void
  ) {
    for (const [index, source] of files.entries()) {
      if (!input.scope.isCurrent(token)) return;
      setUpload({ name: source.name });
      try {
        const uploaded = await uploadToCollection(source, session, token, occupiedPaths, {
          onProgress: (progress) => {
            if (!input.scope.isCurrent(token)) return;
            setUpload({ name: source.name, progress });
            if (progress.totalBytes > 0) reportProgress((index + Math.min(1, progress.transferredBytes / progress.totalBytes)) / files.length);
          }
        });
        if (!input.scope.isCurrent(token)) return;
        references.push(attachmentReference(uploaded));
        reportProgress((index + 1) / files.length);
      } catch (error) {
        if (!input.scope.isCurrent(token)) return;
        input.setNotice(attachmentUploadFailure(source.name, error).message);
        setUpload(undefined);
        return;
      }
    }

    setUpload(undefined);
    if (input.activeSession() !== session || session.deleted) {
      input.setNotice(`${files.length === 1 ? "The file was" : "The files were"} uploaded, but the note changed before its link could be inserted.`, "success");
      return;
    }
    setInsertion({ id: ++sequence.current, text: references.join("\n"), block: true });
    input.setNotice(`${files.length === 1 ? `Uploaded “${files[0]?.name ?? "attachment"}”` : `Uploaded ${files.length.toLocaleString()} files`}. The collection file is committed; the note link is saving separately.`, "success");
  }

  function uploadReference(source: File): Promise<string> {
    const transfer = input.scope.run(async (token): Promise<{ reference: string } | { error: unknown }> => {
      const session = input.activeSession();
      if (!session || session.deleted) throw new Error("The note is no longer editable.");
      const markProgress = trackMdbaseMarkProgress();
      try {
        const file = await uploadToCollection(source, session, token, reservedPaths.current, {
          onProgress: (progress) => {
            if (input.scope.isCurrent(token) && progress.totalBytes > 0) {
              markProgress.update(Math.min(1, progress.transferredBytes / progress.totalBytes));
            }
          }
        });
        if (input.activeSession() !== session || session.deleted) {
          throw new Error("The file was uploaded, but the note changed before its link could be inserted.");
        }
        return { reference: attachmentReference(file) };
      } catch (error) {
        // Like menu uploads, a failed attachment must not block collection switching.
        // Publication/errors still belong to this widget, outside the scope's drain.
        return { error };
      } finally {
        markProgress.cancel();
      }
    });
    return transfer.then((outcome) => {
      if ("error" in outcome) throw outcome.error;
      return outcome.reference;
    });
  }

  async function uploadToCollection(
    source: File,
    session: NoteSession,
    token: ReturnType<CollectionMutationScope["token"]>,
    reserved: Set<string>,
    options: { onProgress: (progress: MdbaseFileProgress) => void }
  ): Promise<CollectionFile> {
    const occupied = new Set([...reserved, ...input.inventory.getSnapshot().files.map((file) => normalizedFilePath(file.path))]);
    const path = availableAttachmentPath(session.document.path, source.name, occupied);
    const key = normalizedFilePath(path);
    reserved.add(key);
    try {
      // The gateway/SDK remains the authority for file permissions, sizes and media types.
      const uploaded = await input.gateway.uploadFile(path, source, options);
      if (!input.scope.isCurrent(token)) throw new StaleCollectionOperationError();
      input.inventory.upsert(uploaded);
      return uploaded;
    } finally {
      reserved.delete(key);
    }
  }

  function reset() {
    sequence.current += 1;
    reservedPaths.current = new Set();
    setUpload(undefined);
    setInsertion(undefined);
    if (fileInput.current) fileInput.current.value = "";
  }

  return { input: fileInput, upload, insertion, disabled: input.scope.isFrozen, attach, uploadReference, reset };
}

export function attachmentMenuItem(
  controller: AttachmentUploadController,
  canAttach: boolean,
  requestAccess: () => void
): ActionMenuItem {
  return canAttach ? {
    label: controller.upload ? "Attaching file…" : "Attach file…",
    icon: <FilePlus aria-hidden="true" />,
    disabled: Boolean(controller.upload) || controller.disabled,
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
      disabled={controller.disabled}
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

export function availableAttachmentPath(notePath: string, sourceName: string, occupied: ReadonlySet<string>): string {
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
