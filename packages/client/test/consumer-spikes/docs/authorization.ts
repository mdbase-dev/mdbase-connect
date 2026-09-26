// Mirrors an mdbase.dev SDK documentation example; keep it compiling.
import type { JsonObject, MdbaseApplicationSession, MdbaseConnection, UpdateInput } from "../../../api-candidate/index.js";

declare const session: MdbaseApplicationSession<JsonObject>;
declare const connection: MdbaseConnection<JsonObject>;
declare const input: UpdateInput;
declare function renderProblem(problem: { message: string }): void;
declare function renderApprovalCode(code: string, url: string): void;
declare function renderConnection(details: { collectionId: string; route: string }): void;
declare function renderReconnect(): void;
declare function renderUnavailable(reason: string): void;
declare function renderStatus(status: string): void;
declare function refreshVisibleState(): Promise<void>;

export async function portableAuthorize(): Promise<void> {
  const controller = new AbortController();
  const authorized = await session.authorize("choose", {
    onDeviceCode: ({ userCode, verificationUriComplete }) => {
      renderApprovalCode(userCode, verificationUriComplete);
    },
    signal: controller.signal
  });
  if (!authorized.ok) renderProblem(authorized.problem);
}

export async function stepUp(): Promise<void> {
  const granted = await session.ensureCapabilities(["records.create"]);
  if (!granted.ok) renderProblem(granted.problem);
}

export function listen(): () => void {
  const stop = session.subscribe(() => {
    const snapshot = session.getSnapshot();
    switch (snapshot.status) {
      case "ready":
        renderConnection({ collectionId: snapshot.collectionId, route: snapshot.info.route });
        break;
      case "authorization_required":
        renderReconnect();
        break;
      case "unavailable":
        renderUnavailable(snapshot.reason);
        break;
      default:
        renderStatus(snapshot.status);
    }
  });
  return stop;
}

export async function recover(): Promise<void> {
  const updated = await connection.update(input);
  if (updated.ok) return;
  switch (updated.problem.recovery) {
    case "reauthorize":
      await session.authorize("selected");
      break;
    case "refresh":
      await refreshVisibleState();
      break;
    case "resolve_outcome":
      for (const pending of connection.pendingMutations()) await pending.recover();
      break;
    default:
      renderProblem(updated.problem);
  }
}
