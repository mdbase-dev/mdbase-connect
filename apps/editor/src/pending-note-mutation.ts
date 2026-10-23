import { t } from "@lingui/core/macro";
import { i18n } from "@lingui/core";
import { MdbaseConnectError, type PendingMutationSummary } from "@mdbase-dev/connect";
import type { CollectionGateway } from "./model";
import type { NoteSession, NoteSessionStore } from "./note-session";
import type { CollectionMutationScope } from "./collection-mutation-scope";
import type { ToastItem } from "./Toasts";
import { gatewayError } from "./gateway";

export interface RenamePlan {
  session: NoteSession;
  from: string;
  to: string;
  affectedPaths: string[];
  warnings: string[];
}
export interface PendingRenameRecovery {
  plan: RenamePlan;
  updateRefs: boolean;
  requestId: string;
}

export function pendingNoteRequestId(error: unknown): string | undefined {
  return error instanceof MdbaseConnectError && error.problem.code === "operation_outcome_unknown"
    ? error.problem.details.request_id : undefined;
}

function pendingMessage(operation: PendingMutationSummary): string {
  const date = new Date(operation.createdAt).toLocaleString(i18n.locale);
  switch (operation.operation) {
    case "create": return t`Your new note from ${date} isn’t confirmed yet. Check again to finish saving it.`;
    case "rename": return t`Your rename from ${date} isn’t confirmed yet. Check again to finish saving it.`;
    case "delete": return t`Your deletion from ${date} isn’t confirmed yet. Check again to finish saving it.`;
    default: return t`Your change from ${date} isn’t confirmed yet. Check again to finish saving it.`;
  }
}

export function pendingNoteToasts(pending: readonly PendingMutationSummary[], renameId: string | undefined, busy: boolean, recover: (id: string) => Promise<void>): ToastItem[] {
  return pending.filter((operation) => operation.requestId !== renameId).map((operation) => ({
    id: `pending-${operation.requestId}`,
    message: pendingMessage(operation),
    tone: "error", sticky: true, dismissible: false,
    action: { label: t`Check again`, busy, onAction: () => void recover(operation.requestId) }
  }));
}

export async function recoverPendingNoteOperation(requestId: string, context: {
  busy: boolean;
  scope: CollectionMutationScope;
  sessions: NoteSessionStore;
  gateway: CollectionGateway;
  save(session: NoteSession): Promise<void>;
  rename?: PendingRenameRecovery;
  resumeRename(plan: RenamePlan, updateRefs: boolean, requestId: string): Promise<void>;
  refresh(path: string): Promise<void>;
  reload(): Promise<void>;
  setBusy(busy: boolean): void;
  onError(message: string): void;
}): Promise<void> {
  const { scope } = context;
  if (context.busy || scope.isFrozen) return;
  const token = scope.token();
  context.setBusy(true);
  try {
    const saving = [...context.sessions.values()].find((session) => session.pendingRequestId === requestId);
    if (saving) await context.save(saving);
    else if (context.rename?.requestId === requestId) {
      await context.resumeRename(context.rename.plan, context.rename.updateRefs, requestId);
    } else {
      const recovered = await scope.register(token, context.gateway.recoverNoteMutation(requestId));
      if (!scope.isCurrent(token)) return;
      if (recovered) await context.refresh(recovered.path);
    }
    if (scope.isCurrent(token)) await context.reload();
  } catch (error) {
    if (scope.isCurrent(token)) context.onError(gatewayError(error));
  } finally {
    if (scope.isCurrent(token)) context.setBusy(false);
  }
}
