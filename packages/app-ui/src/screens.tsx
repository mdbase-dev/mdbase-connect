import { t } from "@lingui/core/macro";
import { useLocaleRevision } from "./i18n.js";
import type { JSX, ReactNode } from "react";

import type { MdbaseAppId } from "./apps.js";
import { MdbaseMark, Wordmark } from "./brand.js";

/**
 * What an app shows while it opens: its mark, scanning, over its name and a quiet line saying
 * what it is waiting for. If the open takes long, a reload hint appears; a failure keeps the
 * same place, turns the mark's highlight red and offers a retry.
 *
 * Apps paint the same markup as static HTML before their bundle runs (see `opening-page.ts`),
 * so the page and this component are one screen. Keep the two in step; a test compares them.
 */
export function OpeningScreen(props: {
  /** A built-in app, or the name (and mark) of an independent collection app. */
  readonly app: MdbaseAppId | { readonly name: string; readonly mark?: ReactNode };
  /** Embedded gates must not add a second main landmark, and keep their own recovery. */
  readonly layout?: "page" | "panel" | undefined;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly error?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
}): JSX.Element {
  useLocaleRevision();
  const { app, title, detail, error, onRetry } = props;
  const page = props.layout !== "panel";
  const Container = page ? "main" : "div";
  return <Container
    className="mdbase-opening"
    data-app={typeof app === "string" ? app : undefined}
    data-loading-state={error ? "failed" : "opening"}
    aria-label={title}
    aria-busy={!error}
  >
    <div className="mdbase-opening-message">
      {typeof app === "string"
        // Editor carries the platform mark; other apps carry their own, as in the wordmark.
        ? <span className="mdbase-opening-mark"><MdbaseMark app={app === "editor" ? undefined : app} motion="scan" /></span>
        : <span className="mdbase-opening-mark mdbase-motion-scan" aria-hidden="true">{app.mark ?? <MdbaseMark />}</span>}
      <span className="mdbase-opening-name">
        {typeof app === "string" ? <>mdbase <strong>{app}</strong></> : app.name}
      </span>
      <div className="mdbase-opening-text">
        <div role="status"><p>{title}</p>{detail && <small>{detail}</small>}</div>
        <p role="alert">{error}</p>
      </div>
      {page && <p className="mdbase-opening-help">
        {t({ message: "Still opening? Check your connection." })} <a href="">{t({ message: "Reload" })}</a>
      </p>}
      {error && onRetry && <button type="button" className="mdbase-button" onClick={onRetry}>{t({ message: "Try again" })}</button>}
    </div>
  </Container>;
}

/**
 * The screen before a collection is open: the app's wordmark, a headline, what the app will
 * do, what went wrong if anything, and then the actions (children) for connecting. A status
 * and an error that say the same thing are said once; technical detail waits behind a
 * disclosure.
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
  useLocaleRevision();
  return <main className="mdbase-connect-screen">
    <section>
      <Wordmark app={app} motion="assemble" />
      <h1>{title}</h1>
      {lead && <p className="mdbase-connect-lead">{lead}</p>}
      {status && status !== error && <p className="mdbase-connect-status" role="status">{status}</p>}
      {error && <p className="mdbase-connect-error" role="alert">{error}</p>}
      {detail && <details className="mdbase-connect-detail"><summary>{t({ message: "Details" })}</summary><code>{detail}</code></details>}
      {children}
      {footnote && <p className="mdbase-connect-footnote">{footnote}</p>}
    </section>
  </main>;
}
