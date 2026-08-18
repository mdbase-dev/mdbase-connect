import { useEffect, useRef, useState } from "react";
import type { ConnectManagementClient } from "@mdbase/connect-management";
import { observeProviderWidth } from "@mdbase/connect-ui/provider-button";

interface GoogleAccountsApi {
  accounts: {
    id: {
      initialize(config: {
        client_id: string;
        nonce: string;
        auto_select: boolean;
        use_fedcm_for_button: boolean;
        callback(response: { credential: string }): void;
      }): void;
      renderButton(element: HTMLElement, config: {
        type: "standard";
        theme: "outline";
        size: "large";
        text: "continue_with";
        shape: "rectangular";
        logo_alignment: "left";
        width: number;
      }): void;
    };
  };
}

let googleLibrary: Promise<GoogleAccountsApi> | null = null;

export function GoogleIdentityButton({ client, purpose, onComplete, onError }: {
  client: ConnectManagementClient;
  purpose: "link" | "reauth_delete";
  onComplete(): void;
  onError(reason: unknown): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState<GoogleAccountsApi | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let active = true;
    async function prepare() {
      try {
        setGoogle(null);
        const start = await client.startGoogleAccountFlow(purpose);
        const loaded = await loadGoogleIdentityServices();
        if (!active) return;
        loaded.accounts.id.initialize({
          client_id: start.client_id,
          nonce: start.nonce,
          auto_select: false,
          use_fedcm_for_button: true,
          callback: ({ credential }) => {
            if (!active) return;
            setBusy(true);
            void client.completeGoogleAccountFlow(credential)
              .then(({ redirect_to: redirectTo }) => {
                location.href = new URL(redirectTo, client.baseUrl).href;
                onComplete();
              })
              .catch((reason) => {
                onError(reason);
                setBusy(false);
                setAttempt((value) => value + 1);
              });
          }
        });
        setGoogle(loaded);
      } catch (reason) {
        if (active) onError(reason);
      }
    }
    void prepare();
    return () => { active = false; };
  }, [attempt, client, onComplete, onError, purpose]);

  useEffect(() => observeProviderWidth(container.current, setWidth), []);

  // Google draws the button itself at a fixed pixel width, so the only way to
  // keep it aligned with the controls around it is to ask for it again.
  useEffect(() => {
    if (!google || !width || !button.current) return;
    button.current.replaceChildren();
    google.accounts.id.renderButton(button.current, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
      logo_alignment: "left",
      width
    });
  }, [google, width]);

  const ready = Boolean(google && width);
  return <div ref={container} className={`connect-google-provider ${busy ? "busy" : ""}`} aria-busy={busy}>
    <div ref={button} className="connect-google-button" />
    {!ready && <span className="connect-provider-loading">Preparing Google sign-in…</span>}
  </div>;
}

function loadGoogleIdentityServices(): Promise<GoogleAccountsApi> {
  const current = (window as unknown as { google?: GoogleAccountsApi }).google;
  if (current?.accounts?.id) return Promise.resolve(current);
  if (googleLibrary) return googleLibrary;
  googleLibrary = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      const loaded = (window as unknown as { google?: GoogleAccountsApi }).google;
      if (loaded?.accounts?.id) resolve(loaded);
      else reject(new Error("Google sign-in did not load correctly."));
    };
    script.onerror = () => reject(new Error("Google sign-in could not be loaded."));
    document.head.append(script);
  });
  return googleLibrary;
}
