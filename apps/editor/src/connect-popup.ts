import type { AppWebSignInPortal } from "@mdbase-dev/sdk/app-host";

export class ConnectPopupBlocked extends Error {
  constructor() {
    super("Your browser blocked the sign-in tab.");
  }
}

export interface ConnectPopup extends AppWebSignInPortal {
  readonly closed: boolean;
}

/** UI-only capability: callers pass only the SDK-validated Connect URI.
 * Keep the production popup opener so its parent can close it across origins.
 * The tab fallback detaches its opener before navigation. */
export function openConnectPopup(
  name = "mdbase-connect-authorization",
): ConnectPopup {
  let popup: Window | null = null;
  try {
    popup = window.open("", name, "popup,width=620,height=760");
  } catch {
    /* Try a tab. */
  }
  if (!popup) {
    try {
      popup = window.open("", "_blank");
      // A literal noopener feature returns no usable blank handle. Detach
      // immediately instead, before the SDK supplies the navigation URI.
      if (popup) popup.opener = null;
    } catch {
      try {
        popup?.close();
      } catch {
        /* Display cleanup only. */
      }
      popup = null;
    }
  }
  if (!popup) throw new ConnectPopupBlocked();
  const original = popup;
  let closed = false;
  return {
    get closed() {
      return closed || original.closed;
    },
    navigate(uri) {
      if (closed || original.closed) throw new Error("Sign-in window closed.");
      original.location.href = uri;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        original.close();
      } catch {
        /* Display cleanup does not undo approval. */
      }
    },
  };
}
