import { useRef, useState, type RefObject } from "react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { bulkFields, bulkFrontmatter, runNoteBatch, type BatchResult, type BulkPropertyChange } from "./bulk-note-actions";
import type { CollectionIndexController } from "./collection-index-controller";
import { StaleCollectionOperationError, type CollectionMutationScope, type CollectionScopeToken } from "./collection-mutation-scope";
import { gatewayError } from "./gateway";
import type { CollectionGateway, CollectionFile, NoteDocument, NoteSummary } from "./model";
import { noteTitle, safeRenamePath, summaryFromDocument } from "./note";
import type { NoteSession, NoteSessionStore, Draft, NoteActivity } from "./note-session";
import { updateMutationActivity } from "./note-mutation-presentation";
import { pendingNoteRequestId, type RenamePlan, type PendingRenameRecovery } from "./pending-note-mutation";
import { composeRecordSource, replaceDocumentFrontmatter } from "./record-source";
import { forgetRecentPath, rememberRecentPath } from "./recent-notes";
import { linkMention, type UnlinkedMention } from "./unlinked-mentions";

interface Options {
  gateway: CollectionGateway;
  mutationScope: RefObject<CollectionMutationScope>;
  noteSessions: RefObject<NoteSessionStore>;
  indexController: CollectionIndexController;
  allNotes: NoteSummary[];
  files: CollectionFile[];
  typeDescriptors: CollectionTypeDescriptor[];
  document?: NoteDocument;
  pathDraft: string;
  canCreateNotes: boolean;
  canEditNotes: boolean;
  canRenameNotes: boolean;
  canDeleteNotes: boolean;
  createSession(document: NoteDocument): NoteSession;
  flushSession(session: NoteSession): Promise<void>;
  runNoteOperation<Value>(session: NoteSession, activity: NoteActivity, operation: (token: CollectionScopeToken) => Promise<Value>): Promise<Value>;
  touchSession(session: NoteSession): void;
  updateNoteSummary(document: NoteDocument, previousPath?: string): void;
  refreshCachedNote(path: string): Promise<void>;
  openNote(path: string): Promise<boolean>;
  navigateToNote(path: string): void;
  replaceNoteHistoryPath(from: string, to: string): void;
  forgetNoteHistoryPath(path: string): void;
  remapPin(from: string, to: string): void;
  clearSelection(): void;
  setDocument(document?: NoteDocument): void;
  setDraft(draft?: Draft): void;
  setSelectedPath(path?: string): void;
  setPathDraft(path: string): void;
  setEditingPath(editing: boolean): void;
  setRenamePlan(plan?: RenamePlan): void;
  setRecentPaths(change: (current: string[]) => string[]): void;
  setNotice(message?: string, tone?: "info" | "success" | "error"): void;
}

type BatchUndo = { kind: "delete"; document: NoteDocument } | { kind: "properties"; document: NoteDocument; revision: string };

type RecoveryAction =
  | { kind: "mention"; path: string; before: string; after: string }
  | { kind: "batch"; changes: BatchUndo[]; message: string }
  | { kind: "delete"; document: NoteDocument }
  | { kind: "rename"; from: string; to: string }
  | { kind: "move"; paths: Array<{ from: string; to: string }>; references: number; message?: string };

function batchMessage<Value>(verb: string, result: BatchResult<Value>): string {
  const count = result.succeeded.length;
  const failures = result.failed.length ? ` ${result.failed.length} couldn’t be changed: ${result.failed.map(({ path, error }) => `${path} — ${gatewayError(error)}`).join("; ")}` : "";
  return `${verb} ${count} ${count === 1 ? "note" : "notes"}.${failures}`;
}

/** Coordinates explicit note actions through the existing collection scope and session queue.
 * This owns transient action/Undo state, not record documents, navigation or a second write pipeline. */
export function useNoteActions({ gateway, mutationScope, noteSessions, indexController, allNotes, files,
  typeDescriptors, document, pathDraft, canCreateNotes, canEditNotes, canRenameNotes, canDeleteNotes,
  createSession, flushSession, runNoteOperation, touchSession, updateNoteSummary, refreshCachedNote,
  openNote, navigateToNote, replaceNoteHistoryPath, forgetNoteHistoryPath, remapPin, clearSelection,
  setDocument, setDraft, setSelectedPath, setPathDraft, setEditingPath, setRenamePlan, setRecentPaths,
  setNotice }: Options) {
  const [bulkBusy, setBulkBusy] = useState(false);
  const batchRunning = useRef(false);
  const [propertiesError, setPropertiesError] = useState<string>();
  const [pendingRenameRecovery, setPendingRenameRecovery] = useState<PendingRenameRecovery>();
  const [recoveryAction, setRecoveryAction] = useState<RecoveryAction>();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [linkingMention, setLinkingMention] = useState(false);
  const mentionRequest = useRef(false);
  const renameRequest = useRef<string | undefined>(undefined);
  const deleteRequests = useRef(new Set<string>());

  async function actionSession(path: string): Promise<NoteSession> {
    const token = mutationScope.current.token();
    const cached = noteSessions.current.get(path);
    if (cached?.recoveryDraft) throw new Error("Recover the unsaved edits in this note before changing it.");
    if (cached && !cached.deleted) return cached;
    const next = await mutationScope.current.register(token, gateway.read(path));
    if (!mutationScope.current.isCurrent(token)) throw new StaleCollectionOperationError();
    updateNoteSummary(next);
    return createSession(next);
  }

  async function renameNote(path: string) {
    if (!canRenameNotes || mutationScope.current.isFrozen) return;
    if (await openNote(path)) { setPathDraft(path); setEditingPath(true); }
  }

  async function duplicateNote(path: string) {
    if (!canCreateNotes || mutationScope.current.isFrozen) return;
    const token = mutationScope.current.token();
    try {
      const session = await actionSession(path);
      await flushSession(session);
      if (!mutationScope.current.isCurrent(token)) return;
      const stem = path.replace(/\.md$/i, "");
      const occupied = new Set([...allNotes.map((note) => note.path), ...files.map((file) => file.path)]);
      let nextPath = `${stem} copy.md`;
      for (let suffix = 2; occupied.has(nextPath); suffix += 1) nextPath = `${stem} copy ${suffix}.md`;
      const duplicated = await mutationScope.current.register(token, gateway.restore({ ...session.document, path: nextPath }));
      if (!mutationScope.current.isCurrent(token)) return;
      createSession(duplicated);
      indexController.create(summaryFromDocument(duplicated));
      navigateToNote(duplicated.path);
      setNotice("Duplicated note.", "success");
    } catch (error) { if (mutationScope.current.isCurrent(token)) setNotice(`Couldn’t duplicate note. ${gatewayError(error)}`); }
  }

  async function linkUnlinkedMention(mention: UnlinkedMention) {
    if (!document || !canEditNotes || mutationScope.current.isFrozen || mentionRequest.current) return;
    const target = document.path;
    const token = mutationScope.current.token();
    mentionRequest.current = true;
    setLinkingMention(true);
    try {
      const session = await actionSession(mention.note.path);
      await flushSession(session);
      const linked = await runNoteOperation(session, "saving", async () => {
        const before = session.document.body ?? "";
        const next = linkMention(mention, target, before);
        const updated = await gateway.update(session.document, { body: next.body });
        if (!mutationScope.current.isCurrent(token)) throw new StaleCollectionOperationError();
        session.record.accept(updated);
        return { before, after: next.body };
      });
      if (!mutationScope.current.isCurrent(token)) return;
      setRecoveryAction({ kind: "mention", path: mention.note.path, ...linked });
      touchSession(session);
    } catch (error) { if (mutationScope.current.isCurrent(token)) setNotice(`Couldn’t link that mention. ${gatewayError(error)}`); }
    finally { mentionRequest.current = false; if (mutationScope.current.isCurrent(token)) setLinkingMention(false); }
  }

  async function executeBatch<Value>(paths: string[], operation: (path: string) => Promise<Value | undefined>, completed: (result: BatchResult<Value>) => void) {
    if (batchRunning.current || recoveryBusy || mutationScope.current.isFrozen) return;
    const token = mutationScope.current.token();
    batchRunning.current = true; setBulkBusy(true); setNotice(undefined); setRecoveryAction(undefined);
    try {
      const result = await mutationScope.current.register(token, runNoteBatch(paths, async (path) => {
        if (!mutationScope.current.isCurrent(token)) throw new StaleCollectionOperationError();
        return operation(path);
      }));
      if (mutationScope.current.isCurrent(token)) { setNotice(undefined); completed(result); }
    } finally {
      batchRunning.current = false;
      if (mutationScope.current.isCurrent(token)) setBulkBusy(false);
    }
  }

  function completePropertyBatch(verb: string, result: BatchResult<BatchUndo>) {
    const message = batchMessage(verb, result);
    if (result.succeeded.length) setRecoveryAction({ kind: "batch", changes: result.succeeded.map(({ value }) => value), message });
    else setNotice(message, result.failed.length ? "error" : "info");
  }

  async function applyBulkProperties(paths: string[], change: BulkPropertyChange) {
    if (!canEditNotes) return;
    await executeBatch<BatchUndo>(paths, async (path) => {
      const session = await actionSession(path);
      await flushSession(session);
      const before = structuredClone(session.document);
      if (change.kind === "property" && !bulkFields([before], typeDescriptors).some((field) => field.name === change.field && field.shared)) throw new Error("This property is not declared by the note’s type.");
      const next = bulkFrontmatter(before, change);
      if (JSON.stringify(next) === JSON.stringify(before.frontmatter)) return;
      const token = mutationScope.current.token();
      const updated = await runNoteOperation(session, "properties", () => gateway.updateDocument(path,
        replaceDocumentFrontmatter(before.document ?? composeRecordSource(before.frontmatter, before.body ?? ""), next), before.revision));
      if (!mutationScope.current.isCurrent(token)) throw new StaleCollectionOperationError();
      session.record.accept(updated); session.error = undefined; touchSession(session);
      return { kind: "properties", document: before, revision: updated.revision };
    }, (result) => completePropertyBatch("Updated", result));
  }

  async function deleteSelectedNotes(paths: string[]) {
    if (!canDeleteNotes) return;
    await executeBatch<BatchUndo>(paths, async (path) => {
      const session = await actionSession(path);
      await flushSession(session);
      const deleted = await deleteNote(session, false);
      return deleted ? { kind: "delete", document: deleted } : undefined;
    }, (result) => { completePropertyBatch("Deleted", result); clearSelection(); });
  }

  async function onMoveNotes(paths: string[], folder: string) {
    if (!canRenameNotes) return;
    const destination = folder ? safeRenamePath(folder) : "";
    if (folder && !destination) { setNotice("Choose a collection-relative folder."); return; }
    let references = 0;
    await executeBatch(paths, async (path) => {
      const to = [destination, path.split("/").at(-1)!].filter(Boolean).join("/");
      if (to === path) return;
      const session = await actionSession(path);
      await flushSession(session);
      // An earlier move can rewrite this note's links and advance its revision.
      await refreshCachedNote(path);
      const preflight = await runNoteOperation(session, "validating", () => gateway.preflightRename(path, to, session.document.revision));
      const renamed = await performRename({ session, from: path, to, affectedPaths: preflight.affectedPaths, warnings: preflight.warnings }, true, undefined, false);
      if (!renamed) throw new Error("The move did not complete.");
      references += preflight.affectedPaths.length;
      return { from: path, to: renamed.path };
    }, (result) => {
      const message = `${batchMessage("Moved", result)}${references ? ` Also updated links in ${references} ${references === 1 ? "note" : "notes"}.` : ""}`;
      if (result.succeeded.length) setRecoveryAction({ kind: "move", paths: result.succeeded.map(({ value }) => value), references, message });
      else setNotice(message, result.failed.length ? "error" : "info");
      clearSelection();
    });
  }

  async function requestRename() {
    if (mutationScope.current.isFrozen || !canRenameNotes) return;
    const token = mutationScope.current.token();
    const session = noteSessions.current.active;
    if (!session) return;
    const nextPath = safeRenamePath(pathDraft);
    if (!nextPath || !nextPath.toLocaleLowerCase().endsWith(".md")) {
      setNotice("Use a collection-relative path ending in .md.");
      return;
    }
    if (nextPath === session.document.path) {
      setEditingPath(false);
      return;
    }
    setEditingPath(false);
    const requestKey = `${session.document.path}\n${nextPath}`;
    if (renameRequest.current === requestKey) return;
    renameRequest.current = requestKey;
    try {
      const from = session.document.path;
      await flushSession(session);
      if (session.document.path !== from) {
        throw new Error("This note moved before the rename check could begin.");
      }
      const preflight = await runNoteOperation(session, "validating", () => gateway.preflightRename(
        from,
        nextPath,
        session.document.revision
      ));
      if (!mutationScope.current.isCurrent(token)) return;
      if (noteSessions.current.active !== session) {
        renameRequest.current = undefined;
        return;
      }
      const plan: RenamePlan = {
        session,
        from,
        to: nextPath,
        affectedPaths: preflight.affectedPaths,
        warnings: preflight.warnings
      };
      if (plan.affectedPaths.length > 0 || plan.warnings.length > 0) {
        setRenamePlan(plan);
        return;
      }
      await performRename(plan, true);
    } catch (error) {
      if (!mutationScope.current.isCurrent(token)) return;
      const message = gatewayError(error);
      session.error = message;
      if (noteSessions.current.active === session) setPathDraft(session.document.path);
      setNotice(noteSessions.current.active === session
        ? message
        : `Couldn’t check the rename for “${session.draft.title || session.document.path}”. ${message}`);
      renameRequest.current = undefined;
      touchSession(session);
    }
  }

  async function performRename(plan: RenamePlan, updateRefs: boolean, requestId?: string, reportUndo = true) {
    if (mutationScope.current.isFrozen) return;
    const token = mutationScope.current.token();
    const { session, from, to } = plan;
    const controller = new AbortController();
    setRenamePlan(undefined);
    session.mutationController = controller;
    session.mutationCancellable = false;
    touchSession(session);
    try {
      if (!requestId) {
        await flushSession(session);
        if (session.document.path !== from) throw new Error("This note moved before the rename could begin.");
      }
      const renamed = await runNoteOperation(session, updateRefs ? "renaming" : "moving", (token) => requestId
        ? gateway.recoverNoteMutation(requestId)
        : gateway.rename(
        from,
        to,
        session.document.revision,
        updateRefs,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (mutationScope.current.isCurrent(token)) updateMutationActivity(session, progress, touchSession);
          }
        }
      ));
      if (!mutationScope.current.isCurrent(token)) return;
      setPendingRenameRecovery(undefined);
      session.record.accept(renamed);
      session.error = undefined;
      noteSessions.current.move(from, renamed.path, session);
      updateNoteSummary(renamed, from);
      if (noteSessions.current.active === session) {
        setDocument(renamed);
        setSelectedPath(renamed.path);
        setPathDraft(renamed.path);
        localStorage.setItem("mdbase-editor:last-note", renamed.path);
      }
      setRecentPaths((current) => rememberRecentPath(forgetRecentPath(current, from), renamed.path));
      replaceNoteHistoryPath(from, renamed.path);
      if (reportUndo) setRecoveryAction({ kind: "rename", from, to: renamed.path });
      remapPin(from, renamed.path);
      touchSession(session);
      return renamed;
    } catch (error) {
      if (!mutationScope.current.isCurrent(token)) return;
      const message = gatewayError(error);
      session.error = message;
      const interruptedRequestId = requestId ?? pendingNoteRequestId(error);
      if (interruptedRequestId) {
        setPendingRenameRecovery({ plan, updateRefs, requestId: interruptedRequestId });
        if (noteSessions.current.active === session) {
          setPathDraft(to);
          setEditingPath(true);
        }
      } else if (noteSessions.current.active === session) {
        setPathDraft(session.document.path);
      }
      setNotice(noteSessions.current.active === session
        ? message
        : `Couldn’t rename “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
      if (!reportUndo) throw error;
    } finally {
      if (!mutationScope.current.isCurrent(token)) return;
      if (session.mutationController === controller) {
        session.mutationController = undefined;
        session.mutationCancellable = false;
        touchSession(session);
      }
      renameRequest.current = undefined;
    }
  }

  function cancelRename() {
    setRenamePlan(undefined);
    renameRequest.current = undefined;
    const session = noteSessions.current.active;
    if (session) setPathDraft(session.document.path);
  }

  async function saveProperties(path: string, next: Record<string, unknown>) {
    if (mutationScope.current.isFrozen || !canEditNotes) return;
    const token = mutationScope.current.token();
    const session = noteSessions.current.get(path);
    if (!session) return;
    setPropertiesError(undefined);
    try {
      await flushSession(session);
      const source = session.document.document ?? composeRecordSource(session.document.frontmatter, session.document.body ?? "");
      const updated = await runNoteOperation(session, "properties", () => gateway.updateDocument(
        session.document.path,
        replaceDocumentFrontmatter(source, next),
        session.document.revision
      ));
      if (!mutationScope.current.isCurrent(token)) return;
      session.record.accept(updated);
      session.error = undefined;
      touchSession(session);
    } catch (error) {
      if (!mutationScope.current.isCurrent(token)) return;
      const message = gatewayError(error);
      session.error = message;
      setPropertiesError(message);
      setNotice(noteSessions.current.active === session
        ? message
        : `Couldn’t update properties for “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
      throw error;
    }
  }

  async function saveRecordSource(path: string, source: string, previousSource: string): Promise<NoteDocument | false> {
    if (mutationScope.current.isFrozen || !canEditNotes) return false;
    const token = mutationScope.current.token();
    const session = noteSessions.current.get(path);
    if (!session || session.deleted) return false;
    if (noteSessions.current.active === session) setPropertiesError(undefined);
    try {
      await flushSession(session);
      if (!mutationScope.current.isCurrent(token)) return false;
      const currentSource = session.document.document ?? composeRecordSource(session.document.frontmatter, session.document.body ?? "");
      if (currentSource !== previousSource) {
        const message = "This note finished saving after Source was opened. Your source draft is preserved; close and reopen the panel to start from the latest record.";
        if (noteSessions.current.active === session) setPropertiesError(message);
        else setNotice(`Couldn’t update source for “${session.draft.title || session.document.path}”. ${message}`);
        return false;
      }
      const updated = await runNoteOperation(session, "properties", () => gateway.updateDocument(
        session.document.path,
        source,
        session.document.revision
      ));
      if (!mutationScope.current.isCurrent(token)) return false;
      session.record.accept(updated);
      session.error = undefined;
      touchSession(session);
      return updated;
    } catch (error) {
      if (!mutationScope.current.isCurrent(token)) return false;
      const message = gatewayError(error);
      session.error = message;
      if (noteSessions.current.active === session) setPropertiesError(message);
      setNotice(noteSessions.current.active === session
        ? message
        : `Couldn’t update source for “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
      return false;
    }
  }

  async function validateNote() {
    if (mutationScope.current.isFrozen) return;
    const token = mutationScope.current.token();
    const session = noteSessions.current.active;
    if (!session) return;
    setNotice(undefined);
    try {
      await flushSession(session);
      const diagnostics = await runNoteOperation(
        session,
        "validating",
        () => gateway.validate(session.document.path)
      );
      if (mutationScope.current.isCurrent(token) && noteSessions.current.active === session) {
        setNotice(diagnostics.length ? diagnostics.map((item) => item.message).join(" ") : "No validation issues.");
      }
    } catch (error) {
      if (!mutationScope.current.isCurrent(token)) return;
      const message = gatewayError(error);
      setNotice(noteSessions.current.active === session
        ? message
        : `Couldn’t check “${session.draft.title || session.document.path}”. ${message}`);
    }
  }

  async function requestDelete(path = noteSessions.current.active?.document.path) {
    if (!path || batchRunning.current || mutationScope.current.isFrozen || !canDeleteNotes || deleteRequests.current.has(path)) return;
    const token = mutationScope.current.token();
    deleteRequests.current.add(path);
    try {
      const session = await actionSession(path);
      await flushSession(session);
      if (mutationScope.current.isCurrent(token)) await deleteNote(session);
    } catch (error) { if (mutationScope.current.isCurrent(token)) setNotice(`Couldn’t delete “${path}”. ${gatewayError(error)}`); }
    finally { deleteRequests.current.delete(path); }
  }

  async function deleteNote(session: NoteSession, reportUndo = true) {
    if (mutationScope.current.isFrozen) return;
    const token = mutationScope.current.token();
    const path = session.document.path;
    const next = allNotes.find((note) => note.path !== path);
    session.deleted = true;
    indexController.stageRemoval(path);
    forgetNoteHistoryPath(path);
    if (noteSessions.current.active === session) {
      noteSessions.current.deactivate(session);
      setDocument(undefined);
      setDraft(undefined);
      setSelectedPath(undefined);
      if (next) void openNote(next.path);
    }
      try {
        let deletedDocument: NoteDocument | undefined;
        await runNoteOperation(session, "deleting", async (token) => {
          deletedDocument = structuredClone(session.document);
          await gateway.delete(session.document.path, session.document.revision, {
            onProgress: (progress) => {
              if (mutationScope.current.isCurrent(token)) updateMutationActivity(session, progress, touchSession);
            }
          });
        });
        if (!mutationScope.current.isCurrent(token)) return;
        session.record.markDeleted();
        noteSessions.current.delete(path);
        indexController.commitRemoval(path);
        setRecentPaths((current) => forgetRecentPath(current, path));
        if (deletedDocument && reportUndo) setRecoveryAction({ kind: "delete", document: deletedDocument });
        return deletedDocument;
      } catch (error) {
        if (!mutationScope.current.isCurrent(token)) return;
        session.deleted = false;
        indexController.rollbackRemoval(summaryFromDocument(session.document));
        session.error = gatewayError(error);
        setNotice(`Couldn’t delete “${session.draft.title || path}”. ${session.error}`);
        touchSession(session);
        throw error;
      }
  }

  async function undoRecovery() {
    const action = recoveryAction;
    if (!action || recoveryBusy || mutationScope.current.isFrozen) return;
    const token = mutationScope.current.token();
    setRecoveryBusy(true);
    setNotice(undefined);
    try {
      if (action.kind === "batch") {
        const result = await runNoteBatch(action.changes.map((change) => change.document.path), async (path) => {
          if (!mutationScope.current.isCurrent(token)) throw new StaleCollectionOperationError();
          const change = action.changes.find((item) => item.document.path === path)!;
          if (change.kind === "delete") {
            const restored = await mutationScope.current.register(token, gateway.restore(change.document));
            if (!mutationScope.current.isCurrent(token)) throw new StaleCollectionOperationError();
            createSession(restored); indexController.create(summaryFromDocument(restored));
          } else {
            const session = await actionSession(path);
            await flushSession(session);
            const restored = await runNoteOperation(session, "properties", () => gateway.updateDocument(path,
              replaceDocumentFrontmatter(session.document.document ?? composeRecordSource(session.document.frontmatter, session.document.body ?? ""), change.document.frontmatter), change.revision));
            if (!mutationScope.current.isCurrent(token)) throw new StaleCollectionOperationError();
            session.record.accept(restored); session.error = undefined; touchSession(session);
          }
          return path;
        });
        if (!mutationScope.current.isCurrent(token)) return;
        const failed = new Set(result.failed.map((item) => item.path));
        const remaining = action.changes.filter((change) => failed.has(change.document.path));
        setRecoveryAction(remaining.length ? { ...action, changes: remaining, message: batchMessage("Restored", result) } : undefined);
        if (!remaining.length) setNotice("Restored selected notes.", "success");
        return;
      }
      if (action.kind === "mention") {
        const session = await actionSession(action.path);
        await flushSession(session);
        await runNoteOperation(session, "saving", async () => {
          if (session.document.body !== action.after) throw new Error("That note changed after linking. Undo would overwrite its newer text.");
          const restored = await gateway.update(session.document, { body: action.before });
          if (!mutationScope.current.isCurrent(token)) throw new StaleCollectionOperationError();
          session.record.accept(restored);
        });
        if (!mutationScope.current.isCurrent(token)) return;
        touchSession(session);
        setNotice("Restored unlinked mention.", "success");
      } else if (action.kind === "delete") {
        const restored = await mutationScope.current.register(token, gateway.restore(action.document));
        if (!mutationScope.current.isCurrent(token)) return;
        createSession(restored);
        indexController.create(summaryFromDocument(restored));
        setNotice(`Restored “${noteTitle(restored, typeDescriptors)}”.`, "success");
      } else {
        const moves = action.kind === "move" ? [...action.paths] : [action];
        const result = await runNoteBatch([...moves].reverse().map((move) => move.to), async (path) => {
          const move = moves.find((move) => move.to === path)!;
          const session = noteSessions.current.get(move.to);
          if (!session || session.deleted) throw new Error("The renamed note is no longer available to restore.");
          await flushSession(session);
          await refreshCachedNote(move.to);
          if (!mutationScope.current.isCurrent(token)) return;
          const restored = await runNoteOperation(session, "renaming", () => gateway.rename(
            move.to,
            move.from,
            session.document.revision,
            true
          ));
          if (!mutationScope.current.isCurrent(token)) throw new StaleCollectionOperationError();
          session.record.accept(restored);
          session.error = undefined;
          noteSessions.current.move(move.to, move.from, session);
          updateNoteSummary(restored, move.to);
          if (noteSessions.current.active === session) {
            setDocument(restored);
            setSelectedPath(restored.path);
            setPathDraft(restored.path);
            localStorage.setItem("mdbase-editor:last-note", restored.path);
          }
          setRecentPaths((current) => rememberRecentPath(forgetRecentPath(current, move.to), restored.path));
          replaceNoteHistoryPath(move.to, restored.path);
          remapPin(move.to, restored.path);
          touchSession(session);
          return move;
        });
        if (!mutationScope.current.isCurrent(token)) return;
        if (result.failed.length) {
          const failed = new Set(result.failed.map((item) => item.path));
          if (action.kind === "move") setRecoveryAction({ ...action, paths: moves.filter((move) => failed.has(move.to)), message: batchMessage("Restored", result) });
          else setNotice(batchMessage("Restored", result));
          return;
        }
        setNotice("Restored note paths.", "success");
      }
      setRecoveryAction(undefined);
    } catch (error) {
      if (mutationScope.current.isCurrent(token)) setNotice(`Couldn’t undo that change. ${gatewayError(error)}`);
    } finally {
      if (mutationScope.current.isCurrent(token)) setRecoveryBusy(false);
    }
  }

  function clearRenameRequest() { renameRequest.current = undefined; }

  function resetNoteActions() {
    setPropertiesError(undefined);
    setPendingRenameRecovery(undefined);
    setBulkBusy(false);
    setRecoveryAction(undefined);
    setRecoveryBusy(false);
    setLinkingMention(false);
    clearRenameRequest();
    deleteRequests.current.clear();
  }

  return { renameNote, duplicateNote, linkUnlinkedMention, applyBulkProperties, deleteSelectedNotes,
    onMoveNotes, requestRename, performRename, cancelRename, saveProperties, saveRecordSource,
    validateNote, requestDelete, undoRecovery, propertiesError, setPropertiesError, pendingRenameRecovery,
    bulkBusy, recoveryAction, setRecoveryAction, recoveryBusy, setRecoveryBusy, linkingMention,
    clearRenameRequest, resetNoteActions };
}
