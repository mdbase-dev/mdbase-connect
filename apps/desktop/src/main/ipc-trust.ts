// The connector API is for this app's own window only: the exact main frame of
// the owning BrowserWindow, showing the packaged renderer page. Being a file://
// page is not an identity.

export interface SenderLike {
  sender: unknown;
  senderFrame: { url: string } | null | undefined;
}

export interface OwnerLike {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; mainFrame: unknown };
}

function withoutHash(value: string): string {
  const hash = value.indexOf("#");
  return hash === -1 ? value : value.slice(0, hash);
}

export function isTrustedSender(event: SenderLike, owner: OwnerLike | null | undefined, rendererUrl: string): boolean {
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return false;
  const frame = event.senderFrame;
  if (!frame || event.sender !== owner.webContents || frame !== owner.webContents.mainFrame) return false;
  return withoutHash(frame.url) === rendererUrl;
}
