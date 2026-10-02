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

export function FeedbackVerification({ siteKey, onToken }: { siteKey: string; onToken(token: string): void }) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  callback.current = onToken;

  useEffect(() => {
    callback.current(""); setError("");
    let active = true;
    let widgetId: string | undefined;
    void loadTurnstile().then(() => {
      if (!active || !container.current || !window.turnstile) return;
      widgetId = window.turnstile.render(container.current, {
        sitekey: siteKey,
        callback: (token) => { if (active) { setError(""); callback.current(token); } },
        "expired-callback": () => { if (active) callback.current(""); },
        "error-callback": () => { if (active) { callback.current(""); setError("Verification could not be completed. Try again."); } },
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
  }, [siteKey, attempt]);

  return <div className="mdbase-feedback-verification">
    <div ref={container} />
    {error && <><p className="mdbase-feedback-error" role="alert">{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry verification</button></>}
  </div>;
}

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScript) return turnstileScript;
  turnstileScript = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-mdbase-turnstile="true"]');
    const script = existing ?? document.createElement("script");
    const cleanup = () => { clearTimeout(timer); script.removeEventListener("load", loaded); script.removeEventListener("error", failed); };
    const loaded = () => { cleanup(); if (window.turnstile) resolve(); else reject(new Error("Turnstile API unavailable")); };
    const failed = () => { cleanup(); reject(new Error("Turnstile failed to load")); };
    const timer = setTimeout(failed, 15_000);
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true; script.defer = true; script.dataset.mdbaseTurnstile = "true";
      document.head.append(script);
    }
  });
  turnstileScript = turnstileScript.catch((error: unknown) => {
    document.querySelector('script[data-mdbase-turnstile="true"]')?.remove();
    turnstileScript = undefined;
    throw error;
  });
  return turnstileScript;
}
