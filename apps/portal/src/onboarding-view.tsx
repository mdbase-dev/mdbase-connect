import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { message } from "./portal-model";
import { PageBrand } from "./portal-ui";

interface StarterCollectionResponse {
  status: "pending" | "ready" | "deleted";
  collection_id?: string;
  editor_url?: string | null;
}

export function GettingStarted() {
  const [error, setError] = useState("");
  const requestInFlight = useRef(false);
  const retryTimer = useRef<number | null>(null);

  function prepare() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setError("");
    void api<StarterCollectionResponse>("/v1/onboarding/starter-collection", {
      method: "POST"
    }).then((result) => {
      requestInFlight.current = false;
      if (result.status === "pending") {
        retryTimer.current = window.setTimeout(prepare, 750);
        return;
      }
      if (result.status === "deleted") {
        location.replace("/");
        return;
      }
      location.replace(result.editor_url ?? "/");
    }).catch((reason) => {
      requestInFlight.current = false;
      setError(message(reason));
    });
  }

  useEffect(() => {
    prepare();
    return () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    };
  }, []);

  return (
    <main className="center-page">
      <PageBrand label="connect" />
      <section className="auth-panel onboarding-panel" aria-live="polite">
        <p className="eyebrow">Your first collection</p>
        <h1>Preparing a place to start.</h1>
        <p>We’re creating a small private Markdown collection, then we’ll open it in the editor.</p>
        {!error && <div className="onboarding-progress" aria-hidden="true"><span /></div>}
        {error && <>
          <div className="message error" role="alert">{error}</div>
          <button className="button primary" type="button" onClick={prepare}>Try again</button>
          <a className="quiet-auth-link" href="/">Open mdbase Connect without it</a>
        </>}
      </section>
    </main>
  );
}
