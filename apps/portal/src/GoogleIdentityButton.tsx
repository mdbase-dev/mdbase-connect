import { t } from "@lingui/core/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ConnectManagementClient } from "@mdbase/connect-management";
import { observeProviderWidth } from "@mdbase/connect-ui/provider-button";
import { observeTheme, resolveDarkTheme } from "@mdbase-dev/ui/theme";

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
        theme: "outline" | "filled_black";
        size: "large";
        text: "continue_with";
        locale?: string;
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
  const localeRevision = useLocaleRevision();
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState<GoogleAccountsApi | null>(null);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    async function prepare() {
      try {
        setGoogle(null);
        setFailed(false);
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
                setGoogle(null);
                setBusy(false);
                setAttempt((value) => value + 1);
              });
          }
        });
        setGoogle(loaded);
      } catch (reason) {
        if (active) {
          setFailed(true);
          onError(reason);
        }
      }
    }
    void prepare();
    return () => { active = false; };
  }, [attempt, client, onComplete, onError, purpose]);

  useEffect(() => observeProviderWidth(container.current, setWidth), []);
  const dark = useSyncExternalStore(observeTheme, () => resolveDarkTheme(), () => false);

  // Google draws the button itself at a fixed pixel width and bakes the palette
  // in, so the only way to follow the surrounding chrome is to ask for it again.
  useEffect(() => {
    if (!google || !width || !button.current) return;
    button.current.replaceChildren();
    google.accounts.id.renderButton(button.current, {
      type: "standard",
      theme: dark ? "filled_black" : "outline",
      size: "large",
      text: "continue_with",
      locale: i18n.locale === "pt" ? "pt-BR" : i18n.locale === "zh" ? "zh-CN" : i18n.locale,
      shape: "rectangular",
      logo_alignment: "left",
      width
    });
  }, [dark, google, width, localeRevision]);

  const ready = Boolean(google && width);
  return <div ref={container} className={`connect-google-provider ${busy ? "busy" : ""}`} aria-busy={busy || (!ready && !failed)}>
    <div ref={button} className="connect-google-button" inert={busy || !ready} aria-hidden={busy || !ready} />
    {!ready && <button type="button" className="connect-provider-loading" disabled={!failed}
      onClick={() => setAttempt((value) => value + 1)}>
      {failed ? t(i18n)({ message: "Retry Google sign-in", context: "Connect interface" }) : t(i18n)({ message: "Continue with Google", context: "Connect interface" })}
    </button>}
    <span className="sr-only" role="status">{busy ? t(i18n)({ message: "Signing in with Google…", context: "Connect interface" }) : !ready && !failed ? t(i18n)({ message: "Loading Google sign-in…", context: "Connect interface" }) : ""}</span>
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
      else reject(new Error(t(i18n)({ message: "Google sign-in did not load correctly." })));
    };
    script.onerror = () => reject(new Error(t(i18n)({ message: "Google sign-in could not be loaded." })));
    document.head.append(script);
  });
  googleLibrary = googleLibrary.catch((reason) => {
    googleLibrary = null;
    throw reason;
  });
  return googleLibrary;
}
