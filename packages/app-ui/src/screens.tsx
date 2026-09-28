import type { JSX, ReactNode } from "react";

import type { MdbaseAppId } from "./apps.js";
import { Wordmark } from "./brand.js";

/**
 * What an app shows while it opens a collection: its wordmark, held still, and a quiet line
 * saying what it is waiting for. A failure keeps the same place and offers a retry.
 */
export function OpeningScreen({ app, title, detail, error, onRetry }: {
  readonly app: MdbaseAppId;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly error?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
}): JSX.Element {
  return <main className="mdbase-opening" data-loading-state={error ? "failed" : "opening"} aria-label={title} aria-busy={!error}>
    <div className="mdbase-opening-message" role={error ? "alert" : "status"}>
      <Wordmark app={app} />
      <div>
        <p>{error ?? title}</p>
        {!error && detail && <small>{detail}</small>}
      </div>
      {error && onRetry && <button type="button" className="mdbase-button" onClick={onRetry}>Try again</button>}
    </div>
  </main>;
}

/**
 * The screen before a collection is open: the app's wordmark, a headline, what the app will
 * do, and the actions (children) for connecting. A status and an error that say the same
 * thing are said once; technical detail waits behind a disclosure.
 */
export function ConnectLayout({ app, title, lead, status, error, detail, footnote, children }: {
  readonly app: MdbaseAppId;
  readonly title: ReactNode;
  readonly lead?: ReactNode | undefined;
  readonly status?: string | null | undefined;
  readonly error?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly footnote?: ReactNode | undefined;
  readonly children?: ReactNode | undefined;
}): JSX.Element {
  return <main className="mdbase-connect-screen">
    <section>
      <Wordmark app={app} />
      <h1>{title}</h1>
      {lead && <p className="mdbase-connect-lead">{lead}</p>}
      {status && status !== error && <p className="mdbase-connect-status" role="status">{status}</p>}
      {children}
      {footnote && <p className="mdbase-connect-footnote">{footnote}</p>}
      {error && <p className="mdbase-connect-error" role="alert">{error}</p>}
      {detail && <details className="mdbase-connect-detail"><summary>Details</summary><code>{detail}</code></details>}
    </section>
  </main>;
}
