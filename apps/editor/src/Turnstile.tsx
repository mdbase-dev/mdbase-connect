import { useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render(container: HTMLElement, options: {
    sitekey: string;
    callback(token: string): void;
    "expired-callback"(): void;
    "error-callback"(): void;
    action: "feedback";
    theme: "auto";
  }): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScript: Promise<void> | undefined;

export function Turnstile({ siteKey, onToken }: { siteKey: string; onToken(token: string): void }) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  const [error, setError] = useState("");
  callback.current = onToken;

  useEffect(() => {
    let active = true;
    let widgetId: string | undefined;
    void loadTurnstile().then(() => {
      if (!active || !container.current || !window.turnstile) return;
      widgetId = window.turnstile.render(container.current, {
        sitekey: siteKey,
        callback: (token) => { setError(""); callback.current(token); },
        "expired-callback": () => callback.current(""),
        "error-callback": () => { callback.current(""); setError("Verification could not be completed. Try again."); },
        action: "feedback",
        theme: "auto"
      });
    }).catch(() => {
      if (active) setError("Verification could not be loaded. Check your connection and try again.");
    });
    return () => {
      active = false;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey]);

  return <div className="connect-feedback-turnstile">
    <div ref={container} />
    {error && <p role="alert">{error}</p>}
  </div>;
}

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScript) return turnstileScript;
  turnstileScript = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-mdbase-turnstile="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Turnstile failed to load")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.mdbaseTurnstile = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile failed to load")), { once: true });
    document.head.append(script);
  });
  return turnstileScript;
}
