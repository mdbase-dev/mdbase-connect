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

export function pendingNoteToasts(pending: readonly PendingMutationSummary[], renameId: string | undefined, busy: boolean, recover: (id: string) => Promise<void>): ToastItem[] {
  return pending.filter((operation) => operation.requestId !== renameId).map((operation) => ({
    id: `pending-${operation.requestId}`,
    message: `An interrupted ${operation.operation} from ${new Date(operation.createdAt).toLocaleString()} needs exact recovery. No new write will be attempted.`,
    tone: "error", sticky: true, dismissible: false,
    action: { label: `Recover ${operation.operation}`, busy, onAction: () => void recover(operation.requestId) }
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
      await context.refresh(recovered.path);
    }
    if (scope.isCurrent(token)) await context.reload();
  } catch (error) {
    if (scope.isCurrent(token)) context.onError(gatewayError(error));
  } finally {
    if (scope.isCurrent(token)) context.setBusy(false);
  }
}
